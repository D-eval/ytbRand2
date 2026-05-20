#!/usr/bin/env python3
import base64
import csv
import json
import os
import random
import shutil
import subprocess
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8765
CLIP_SEC = 10.0
SOURCE_FILE = "./source.csv"

SOURCE_ITEMS = []
SESSION = {
    "save_dir": None,
    "next_index": 1,
    "current": None,
    "temp_dir": None,
}


def run_cmd_yt_dlp(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "yt-dlp 下载失败").strip())
    return (p.stdout or "").strip()


def run_cmd(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "命令执行失败").strip())
    return (p.stdout or "").strip()


def load_source_items(source_file: str):
    path = Path(source_file)
    if not path.exists():
        raise RuntimeError(f"source 文件不存在: {source_file}")
    items = []
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            url = str(row.get("url") or "").strip()
            keyword = str(row.get("keyword") or "").strip()
            try:
                duration = float(row.get("duration") or 0)
            except Exception:
                duration = 0.0
            if not url or duration <= CLIP_SEC:
                continue
            items.append({"url": url, "keyword": keyword, "duration": duration})
    if not items:
        raise RuntimeError(f"source 中没有可用数据: {source_file}")
    return items


def ensure_dirs(save_dir: Path):
    os.makedirs(save_dir / "music", exist_ok=True)
    os.makedirs(save_dir / "json", exist_ok=True)
    os.makedirs(save_dir / "temp", exist_ok=True)


def parse_next_index(save_dir: Path) -> int:
    meta_csv = save_dir / "meta.csv"
    max_idx = 0
    if meta_csv.exists():
        last_idx = None
        with meta_csv.open("r", encoding="utf-8", newline="") as f:
            reader = csv.reader(f)
            rows = list(reader)
        # 优先按 meta 最后一条确定下一编号，避免首次保存覆盖历史标注
        for row in reversed(rows[1:]):
            if not row:
                continue
            try:
                last_idx = int((row[0] or "").strip())
                break
            except Exception:
                continue
        if last_idx is not None:
            return last_idx + 1
    for p in (save_dir / "music").glob("*.mp3"):
        if p.stem.isdigit():
            max_idx = max(max_idx, int(p.stem))
    for p in (save_dir / "json").glob("*.json"):
        if p.stem.isdigit():
            max_idx = max(max_idx, int(p.stem))
    return max_idx + 1


