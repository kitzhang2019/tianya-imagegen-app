// tests/jobs-webp-fallback.test.mjs — finishJob 的 WebP 兜底：PNG 下不下来时改下
// 同名 WebP 当主图，整单不再死。跑法：npm test。fetch 桩模拟 Kaggle API，
// Filesystem 桩用内存文件表；createImageBitmap 在 Node 里不存在，缩略图会
// 静默失败（不影响出图），这是预期的。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { __resetFiles } from "./stubs/capacitor-filesystem.mjs";
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
  // PNG 下载回的不是 PNG 内容（魔数不对）——downloadPng 立即报错不重试；
  // WebP 下载回合法 WebP，兜底走得通。
  if (u.includes("moss_dash_4.webp")) return bytesRes(WEBP_BYTES);
  if (u.includes("moss_dash_4.png")) return bytesRes(new Uint8Array([0, 0, 0, 0]));
  throw new Error(`测试桩没预料到的请求：${u}`);
};

test("finishJob：PNG 下不下来时改下同名 WebP 当主图，任务完成且 imageFileName 是 .webp", async () => {
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
  await waitFor(() => getJobs()[0]?.status === "done", 8000, "任务完成");
  const job = getJobs()[0];
  assert.equal(job.status, "done");
  assert.equal(job.imageFileName, "moss_dash_4.webp");
  assert.equal(job.webpFileName, null);
});
