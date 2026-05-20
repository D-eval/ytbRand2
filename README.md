# dataset_chord_from_youtube

这个项目是从source.csv里随机下载音频片段，然后标注和弦数据的

1、首先把下载0.5s音频改成10s音频
2、加入播放头，可以拖拽，选择播放时间，按 space 播放暂停
3、加入分割线，分割线得到若干个区间，每个音符横跨区间，储存json格式

{
    [{
        start: 0.3,
        midi: [3, 4, ...]
    },
    {
        start: 0.7,
        midi: [],
    }]
}# ytbRand2
