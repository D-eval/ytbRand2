import os
import json
import librosa
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader

current_file = os.path.abspath(__file__)
current_dir = os.path.dirname(current_file)

data_dir = os.path.join(current_dir, "data")
duration = 10.0
sr = 44100


class ChordTransDataset(Dataset):
    # 3秒样本：先切片，再标注该片段内和弦切换时间（相对片段起点）
    def __init__(self, sr, min_midi, max_midi, clip_duration=3.0, shift_min=-7, shift_max=7):
        super().__init__()
        self.sr = sr
        self.min_midi = min_midi
        self.max_midi = max_midi
        self.clip_duration = float(clip_duration)
        self.clip_len = int(round(self.clip_duration * self.sr))
        self.shifts = list(range(int(shift_min), int(shift_max) + 1))
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

            segments = labels.get("segments", [])
            if not isinstance(segments, list):
                segments = []

            starts = []
            for seg in segments:
                if not isinstance(seg, dict):
                    continue
                try:
                    start = float(seg.get("start", 0.0))
                except Exception:
                    continue
                if start >= 0.0:
                    starts.append(start)
            starts = sorted(set(starts))

            audio, _ = librosa.load(audio_filename, mono=False, sr=self.sr)
            if audio.ndim == 1:
                audio = np.expand_dims(audio, axis=0)
            audio = np.ascontiguousarray(audio, dtype=np.float32)

            total_len = audio.shape[1]
            if total_len == 0:
                continue

            n_clips = int(np.ceil(total_len / self.clip_len))
            for i in range(n_clips):
                clip_start_sec = i * self.clip_duration
                clip_end_sec = clip_start_sec + self.clip_duration

                trans_in_clip = [
                    float(s - clip_start_sec)
                    for s in starts
                    if clip_start_sec <= s < clip_end_sec
                ]

                s_idx = i * self.clip_len
                e_idx = s_idx + self.clip_len
                clip_audio = audio[:, s_idx:e_idx]
                if clip_audio.shape[1] < self.clip_len:
                    pad = self.clip_len - clip_audio.shape[1]
                    clip_audio = np.pad(
                        clip_audio,
                        ((0, 0), (0, pad)),
                        mode="constant",
                        constant_values=0.0,
                    )

                for shift in self.shifts:
                    self.samples.append(
                        {
                            "idx": idx,
                            "audio": clip_audio,
                            "start": trans_in_clip,
                            "shift": shift,
                        }
                    )

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        sample = self.samples[idx]
        shift = int(sample["shift"])
        audio_np = sample["audio"]
        if shift != 0:
            shifted = [
                librosa.effects.pitch_shift(ch, sr=self.sr, n_steps=shift)
                for ch in audio_np
            ]
            audio_np = np.stack(shifted, axis=0).astype(np.float32, copy=False)
        audio = torch.from_numpy(audio_np.T).float()
        target = {"start": torch.tensor(sample["start"], dtype=torch.float32)}
        return audio, target


def collate_fn(batch):
    audios = []
    targets = []
    for audio, target in batch:
        audios.append(audio)
        targets.append(target)
    audios = torch.stack(audios, dim=0)
    return audios, targets


if __name__ == "__main__":
    dataset = ChordTransDataset(sr=sr, min_midi=24, max_midi=107)
    loader = DataLoader(dataset, 2, shuffle=True, collate_fn=collate_fn, num_workers=0)
    for audio, target in loader:
        print(audio.shape, target[0]["start"])
        #break 
