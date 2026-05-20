import subprocess
import json
import random
import os
import csv


meta_file = "./data/meta.csv"
save_dir = "./data"

os.makedirs(os.path.join(save_dir, "music"), exist_ok=True)
os.makedirs(os.path.join(save_dir, "json"), exist_ok=True)
os.makedirs(os.path.join(save_dir, "temp"), exist_ok=True)

metas = []
meta_file = os.path.join(save_dir, "meta.csv")
with open(meta_file, "r") as f:
    reader = csv.reader(f)
    for row in reader:
        metas.append(row)
    
meta_head = metas.pop(0)

for data_idx, url, keyword, start, duration in metas:
    temp_file = os.path.join(save_dir,"temp",str(data_idx))
        
    start = float(start)
    duration = float(duration)
    
    p = subprocess.run([
        "yt-dlp",
        url,
        "--download-sections", f"*{start}-{start+duration}",
        "-x",
        "--audio-format", "mp3",
        "-o", temp_file # 临时保存位置
        ],
        capture_output=True,
        text=True,
    )

    print("STDOUT:")
    print(p.stdout)

    print("STDERR:")
    print(p.stderr)

    temp_file_mp3 = temp_file + '.mp3'
    mp3_file = os.path.join(save_dir, "music", str(data_idx)+".mp3")
    # 把 temp_file_mp3 从0开始截取 duration 秒，保存到 mp3_file
    subprocess.run([
        "ffmpeg",
        "-y",
        "-i", temp_file_mp3,
        "-ss", "0",
        "-t", str(duration),
        mp3_file
    ], check=True)
    
    # 从 temp 删除 
    os.remove(temp_file + ".mp3")
