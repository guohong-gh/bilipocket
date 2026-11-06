// @ts-check
// 仅用于浏览器演示入口（/dev/），不随安装包分发。
import {
  DEFAULT_SETTINGS,
  availableDanmakuTypes,
  qualityMeta,
  selectedDanmakuCount,
} from "/js/catalog.js";

export const SAMPLE_VIDEOS = [
  {
    key: "sunset",
    bvid: "BV1xx411c7mD",
    title: "在海边等到一场落日｜4K 治愈短片",
    up: "阿树不熬夜",
    avatarLetter: "树",
    views: "128.6 万",
    danmaku: "2.1 万",
    published: "2026-09-18",
    duration: "08:42",
    intro:
      "那天风很大，海浪把光揉成碎片。我用一台旧相机，记录下这个夏天最后一场落日。没有旁白，只有海风。",
    cover: "/dev/assets/covers/cover-sunset.svg",
    sizes: { "4K": 1460.8, "1080P60": 620.5, "1080P": 342.1, "720P": 186.4, "480P": 92.7, "360P": 54.8, audio: 48.3 },
    danmakuTypeCounts: { scroll: 16800, top: 1260, bottom: 1890, reverse: 630, advanced: 420 },
    subtitles: ["zh-auto", "en"],
  },
  {
    key: "night",
    bvid: "BV1Nt4y1m7Wa",
    title: "凌晨两点的城市漫游｜霓虹、雨和便利店",
    up: "观测者小野",
    avatarLetter: "野",
    views: "76.3 万",
    danmaku: "9842",
    published: "2026-10-02",
    duration: "12:35",
    intro:
      "雨夜的城市像一块通电的电路板。我们从末班地铁出发，沿着没有人的街道，一直走到天亮。",
    cover: "/dev/assets/covers/cover-night.svg",
    sizes: { "1080P+": 498.7, "1080P60": 612.4, "1080P": 421.6, "720P": 218.9, "480P": 108.2, "360P": 62.5, audio: 56.1 },
    danmakuTypeCounts: { scroll: 7600, top: 842, bottom: 1100, reverse: 200, advanced: 100 },
    subtitles: ["zh-auto"],
  },
  {
    key: "forest",
    bvid: "BV1Qe411v7Kp",
    title: "去山里住了三天，治好了我的精神内耗",
    up: "野生小满",
    avatarLetter: "满",
    views: "214.9 万",
    danmaku: "3.7 万",
    published: "2026-08-22",
    duration: "15:08",
    intro:
      "没有信号，没有闹钟，只有溪水、鸟叫和一场突如其来的山雨。这三天里，我重新学会了慢慢走路。",
    cover: "/dev/assets/covers/cover-forest.svg",
    sizes: { "8K": 3986.2, "4K": 1986.2, "1080P": 508.3, "720P": 264.7, "480P": 128.4, "360P": 71.9, audio: 61.7 },
    danmakuTypeCounts: { scroll: 30000, top: 2500, bottom: 3000, reverse: 900, advanced: 600 },
    subtitles: [],
  },
  {
    key: "cafe",
    bvid: "BV1jz4y1k7Em",
    title: "雨天的便利店，和一杯等到凉掉的咖啡",
    up: "半糖去冰",
    avatarLetter: "糖",
    views: "42.8 万",
    danmaku: "5217",
    published: "2026-09-29",
    duration: "06:20",
    intro:
      "便利店的暖光像一间临时避难所。雨没有停，我坐在窗边，看每个人的伞从玻璃外面经过。",
    cover: "/dev/assets/covers/cover-cafe.svg",
    sizes: { "1080P": 286.4, "720P": 154.8, "480P": 78.6, "360P": 45.2, audio: 41.2 },
    danmakuTypeCounts: { scroll: 4000, top: 517, bottom: 500, reverse: 120, advanced: 80 },
    subtitles: ["zh-auto"],
    // 故意同时给分 P 与合集，用来演示「两种批量来源互斥」。
    pages: [
      { index: 1, cid: 900001, title: "上集：雨还在下", durationSeconds: 380 },
      { index: 2, cid: 900002, title: "下集：咖啡凉了", durationSeconds: 400 },
    ],
    // 浏览器演示用的合集样本；真实合集由 B 站 view 接口的 ugc_season 提供。
    // 只有这一条样本带 season，避免其他用例被列表拖慢。
    season: {
      id: 90210,
      title: "便利店的深夜合集",
      episodes: [
        { bvid: "BV1cafe00001", title: "第一集：雨天的便利店", section: "正片", durationSeconds: 600 },
        { bvid: "BV1cafe00002", title: "第二集：霓虹与雨", section: "正片", durationSeconds: 720 },
        { bvid: "BV1cafe00003", title: "第三集：末班地铁", section: "正片", durationSeconds: 540 },
        { bvid: "BV1cafe00004", title: "第四集：便利店的关东煮", section: "花絮", durationSeconds: 330 },
        { bvid: "BV1cafe00005", title: "第五集：便利店的猫", section: "花絮", durationSeconds: 285 },
        { bvid: "BV1cafe00006", title: "第六集：天亮之前", section: "花絮", durationSeconds: 660 },
      ],
    },
  },
  {
    key: "bigseason",
    bvid: "BV1pAgE411v7",
    title: "大型合集：250 集分页演示",
    up: "合集成瘾者",
    avatarLetter: "合",
    views: "18.2 万",
    danmaku: "3120",
    published: "2026-07-11",
    duration: "05:00",
    intro: "用于验证合集列表的分批渲染：默认只渲染前 200 条，其余通过「继续显示」追加。",
    cover: "/dev/assets/covers/cover-cafe.svg",
    sizes: { "1080P": 286.4, "720P": 154.8, "480P": 78.6, "360P": 45.2, audio: 41.2 },
    danmakuTypeCounts: { scroll: 2400, top: 300, bottom: 320, reverse: 60, advanced: 40 },
    subtitles: ["zh-auto"],
    // 250 条只为覆盖「超出一次渲染上限」的分支，不承载真实内容。
    season: {
      id: 90211,
      title: "大型合集（分页演示）",
      episodes: Array.from({ length: 250 }, (_, index) => ({
        bvid: `BV1ep${String(index + 1).padStart(7, "0")}`,
        title: `第 ${index + 1} 集：分页演示条目`,
        section: "演示",
        durationSeconds: 300,
      })),
    },
  },
];

