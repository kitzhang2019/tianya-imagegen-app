// tests/jobs-webp-first.test.mjs — finishJob 的 WebP 优先：先下 1.25MB WebP，
// 存好就先完成任务、让图显示出来；12MB PNG 放后台慢慢下，存好后再把主图
// 换成 PNG（原图）。跑法：npm test。fetch 桩模拟 Kaggle API，Filesystem
// 桩用内存文件表；createImageBitmap 在 Node 里不存在，缩略图会静默失败
// （不影响出图），这是预期的。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __tickForTest,
  getJobs,
  initJobs,
  stopPolling,
} from "../src/lib/jobs.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  stopPolling();
  __resetStore();
  __resetFiles();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, timeoutMs = 8000, what = "条件") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error(`超时未达成：${what}`);
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function jsonRes(status, obj) {
  const text = JSON.stringify(obj);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

function bytesRes(bytes) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => "application/octet-stream" },
    text: async () => "",
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
}

// 记录两份图的下载顺序（PNG 故意慢一点，让 WebP 先行完成的状态能被观测到）。
const downloadOrder = [];

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("GetKernelSessionStatus")) return jsonRes(200, { status: "COMPLETE" });
  if (u.includes("ListKernelSessionOutput")) {
    return jsonRes(200, {
      files: [
        { fileName: "moss_dash_4.png", url: "https://www.kaggleusercontent.com/x/moss_dash_4.png" },
        { fileName: "moss_dash_4.webp", url: "https://www.kaggleusercontent.com/x/moss_dash_4.webp" },
      ],
    });
  }
  if (u.includes("moss_dash_4.webp")) {
    downloadOrder.push("webp");
    return bytesRes(WEBP_BYTES);
  }
  if (u.includes("moss_dash_4.png")) {
    downloadOrder.push("png");
    await sleep(300);
    return bytesRes(PNG_BYTES);
  }
  throw new Error(`测试桩没预料到的请求：${u}`);
};

test("finishJob：WebP 先下先完成，PNG 后台到了再把主图换成 PNG", async () => {
  const now = Date.now();
  __seedStore({
    "tianya-imagegen-settings": JSON.stringify({ kaggleUsername: "u", kaggleToken: "t", galleryKey: "", galleryUrl: "" }),
    "tianya-imagegen-jobs": JSON.stringify([
      {
        id: 4, model: "moss", prompt: "p", seed: 1, width: 2560, height: 3840, ratioKey: "r2x3v",
        status: "running", stage: "running", stageDetail: "云端正在生成",
        createdAt: now - 60000, pushedAt: now - 60000, stageStartedAt: now - 60000,
        kaggleRef: "u/app-moss-comfyui-kaggle-4", imageFileName: "moss_dash_4.png",
        loraKeys: ["guanlan"], useUpscale: true,
      },
    ]),
    "tianya-imagegen-counter": "4",
  });
  await initJobs();
  await __tickForTest();
  // 先等到任务 done 且主图是 WebP（PNG 还在后台下）
  await waitFor(
    () => getJobs()[0]?.status === "done" && getJobs()[0]?.imageFileName === "moss_dash_4.webp",
    8000,
    "任务先以 WebP 完成",
  );
  const mid = getJobs()[0];
  assert.equal(mid.status, "done");
  assert.equal(mid.imageFileName, "moss_dash_4.webp");
  assert.equal(mid.webpFileName, "moss_dash_4.webp");
  // WebP 比 PNG 先下
  assert.equal(downloadOrder[0], "webp");
  // 再等后台 PNG 到了，主图换成 PNG
  await waitFor(() => getJobs()[0]?.imageFileName === "moss_dash_4.png", 8000, "后台 PNG 到了主图换回 PNG");
  const job = getJobs()[0];
  assert.equal(job.status, "done");
  assert.equal(job.imageFileName, "moss_dash_4.png");
  assert.equal(job.webpFileName, "moss_dash_4.webp");
  // 两份文件都在本地
  await Filesystem.readFile({ path: "images/moss_dash_4.webp" });
  await Filesystem.readFile({ path: "images/moss_dash_4.png" });
});
