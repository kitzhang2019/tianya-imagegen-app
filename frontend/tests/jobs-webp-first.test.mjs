// tests/jobs-webp-first.test.mjs — WebP 先行（v3.0：中转版）：
// 中转跑完后先下轻量 WebP（约 150KB），任务立刻标 done、图立刻能看；
// 再后台下 PNG 原图（约 1MB），到了再把主图换成 PNG。
// 跑法：npm test。fetch 桩模拟 Colab 中转；Filesystem 桩用内存文件表。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __saveJobsForTest,
  __tickForTest,
  getJobs,
  initJobs,
  refetchJob,
  saveSettings,
  stopPolling,
} from "../src/lib/jobs.js";
import { COLAB_RELAY_BASE } from "../src/lib/colab.js";
import { outputFileName } from "../src/lib/notebook.js";

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
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

// 可编程的中转行为（每个测试按需改）
const fake = {
  jobs: new Map(), // colabJobId -> { status, progress, stage, error }
  pngMode: "good", // "good" | "gate"（PNG 请求挂起，等测试放行）| "404"
  pngGate: null, // 放行 PNG 的 resolve 函数
  downloadOrder: [],
};

function fakeRelayJob(id) {
  if (!fake.jobs.has(id)) fake.jobs.set(id, { id, status: "queued", progress: 0, stage: "排队中" });
  return fake.jobs.get(id);
}

function resetFake() {
  fake.jobs.clear();
  fake.pngMode = "good";
  fake.pngGate = null;
  fake.downloadOrder = [];
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const mDl = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)/(webp|png)$`));
  if (mDl) {
    const [, , format] = mDl;
    fake.downloadOrder.push(format);
    if (format === "png") {
      if (fake.pngMode === "404") return jsonRes(404, { ok: false, error: "not found" });
      if (fake.pngMode === "gate") {
        await new Promise((resolve) => { fake.pngGate = resolve; });
        fake.pngGate = null;
      }
      return bytesRes(PNG_BYTES);
    }
    return bytesRes(WEBP_BYTES);
  }
  const mGet = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)$`));
  if (mGet) {
    return jsonRes(200, { ok: true, job: fakeRelayJob(mGet[1]) });
  }
  throw new Error(`测试桩没预料到的请求：${u}`);
};

function seedJob(id, extra) {
  return {
    id,
    model: "moss",
    prompt: `webp first test ${id}`,
    ratioKey: "auto",
    width: 1280,
    height: 1920,
    seed: 5000 + id,
    status: "running",
    stage: "running",
    backend: "kaggle",
    colabJobId: `cb-webp-${id}`,
    colabProgress: null,
    kaggleRef: null,
    kaggleSlug: `app-moss-comfyui-kaggle-${id}`,
    createdAt: Date.now(),
    pushedAt: Date.now(),
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: Date.now(),
    finishedAt: null,
    error: null,
    imageFileName: outputFileName("moss", id),
    webpFileName: null,
    downloadStartedAt: null,
    ...extra,
  };
}

function job(id) {
  return getJobs().find((j) => j.id === id);
}

before(async () => {
  await saveSettings({ relayKey: "test-relay-key", galleryKey: "", galleryUrl: "" });
});

test("预置：1 个 Kaggle running 单（PNG 挂起，等放行）", async () => {
  resetFake();
  fake.pngMode = "gate";
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([seedJob(61)]),
    "tianya-imagegen-counter": "61",
  });
  await initJobs();
  stopPolling();
  await sleep(50);
  assert.equal(getJobs().length, 1);
});

test("WebP 先下先完成：PNG 还在后台下时，任务已 done、主图是 WebP", async () => {
  fakeRelayJob("cb-webp-61").status = "done";
  fakeRelayJob("cb-webp-61").progress = 100;
  await __tickForTest();
  // 等到任务 done（WebP 已下完、PNG 还挂着）
  await waitFor(
    () => job(61)?.status === "done" && job(61)?.imageFileName === "moss_dash_61.webp",
    8000,
    "任务先以 WebP 完成",
  );
  const j = job(61);
  assert.equal(j.status, "done");
  assert.equal(j.imageFileName, "moss_dash_61.webp");
  assert.equal(j.webpFileName, "moss_dash_61.webp");
  // WebP 比 PNG 先下
  assert.equal(fake.downloadOrder[0], "webp");
  // PNG 请求已经发出、正在等放行
  await waitFor(() => fake.downloadOrder.includes("png"), 8000, "PNG 后台请求已发出");
  // WebP 文件已在本机
  await Filesystem.readFile({ path: "images/moss_dash_61.webp" });
});

test("放行 PNG 后：主图换成 PNG，WebP 仍在本地，任务还是 done", async () => {
  // 放行挂起的 PNG 请求
  assert.ok(fake.pngGate, "PNG 请求正在等放行");
  fake.pngGate();
  await waitFor(() => job(61)?.imageFileName === "moss_dash_61.png", 8000, "后台 PNG 到了主图换回 PNG");
  const j = job(61);
  assert.equal(j.status, "done");
  assert.equal(j.imageFileName, "moss_dash_61.png");
  assert.equal(j.webpFileName, "moss_dash_61.webp");
  // 两份文件都在本地
  await Filesystem.readFile({ path: "images/moss_dash_61.webp" });
  await Filesystem.readFile({ path: "images/moss_dash_61.png" });
});

test("重新取回也走 WebP 先行：PNG 到了再换回 PNG", async () => {
  resetFake();
  fakeRelayJob("cb-webp-61").status = "done";
  fakeRelayJob("cb-webp-61").progress = 100;
  // 把 61 号单改成失败在下载（成品在中转），再点重新取回：WebP 先下先完成
  const job61 = job(61);
  Object.assign(job61, {
    status: "failed", stage: "failed",
    stageDetail: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
    error: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
    finishedAt: Date.now() - 10000, downloadStartedAt: Date.now() - 11 * 60 * 1000,
    failedAtDownload: true,
  });
  await __saveJobsForTest();
  // 先把本地两份图删掉，重新取回才真的走下载
  await Filesystem.deleteFile({ path: "images/moss_dash_61.png" });
  await Filesystem.deleteFile({ path: "images/moss_dash_61.webp" });
  await refetchJob(61);
  await waitFor(
    () => job(61)?.status === "done" && job(61)?.imageFileName === "moss_dash_61.png",
    8000,
    "重新取回完成",
  );
  const j = job(61);
  assert.equal(j.status, "done");
  assert.equal(j.imageFileName, "moss_dash_61.png");
  assert.equal(j.webpFileName, "moss_dash_61.webp");
  assert.equal(fake.downloadOrder[0], "webp");
});