export function getSampleByInput(input) {
  const text = String(input).trim();

  const directMatch = SAMPLE_VIDEOS.find((sample) => text.includes(sample.bvid));
  if (directMatch) return { ...directMatch };

  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  const sample = SAMPLE_VIDEOS[hash % SAMPLE_VIDEOS.length];
  const bvidMatch = text.match(/BV[1-9A-HJ-NP-Za-km-z]{10}/);
  return {
    ...sample,
    bvid: bvidMatch ? bvidMatch[0] : sample.bvid,
  };
}

function seedSelection(
  sample,
  danmakuTypeIds = availableDanmakuTypes(sample.danmakuTypeCounts).map((type) => type.id),
  subtitleIds = sample.subtitles || [],
) {
  return {
    danmakuTypes: [...danmakuTypeIds],
    danmakuCount: selectedDanmakuCount(sample.danmakuTypeCounts, danmakuTypeIds),
    subtitles: [...subtitleIds],
  };
}

export function createSeedState(now = Date.now()) {
  const minutes = 60 * 1000;
  const hours = 60 * minutes;
  const days = 24 * hours;

  const makeHistory = (sample, quality, completedAt, sizeMB, selection = seedSelection(sample)) => {
    const meta = qualityMeta(quality);
    return {
      id: `hist_seed_${sample.key}_${completedAt}`,
      kind: "video",
      bvid: sample.bvid,
      title: sample.title,
      up: sample.up,
      cover: sample.cover,
      duration: sample.duration,
      quality: meta.id,
      qualityLabel: meta.label,
      baseQualityLabel: meta.label,
      format: meta.format,
      sizeMB,
      ...selection,
      completedAt,
    };
  };

  const history = [
    makeHistory(SAMPLE_VIDEOS[0], "1080P", now - 3 * hours - 12 * minutes, 342.1),
    makeHistory(
      SAMPLE_VIDEOS[1],
      "1080P",
      now - 26 * hours,
      421.6,
      seedSelection(SAMPLE_VIDEOS[1], ["scroll"], ["zh-auto"]),
    ),
    makeHistory(
      SAMPLE_VIDEOS[3],
      "audio",
      now - 29 * hours - 8 * minutes,
      41.2,
      seedSelection(SAMPLE_VIDEOS[3], [], []),
    ),
    makeHistory(SAMPLE_VIDEOS[2], "720P", now - 3 * days - 2 * hours, 264.7),
  ];

  const makeTask = (
    sample,
    quality,
    status,
    downloadedMB,
    extra = {},
    selection = seedSelection(sample),
  ) => {
    const meta = qualityMeta(quality);
    return {
      id: `task_seed_${sample.key}_${quality}`,
      kind: "video",
      bvid: sample.bvid,
      title: sample.title,
      up: sample.up,
      cover: sample.cover,
      duration: sample.duration,
      quality: meta.id,
      qualityLabel: meta.label,
      baseQualityLabel: meta.label,
      format: meta.format,
      sizeMB: sample.sizes[meta.id],
      downloadedMB,
      speed: status === "downloading" ? 11.6 : 0,
      speedBase: 11.6,
      status,
      error: null,
      extrasError: null,
      addedAt: now - 22 * minutes,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      ...selection,
      ...extra,
    };
  };

  const queue = [
    makeTask(
      SAMPLE_VIDEOS[1],
      "1080P",
      "downloading",
      232,
      { startedAt: now - 8 * minutes },
      seedSelection(SAMPLE_VIDEOS[1], ["scroll", "top", "bottom"], ["zh-auto"]),
    ),
    makeTask(SAMPLE_VIDEOS[2], "480P", "paused", 82.4),
    makeTask(SAMPLE_VIDEOS[0], "360P", "queued", 0, {
      queuedAt: now + 4200,
    }),
    makeTask(
      SAMPLE_VIDEOS[3],
      "480P",
      "failed",
      14.2,
      { error: "连接中断 · 下载服务器响应超时" },
      seedSelection(SAMPLE_VIDEOS[3], [], []),
    ),
  ];

  return {
    settings: { ...DEFAULT_SETTINGS },
    queue,
    history,
  };
}
