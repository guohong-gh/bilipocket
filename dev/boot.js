// @ts-check
// dev 入口：先组装演示 store，再启动共享的 app.js。
import { store } from "/dev/mock-store.js";
import { SAMPLE_VIDEOS, getSampleByInput } from "/dev/demo-data.js";
import { applyDemoCopy } from "/dev/demo-copy.js";

globalThis.__BILIPOCKET_DEMO__ = {
  store,
  samples: SAMPLE_VIDEOS,
  lookup: getSampleByInput,
};

applyDemoCopy();
await import("/js/app.js");
