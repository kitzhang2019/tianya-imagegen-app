// tests/jobs-refetch.test.mjs — 手动「重新取回」（v3.0：中转版）：
// 下载卡住（网络断开、图已在中转）时点一下，立刻再试一次下载，不重新生成、
// 不换种子；同时重置 10 分钟下载上限的时钟。
// 跑法：npm test。fetch 桩模拟 Colab 中转，Filesystem 桩用内存文件表；
// createImageBitmap 在 Node 里不存在，缩略图会静默失败（不影响出图），
// 这是预期的。下载桩用 downloadGood 开关：关时返回错魔数字节（下载立即报
// “不是 PNG/WebP”，不走 2s/4s 重试退避，测试跑得快），开时返回真图。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __saveJobsForTest,
  getJobs,
  initJobs,
  refetchJob,
  saveSettings,
  stopPolling,
} from "../src/lib/jobs.js";
import { COLAB_RELAY_BASE } from "../src/lib/colab.js";

const mossTemplate = fs.readFileSync(
  new URL("../public/notebooks/moss-comfyui-kaggle.ipynb", import.meta.url),
  "utf8",
);

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
// 中转任务状态（9 号单跑完，其余默认排队中）
const relayJobs = new Map();

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("notebooks/")) {
    return {
      status: 200, ok: true, headers: { get: () => "text/plain" },
      text: async () => mossTemplate,
      arrayBuffer: async () => new TextEncoder().encode(mossTemplate).buffer,
    };
  }
  if (u === `${COLAB_RELAY_BASE}/job`) {
    return jsonRes(200, { ok: true, job_id: "cb-rf-10" });
  }
  const mDl = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)/(webp|png)$`));
  if (mDl) {
    const [, , format] = mDl;
    downloadOrder.push(format);
    if (format === "webp") {
      // 关：给 PNG 字节当 WebP（魔数不对，立即报“不是 WebP”）；开：给真 WebP。
      return bytesRes(downloadGood ? WEBP_BYTES : PNG_BYTES);
    }
    // 关：给 WebP 字节当 PNG（魔数不对，立即报“不是 PNG”）；开：给真 PNG。
    await sleep(300);
    return bytesRes(downloadGood ? PNG_BYTES : WEBP_BYTES);
  }
  const mGet = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)$`));
  if (mGet) {
    const job = relayJobs.get(mGet[1]) || { id: mGet[1], status: "queued", progress: 0, stage: "排队中" };
    return jsonRes(200, { ok: true, job });
  }
  throw new Error(`测试桩没预料到的请求：${u}`);
};

const NOW = Date.now();

