import csv
import os
import json
import librosa
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader

import random

def sim_noise_label(
    midis,
    p_fifth=0.10,
    p_octave=0.15,
    p_add=0.10,
    p_remove=0.10,
):
    """
    模拟 AMT noisy label
    
    错误类型:
    1. 五度泛音混淆
    2. 八度混淆
    3. 多标音符
    4. 漏标音符
    """

    midis = list(midis)

    if len(midis) == 0:
        return midis

    # ===== 五度泛音 =====
    if random.random() < p_fifth:
        m = random.choice(midis)

        # 更像泛音误判：增加，而不是替换
        shift = random.choice([7, -7])
        m2 = m + shift

        if 24 <= m2 <= 107:
            midis.append(m2)

    # ===== 八度混淆 =====
    if random.random() < p_octave:
        idx = random.randrange(len(midis))

        shift = random.choice([12, -12])
        m2 = midis[idx] + shift

        if 24 <= m2 <= 107:
            midis[idx] = m2

    # ===== 漏标 =====
    if random.random() < p_remove:
        if len(midis) > 1:
            idx = random.randrange(len(midis))
            midis.pop(idx)

    # ===== 多标 =====
    if random.random() < p_add:
        m = random.choice(midis)

        candidate = []
        for shift in [-12, -7, 7, 12]:
            m2 = m + shift
            if 24 <= m2 <= 107:
                candidate.append(m2)

        if len(candidate) > 0:
            midis.append(random.choice(candidate))

    # 去重排序
    midis = sorted(list(set(midis)))

    return midis


current_file = os.path.abspath(__file__)
current_dir = os.path.dirname(current_file)

data_dir = os.path.join(current_dir, "data")
duration = 10.0
sr = 44100
segment_duration = 0.5


PITCHNAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
CHORDNAMES = ["maj", "min", "dom", "dim", "aug", "N"]
duration_len = int(duration * sr)

class StackDataset(Dataset):
    def __init__(self, sr, min_midi, max_midi):
        super().__init__()
        self.sr = sr
        self.min_midi = min_midi
        self.max_midi = max_midi
        self.P = max_midi - min_midi + 1
        self.segment_len = int(segment_duration * sr)
        self.samples = []

        json_dir = os.path.join(data_dir, "json")
        for name in sorted(os.listdir(json_dir)):
            if not name.endswith(".json"):
                continue
            idx = os.path.splitext(name)[0]
            json_filename = os.path.join(json_dir, name)
            audio_filename = os.path.join(data_dir, "music", f"{idx}.mp3")
            if not os.path.exists(audio_filename):
                continue

            with open(json_filename, "r", encoding="utf-8") as f:
                labels = json.load(f)

            if str(labels.get("text", "")).strip() != "C":
                continue

            segments = labels.get("segments", [])
            if not isinstance(segments, list):
                continue

            for seg_idx, seg in enumerate(segments):
                if not isinstance(seg, dict):
                    continue
                raw_midis = seg.get("midi", [])
                if not isinstance(raw_midis, list):
                    continue
                midis = sorted(
                    set(
                        int(m) for m in raw_midis
                        if isinstance(m, (int, float)) and self.min_midi <= int(m) <= self.max_midi
                    )
                )
                if len(midis) == 0:
                    continue
                try:
                    start = float(seg.get("start", 0.0))
                except Exception:
                    start = 0.0
                start = max(0.0, start)
                if seg_idx + 1 < len(segments) and isinstance(segments[seg_idx + 1], dict):
                    try:
                        end = float(segments[seg_idx + 1].get("start", duration))
                    except Exception:
                        end = duration
                else:
                    end = duration
                end = max(start, min(duration, end))

                chunk_starts = []
                t = start
                while t < end:
                    chunk_starts.append(t)
                    t += segment_duration
                if len(chunk_starts) == 0:
                    chunk_starts = [start]

                for chunk_start in chunk_starts:
                    for shift in range(-7, 7):
                        self.samples.append(
                            {
                                "idx": idx,
                                "audio_filename": audio_filename,
                                "start": chunk_start,
                                "midi": midis,
                                "shift": shift,
                            }
                        )

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        sample = self.samples[idx]
        audio_filename = sample["audio_filename"]
        start = sample["start"]
        shift = sample["shift"]
        raw_midis = sample["midi"]

        audio, _ = librosa.load(audio_filename, mono=False, sr=self.sr)
        if audio.ndim == 1:
            audio = np.expand_dims(audio, axis=0)  # (C,T)

        start_idx = int(round(start * self.sr))
        end_idx = start_idx + self.segment_len
        audio_seg = audio[:, start_idx:end_idx]
        if audio_seg.shape[1] < self.segment_len:
            pad = self.segment_len - audio_seg.shape[1]
            audio_seg = np.pad(audio_seg, ((0, 0), (0, pad)), mode="constant", constant_values=0.0)
        else:
            audio_seg = audio_seg[:, :self.segment_len]

        audio_shift = []
        for ch in audio_seg:
            ch_shift = librosa.effects.pitch_shift(
                ch,
                sr=self.sr,
                n_steps=shift
            )
            audio_shift.append(ch_shift)
        audio_seg = np.stack(audio_shift, axis=0)

        midis = []
        for m in raw_midis:
            m2 = m + shift
            if self.min_midi <= m2 <= self.max_midi:
                midis.append(m2)
        midis = sorted(set(midis))
        if len(midis) == 0:
            # 极少数情况下变调后越界，退回未变调 midis，确保标签非空
            midis = list(raw_midis)

        midi_manyhot = torch.zeros(self.P)
        pitch_vec = torch.zeros((12))
        pitch_cls = []
        for m in midis:
            midi_manyhot[m - self.min_midi] = 1
            p = m % 12
            pitch_vec[p] = 1
            if p not in pitch_cls:
                pitch_cls.append(p)

        target = {
            "symbol": "C",
            "index": sample["idx"],
            "start": torch.tensor([start]).float(),
            "shift": torch.tensor([shift]).long(),
            "midi": midis,
            "midi_manyhot": midi_manyhot,
            "pitch_cls": pitch_cls,
            "pitch_vec": pitch_vec,
            "exist": torch.tensor([1.0]).float(),
        }

        audio = torch.tensor(audio_seg.T).float()  # (T,C)
        return audio, target


def collate_fn(batch):
    audios = []
    targets = []

    for audio, target in batch:
        audios.append(audio)
        targets.append(target)

    audios = torch.stack(audios, dim=0)  # (B,T,C)
    return audios, targets

if __name__ == "__main__":
    dataset = StackDataset(sr=sr, min_midi=24, max_midi=107)
    loader = DataLoader(dataset, 2, shuffle=True, collate_fn=collate_fn, num_workers=0)
    for batch in loader:
        audio, target = batch
        print(audio.shape)
        print(target[0]['symbol'], target[0]['start'], target[0]['midi'])
