// tests/jobs-refetch.test.mjs — 手动「重新取回」：下载卡住（网络断开、图已在云端）
// 时点一下，立刻再试一次下载，不重新生成、不换种子；同时重置 10 分钟下载
// 上限的时钟。跑法：npm test。fetch 桩模拟 Kaggle API，Filesystem 桩用内存
// 文件表；createImageBitmap 在 Node 里不存在，缩略图会静默失败（不影响出图），
// 这是预期的。下载桩用 downloadGood 开关：关时返回错魔数字节（下载立即报
// “不是 PNG/WebP”，不走 2s/4s 重试退避，测试跑得快），开时返回真图。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  getJobs,
  initJobs,
  refetchJob,
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

// 下载开关：false = 返回错魔数字节（下载立即失败，不重试）；true = 返回真图。
let downloadGood = false;
const downloadOrder = [];

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("GetKernelSessionStatus")) return jsonRes(200, { status: "RUNNING" });
  if (u.includes("ListKernelSessionOutput")) {
    return jsonRes(200, {
      files: [
        { fileName: "moss_dash_9.png", url: "https://www.kaggleusercontent.com/x/moss_dash_9.png" },
        { fileName: "moss_dash_9.webp", url: "https://www.kaggleusercontent.com/x/moss_dash_9.webp" },
      ],
    });
  }
  if (u.includes("moss_dash_9.webp")) {
    downloadOrder.push("webp");
    // 关：给 PNG 字节当 WebP（魔数不对，立即报“不是 WebP”）；开：给真 WebP。
    return bytesRes(downloadGood ? WEBP_BYTES : PNG_BYTES);
  }
  if (u.includes("moss_dash_9.png")) {
    downloadOrder.push("png");
    await sleep(300);
    // 关：给 WebP 字节当 PNG（魔数不对，立即报“不是 PNG”）；开：给真 PNG。
    return bytesRes(downloadGood ? PNG_BYTES : WEBP_BYTES);
  }
  throw new Error(`测试桩没预料到的请求：${u}`);
};

const NOW = Date.now();
const ELEVEN_MIN_AGO = NOW - 11 * 60 * 1000;

async function seedAndInit() {
  __seedStore({
    "tianya-imagegen-settings": JSON.stringify({ kaggleUsername: "u", kaggleToken: "t", galleryKey: "", galleryUrl: "" }),
    "tianya-imagegen-jobs": JSON.stringify([
      {
        // 9 号单：正在跑、下载时钟已是 11 分钟前（超过 10 分钟上限）。重取时若不
        // 重置时钟，一次非网络失败就会直接判失败；重置后才留得下来。
        id: 9, model: "moss", prompt: "p", seed: 1, width: 2560, height: 3840, ratioKey: "r2x3v",
        status: "running", stage: "running", stageDetail: "云端正在生成",
        createdAt: NOW - 60000, pushedAt: NOW - 60000, stageStartedAt: NOW - 60000,
        kaggleRef: "u/app-moss-comfyui-kaggle-9", imageFileName: "moss_dash_9.png",
        loraKeys: ["guanlan"], useUpscale: true, downloadStartedAt: ELEVEN_MIN_AGO,
      },
      {
        id: 10, model: "moss", prompt: "p", seed: 2, width: 2560, height: 3840, ratioKey: "r2x3v",
        status: "downloading", stage: "downloading", stageDetail: "正在下载结果图…",
        createdAt: NOW - 60000, pushedAt: NOW - 60000, stageStartedAt: NOW - 60000,
        kaggleRef: null, imageFileName: "moss_dash_10.png",
        loraKeys: ["guanlan"], useUpscale: true, downloadStartedAt: NOW - 60000,
      },
      {
        id: 11, model: "moss", prompt: "p", seed: 3, width: 2560, height: 3840, ratioKey: "r2x3v",
        status: "failed", stage: "failed", stageDetail: "生成失败",
        createdAt: NOW - 60000, pushedAt: NOW - 60000, stageStartedAt: NOW - 60000,
        kaggleRef: "u/app-moss-comfyui-kaggle-11", imageFileName: "moss_dash_11.png",
        loraKeys: ["guanlan"], useUpscale: true, error: "云端运行失败",
      },
      {
        id: 12, model: "moss", prompt: "p", seed: 4, width: 2560, height: 3840, ratioKey: "r2x3v",
        status: "done", stage: "done", stageDetail: "已完成，图片已保存",
        createdAt: NOW - 60000, pushedAt: NOW - 60000, stageStartedAt: NOW - 60000,
        kaggleRef: "u/app-moss-comfyui-kaggle-12", imageFileName: "moss_dash_12.png",
        loraKeys: ["guanlan"], useUpscale: true, finishedAt: NOW - 10000,
      },
    ]),
    "tianya-imagegen-counter": "12",
  });
  await initJobs();
  // initJobs 启动的轮询会立刻跑一轮（9 号单状态还是 running，不会触发下载）；
  // 停掉 20 秒定时器、等这轮跑完，再手动点重新取回。
  stopPolling();
  await sleep(300);
}

test("refetchJob：找不到 / 已完成 / 已失败 / 没云端引用的任务都拒绝", async () => {
  await seedAndInit();
  await assert.rejects(() => refetchJob(999), /找不到这条任务/);
  await assert.rejects(() => refetchJob(12), /已经下好了/);
  await assert.rejects(() => refetchJob(11), /重新提交/);
  await assert.rejects(() => refetchJob(10), /云端还没有/);
});

test("refetchJob：下载失败时不判失败，且重置 10 分钟下载时钟", async () => {
  const before = getJobs().find((j) => j.id === 9);
  assert.equal(before.status, "running");
  assert.ok(Date.now() - before.downloadStartedAt > 10 * 60 * 1000, "种子时钟应超过 10 分钟");
  downloadGood = false;
  await refetchJob(9);
  const job = getJobs().find((j) => j.id === 9);
  // 时钟没重置的话，这次非网络失败会直接判失败；重置后才留得下来
  assert.equal(job.status, "downloading");
  assert.ok(job.downloadStartedAt, "重取后应记下新的下载开始时间");
  assert.ok(Date.now() - job.downloadStartedAt < 60 * 1000, "下载时钟应重置为现在");
});

test("refetchJob：下载通了重取，WebP 先下先完成，PNG 后台到了再换回", async () => {
  downloadGood = true;
  await refetchJob(9);
  await waitFor(
    () => getJobs().find((j) => j.id === 9)?.status === "done" && getJobs().find((j) => j.id === 9)?.imageFileName === "moss_dash_9.webp",
    8000,
    "任务先以 WebP 完成",
  );
  const mid = getJobs().find((j) => j.id === 9);
  assert.equal(mid.status, "done");
  assert.equal(mid.imageFileName, "moss_dash_9.webp");
  assert.equal(downloadOrder[0], "webp");
  await waitFor(() => getJobs().find((j) => j.id === 9)?.imageFileName === "moss_dash_9.png", 8000, "后台 PNG 到了主图换回 PNG");
  const job = getJobs().find((j) => j.id === 9);
  assert.equal(job.status, "done");
  assert.equal(job.imageFileName, "moss_dash_9.png");
  assert.equal(job.webpFileName, "moss_dash_9.webp");
  await Filesystem.readFile({ path: "images/moss_dash_9.webp" });
  await Filesystem.readFile({ path: "images/moss_dash_9.png" });
});