async function seedAndInit() {
  relayJobs.set("cb-rf-9", { id: "cb-rf-9", status: "done", progress: 100, stage: "完成" });
  __seedStore({
    "tianya-imagegen-settings": JSON.stringify({ relayKey: "test-relay-key", galleryKey: "", galleryUrl: "" }),
    "tianya-imagegen-jobs": JSON.stringify([
      {
        // 9 号单：正在跑，中转已跑完。重取时若不重置下载时钟，一次非网络失败
        // 就会直接判失败；重置后才留得下来。种子时钟先给 1 分钟前（initJobs
        // 那轮轮询会看到中转 done、立刻进下载，时钟太旧会在那轮就判失败）。
        id: 9, model: "moss", prompt: "p", seed: 1, width: 2560, height: 3840, ratioKey: "r2x3v",
        status: "running", stage: "running", stageDetail: "云端正在生成", backend: "kaggle",
        colabJobId: "cb-rf-9", kaggleRef: null, kaggleSlug: "app-moss-comfyui-kaggle-9",
        imageFileName: "moss_dash_9.png",
        loraKeys: ["guanlan"], useUpscale: true, downloadStartedAt: NOW - 60000,
        createdAt: NOW - 60000, pushedAt: NOW - 60000, stageStartedAt: NOW - 60000,
        verifyDeadlineAt: null, runningStartedAt: NOW - 60000, finishedAt: null, error: null,
      },
      {
        // 10 号单：还在本地排队、没提交过。initJobs 那轮 pumpQueue 会走中转
        // 提交它（桩直接回任务号），重取时它还没到下载这一步，应拒绝。
        id: 10, model: "moss", prompt: "p", seed: 2, width: 2560, height: 3840, ratioKey: "r2x3v",
        status: "queued-local", stage: "queued-local", stageDetail: "本地排队，等空闲的云端会话", backend: "kaggle",
        colabJobId: null, kaggleRef: null, kaggleSlug: "app-moss-comfyui-kaggle-10",
        imageFileName: "moss_dash_10.png",
        loraKeys: ["guanlan"], useUpscale: true, downloadStartedAt: null,
        createdAt: NOW - 60000, pushedAt: null, stageStartedAt: NOW - 60000,
        verifyDeadlineAt: null, runningStartedAt: null, finishedAt: null, error: null,
      },
      {
        id: 11, model: "moss", prompt: "p", seed: 3, width: 2560, height: 3840, ratioKey: "r2x3v",
        status: "failed", stage: "failed", stageDetail: "生成失败", backend: "kaggle",
        colabJobId: "cb-rf-11", kaggleRef: null, kaggleSlug: "app-moss-comfyui-kaggle-11",
        imageFileName: "moss_dash_11.png",
        loraKeys: ["guanlan"], useUpscale: true, error: "云端运行失败",
        createdAt: NOW - 60000, pushedAt: NOW - 60000, stageStartedAt: NOW - 60000,
        verifyDeadlineAt: null, runningStartedAt: NOW - 60000, finishedAt: NOW - 10000,
      },
      {
        id: 12, model: "moss", prompt: "p", seed: 4, width: 2560, height: 3840, ratioKey: "r2x3v",
        status: "done", stage: "done", stageDetail: "已完成，图片已保存", backend: "kaggle",
        colabJobId: "cb-rf-12", kaggleRef: null, kaggleSlug: "app-moss-comfyui-kaggle-12",
        imageFileName: "moss_dash_12.png",
        loraKeys: ["guanlan"], useUpscale: true, finishedAt: NOW - 10000,
        createdAt: NOW - 60000, pushedAt: NOW - 60000, stageStartedAt: NOW - 60000,
        verifyDeadlineAt: null, runningStartedAt: NOW - 60000, error: null,
      },
    ]),
    "tianya-imagegen-counter": "12",
  });
  await initJobs();
  // initJobs 启动的轮询会立刻跑一轮（9 号单状态还是 running，轮询会看到
  // 中转 done、触发下载；downloadGood 关时下载失败留在 downloading）；
  // 停掉 20 秒定时器、等这轮跑完（PNG 桩有 300ms 延迟，多等一会儿，
  // 免得后台下载还没跑完就点重新取回撞上 busyJobs），再手动点重新取回。
  stopPolling();
  await sleep(800);
}

before(async () => {
  await saveSettings({ relayKey: "test-relay-key", galleryKey: "", galleryUrl: "" });
});

test("refetchJob：找不到 / 已完成 / 已失败 / 还没到下载这一步的任务都拒绝", async () => {
  await seedAndInit();
  await assert.rejects(() => refetchJob(999), /找不到这条任务/);
  await assert.rejects(() => refetchJob(12), /已经下好了/);
  await assert.rejects(() => refetchJob(11), /重新提交/);
  await assert.rejects(() => refetchJob(10), /还没到下载这一步/);
});

test("refetchJob：下载失败时不判失败，且重置 10 分钟下载时钟", async () => {
  const before = getJobs().find((j) => j.id === 9);
  assert.equal(before.status, "downloading", "initJobs 那轮轮询已看到中转跑完、进了下载；错魔数留在 downloading");
  // 把时钟拨到 11 分钟前：重取时若不重置，这次非网络失败会直接判失败。
  before.downloadStartedAt = Date.now() - 11 * 60 * 1000;
  await __saveJobsForTest();
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
