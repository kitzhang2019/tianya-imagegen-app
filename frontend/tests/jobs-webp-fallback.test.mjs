// tests/jobs-webp-fallback.test.mjs — WebP 失败回退 PNG（v3.0：中转版）：
// 中转跑完后：
// ① /webp 404（中转还没备好 WebP）→ 改下 PNG，任务照样完成；
// ② /webp 返回错魔数（不是 WebP）→ 改下 PNG，任务照样完成；
// ③ WebP 和 PNG 都 404 → 留在 downloading 等下一轮，不判失败。
// 跑法：npm test。fetch 桩模拟 Colab 中转；Filesystem 桩用内存文件表。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __tickForTest,
  getJobs,
  initJobs,
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
// 错魔数：PNG 开头却走了 /webp
const BAD_WEBP_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

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
  webpMode: "404", // "404" | "bad-magic" | "both-404"
  pngMode: "good", // "good" | "404"
  downloadOrder: [],
};

function fakeRelayJob(id) {
  if (!fake.jobs.has(id)) fake.jobs.set(id, { id, status: "queued", progress: 0, stage: "排队中" });
  return fake.jobs.get(id);
}

function resetFake() {
  fake.jobs.clear();
  fake.webpMode = "404";
  fake.pngMode = "good";
  fake.downloadOrder = [];
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const mDl = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)/(webp|png)$`));
  if (mDl) {
    const [, , format] = mDl;
    fake.downloadOrder.push(format);
    if (format === "webp") {
      if (fake.webpMode === "404" || fake.webpMode === "both-404") return jsonRes(404, { ok: false, error: "not found" });
      if (fake.webpMode === "bad-magic") return bytesRes(BAD_WEBP_BYTES);
      return bytesRes(PNG_BYTES);
    }
    if (fake.pngMode === "404" || fake.webpMode === "both-404") return jsonRes(404, { ok: false, error: "not found" });
    return bytesRes(PNG_BYTES);
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
    prompt: `webp fallback test ${id}`,
    ratioKey: "auto",
    width: 1280,
    height: 1920,
    seed: 6000 + id,
    status: "running",
    stage: "running",
    backend: "kaggle",
    colabJobId: `cb-wfb-${id}`,
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

test("预置：3 个 Kaggle running 单（71 webp 404、72 webp 错魔数、73 两路都 404）", async () => {
  resetFake();
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([seedJob(71), seedJob(72), seedJob(73)]),
    "tianya-imagegen-counter": "73",
  });
  await initJobs();
  stopPolling();
  await sleep(50);
  assert.equal(getJobs().length, 3);
});

test("WebP 404：改下 PNG，任务照样完成", async () => {
  resetFake();
  fake.webpMode = "404";
  fakeRelayJob("cb-wfb-71").status = "done";
  fakeRelayJob("cb-wfb-71").progress = 100;
  await __tickForTest();
  await waitFor(() => job(71)?.status === "done", 8000, "71 号单回退 PNG 完成");
  const j = job(71);
  assert.equal(j.status, "done");
  assert.equal(j.imageFileName, "moss_dash_71.png");
  assert.equal(j.webpFileName, null, "没下到 WebP，webpFileName 留空");
  // PNG 在本机
  await Filesystem.readFile({ path: "images/moss_dash_71.png" });
});

test("WebP 错魔数：改下 PNG，任务照样完成", async () => {
  resetFake();
  fake.webpMode = "bad-magic";
  fakeRelayJob("cb-wfb-72").status = "done";
  fakeRelayJob("cb-wfb-72").progress = 100;
  await __tickForTest();
  await waitFor(() => job(72)?.status === "done", 8000, "72 号单回退 PNG 完成");
  const j = job(72);
  assert.equal(j.status, "done");
  assert.equal(j.imageFileName, "moss_dash_72.png");
  assert.equal(j.webpFileName, null, "错魔数的 WebP 不认，webpFileName 留空");
  await Filesystem.readFile({ path: "images/moss_dash_72.png" });
});

test("WebP 和 PNG 都 404：留在 downloading 等下一轮，不判失败；准备好后取回", async () => {
  resetFake();
  fake.webpMode = "both-404";
  fakeRelayJob("cb-wfb-73").status = "done";
  fakeRelayJob("cb-wfb-73").progress = 100;
  await __tickForTest();
  let j = job(73);
  assert.equal(j.status, "downloading");
  assert.match(j.stageDetail || "", /还没准备好/);
  // 再跑一轮：还是 downloading，不判失败
  await __tickForTest();
  j = job(73);
  assert.equal(j.status, "downloading");
  // 准备好了：下一轮取回。注意 downloading 分支的下载是后台跑的（不阻塞
  // tick），上一轮的后台任务可能还没跑完、下一轮会跳过 busy 的单，所以
  // 多跑几轮、每轮之间留一点时间，直到取回完成。
  fake.webpMode = "404"; // WebP 仍 404，PNG 好了 → 回退 PNG 完成
  for (let i = 0; i < 6 && job(73)?.status !== "done"; i++) {
    await __tickForTest();
    await sleep(50);
  }
  assert.equal(job(73).status, "done");
  assert.equal(job(73).imageFileName, "moss_dash_73.png");
});