def append_meta(save_dir: Path, idx: int, item: dict):
    meta = save_dir / "meta.csv"
    need_header = not meta.exists() or meta.stat().st_size == 0
    with meta.open("a", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        if need_header:
            writer.writerow(["index", "url", "keyword", "start", "duration"])
        writer.writerow([
            idx,
            item.get("url", ""),
            item.get("keyword", ""),
            f"{float(item.get('start', 0)):.6f}",
            f"{float(item.get('duration', 0)):.3f}",
        ])


def cleanup_file(path_str: str):
    if not path_str:
        return
    p = Path(path_str)
    if p.exists() and p.is_file():
        p.unlink()


def cleanup_sample(sample: dict):
    if not isinstance(sample, dict):
        return
    cleanup_file(sample.get("clip_path", ""))


def random_source_item():
    if not SOURCE_ITEMS:
        raise RuntimeError("source 数据为空，请检查 source.csv")
    return random.choice(SOURCE_ITEMS)


def generate_sample(temp_dir: Path):
    item = random_source_item()
    url = item["url"]
    keyword = item.get("keyword", "")
    duration = float(item["duration"])
    start = random.random() * max(0.0, duration - CLIP_SEC)
    end = start + CLIP_SEC
    token = uuid.uuid4().hex[:12]
    temp_file = temp_dir / f"clip_{token}"

    out = run_cmd_yt_dlp([
        "yt-dlp",
        url,
        "--download-sections", f"*{start:.6f}-{end:.6f}",
        "-x",
        "--audio-format", "mp3",
        "-o", str(temp_file),
        "--print", "after_move:filepath",
        "--no-mtime",
        "--js-runtimes", "deno,node",
    ])

    printed = [Path(line.strip()) for line in out.splitlines() if line.strip()]
    cands = [p for p in printed if p.exists() and p.is_file()]
    if not cands:
        cands = sorted(temp_dir.glob(f"clip_{token}*.mp3"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not cands:
        cands = sorted(temp_dir.glob(f"clip_{token}*.*"), key=lambda p: p.stat().st_mtime, reverse=True)

    clip_path = cands[0] if cands else None
    if not clip_path or not clip_path.exists():
        raise RuntimeError("下载失败：音频文件不存在")

    exact_clip_path = temp_dir / f"clip_{token}_exact.mp3"
    run_cmd([
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-i",
        str(clip_path),
        "-ss",
        "0",
        "-t",
        f"{CLIP_SEC}",
        "-vn",
        "-acodec",
        "libmp3lame",
        "-q:a",
        "2",
        str(exact_clip_path),
    ])
    cleanup_file(str(clip_path))
    clip_path = exact_clip_path
    b64 = base64.b64encode(clip_path.read_bytes()).decode("ascii")
    return {
        "url": url,
        "keyword": keyword,
        "start": start,
        "duration": CLIP_SEC,
        "clip_path": str(clip_path),
        "audio_b64": b64,
    }


def fetch_next_sample_with_retry(temp_dir: Path, retries: int = 4):
    last_err = None
    for _ in range(retries):
        try:
            return generate_sample(temp_dir)
        except Exception as e:
            last_err = e
    raise RuntimeError(str(last_err) if last_err else "生成样本失败")


def serialize_sample(sample: dict, index: int):
    out = dict(sample)
    out["index"] = index
    out.pop("clip_path", None)
    return out


def start_session(save_dir: str):
    root = Path(save_dir).expanduser().resolve()
    ensure_dirs(root)

    cleanup_sample(SESSION.get("current"))
    old_temp = SESSION.get("temp_dir")
    if old_temp:
        shutil.rmtree(old_temp, ignore_errors=True)

    session_temp_dir = root / "temp" / f"session_{uuid.uuid4().hex[:8]}"
    os.makedirs(session_temp_dir, exist_ok=True)

    SESSION["save_dir"] = str(root)
    SESSION["next_index"] = parse_next_index(root)
    SESSION["temp_dir"] = str(session_temp_dir)
    SESSION["current"] = fetch_next_sample_with_retry(session_temp_dir)


def next_sample():
    if not SESSION.get("save_dir"):
        raise RuntimeError("请先调用 /start")
    prev = SESSION.get("current")
    temp_dir = Path(SESSION["temp_dir"])
    SESSION["current"] = fetch_next_sample_with_retry(temp_dir)
    cleanup_sample(prev)


def save_current(payload: dict):
    cur = SESSION.get("current")
    if not cur:
        raise RuntimeError("当前没有待保存样本")

    idx = SESSION["next_index"]
    root = Path(SESSION["save_dir"])
    ensure_dirs(root)

    music_path = root / "music" / f"{idx}.mp3"
    json_path = root / "json" / f"{idx}.json"
    shutil.copyfile(cur["clip_path"], music_path)

    text = str(payload.get("text") or "")
    midi = payload.get("midi")
    segments = payload.get("segments")
    if not isinstance(midi, list):
        midi = []
    midi = [int(x) for x in midi if isinstance(x, (int, float))]
    if not isinstance(segments, list):
        segments = [{"start": 0.0, "midi": midi}]
    norm_segments = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        start = seg.get("start", 0.0)
        seg_midis = seg.get("midi", [])
        try:
            start = float(start)
        except Exception:
            start = 0.0
        if not isinstance(seg_midis, list):
            seg_midis = []
        seg_midis = sorted(set(int(x) for x in seg_midis if isinstance(x, (int, float))))
        norm_segments.append({"start": round(max(0.0, start), 3), "midi": seg_midis})
    norm_segments.sort(key=lambda x: x["start"])
    if not norm_segments:
        norm_segments = [{"start": 0.0, "midi": []}]

    json_path.write_text(json.dumps({"text": text, "midi": midi, "segments": norm_segments}, ensure_ascii=False), encoding="utf-8")
    append_meta(root, idx, cur)
    SESSION["next_index"] += 1
    return idx


class Handler(BaseHTTPRequestHandler):
    def _set_headers(self, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json(self):
        n = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(n) if n > 0 else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        self._set_headers(200)
        self.wfile.write(b"{}")

    def do_POST(self):
        try:
            payload = self._json()
            if self.path == "/start":
                save_dir = str(payload.get("save_dir") or "").strip()
                if not save_dir:
                    raise RuntimeError("save_dir 不能为空")
                start_session(save_dir)
                sample = serialize_sample(SESSION["current"], SESSION["next_index"])
                self._set_headers(200)
                self.wfile.write(json.dumps({"ok": True, "sample": sample}, ensure_ascii=False).encode("utf-8"))
                return

            if self.path == "/save_and_next":
                saved_idx = save_current(payload)
                next_sample()
                sample = serialize_sample(SESSION["current"], SESSION["next_index"])
                self._set_headers(200)
                self.wfile.write(json.dumps({"ok": True, "saved_index": saved_idx, "sample": sample}, ensure_ascii=False).encode("utf-8"))
                return

            if self.path == "/skip_and_next":
                next_sample()
                sample = serialize_sample(SESSION["current"], SESSION["next_index"])
                self._set_headers(200)
                self.wfile.write(json.dumps({"ok": True, "sample": sample}, ensure_ascii=False).encode("utf-8"))
                return

            if self.path == "/status":
                started = bool(SESSION.get("save_dir"))
                self._set_headers(200)
                self.wfile.write(json.dumps({"ok": True, "started": started}, ensure_ascii=False).encode("utf-8"))
                return

            self._set_headers(404)
            self.wfile.write(json.dumps({"ok": False, "error": "not found"}).encode("utf-8"))
        except Exception as e:
            traceback.print_exc()
            self._set_headers(500)
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False).encode("utf-8"))


def main():
    global SOURCE_ITEMS
    SOURCE_ITEMS = load_source_items(SOURCE_FILE)
    print(f"loaded source items: {len(SOURCE_ITEMS)} from {SOURCE_FILE}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"random annotator server running at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
