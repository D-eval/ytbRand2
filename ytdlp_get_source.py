import subprocess
import json
import random
import csv

num_url = 100
# search_keyword = [
#     "music",
#     "pop song",
#     "piano instrumental",
#     "lofi beat",
#     "edm",
#     "jazz",
#     "rock song",
#     "orchestra",
#     "hip hop",
#     "rnb",
#     "mameyudoufu",
#     "sakuzyo",
#     "Au5",
# ]

# search_keyword = [
#     "djmax",
#     "deemo",
# ]

search_keyword = []

url_title_duration = []
for keyword in search_keyword:
    p = subprocess.run(["yt-dlp",f"ytsearch{num_url}:{keyword}","--flat-playlist","-J"], capture_output=True, text=True)
    data = json.loads(p.stdout)
    for entry in data['entries']:
        url = entry['url']
        title = entry['title']
        duration = entry.get('duration')
        url_title_duration.append((url, title, duration, keyword))
    print(f"{keyword}:",len(data['entries']))

# 保存csv

with open("source.csv", "a", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    # writer.writerow([
    #     "url",
    #     "title",
    #     "duration",
    #     "keyword"
    # ]) # 'w' 模式下写这个
    writer.writerows(url_title_duration)
