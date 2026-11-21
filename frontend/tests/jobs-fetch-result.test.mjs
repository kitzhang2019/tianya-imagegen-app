// tests/jobs-fetch-result.test.mjs — 取图线（v3.0：中转版）：
// ① 中转跑完 → WebP 先下先完成，PNG 后台补上、主图换回 PNG；
// ② 中转说结果还没准备好（/webp 与 /png 都 404）→ 留在 downloading 等下一轮，
//    不判失败、不死循环，准备好后下一轮取回；
// ③ 下载时断网 → 只写网络断开、不判失败，恢复后继续下载；
// ④ 重新取回只重试下载，不重新生成。
// 跑法：npm test。fetch 桩模拟 Colab 中转；Filesystem 桩用内存文件表。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __tickForTest,
  getJobs,
  initJobs,
  isNetworkDown,
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
  downloadMode: "good", // "good" | "not-ready"（webp/png 都 404）| "down"（下载直接断网）
  downloadOrder: [],
};

function fakeRelayJob(id) {
  if (!fake.jobs.has(id)) fake.jobs.set(id, { id, status: "queued", progress: 0, stage: "排队中" });
  return fake.jobs.get(id);
}

function resetFake() {
  fake.jobs.clear();
  fake.downloadMode = "good";
  fake.downloadOrder = [];
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const mDl = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)/(webp|png)$`));
  if (mDl) {
    const [, , format] = mDl;
    if (fake.downloadMode === "down") throw new TypeError("fetch failed");
    if (fake.downloadMode === "not-ready") return jsonRes(404, { ok: false, error: "not ready" });
    fake.downloadOrder.push(format);
    return bytesRes(format === "webp" ? WEBP_BYTES : PNG_BYTES);
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
    prompt: `fetch result test ${id}`,
    ratioKey: "auto",
    width: 1280,
    height: 1920,
    seed: 4000 + id,
    status: "running",
    stage: "running",
    backend: "kaggle",
    colabJobId: `cb-fetch-${id}`,
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

test("预置：4 个 Kaggle running 单（17 正常取回、18 结果未备好、19 下载断网、20 重新取回）", async () => {
  resetFake();
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      seedJob(17),
      seedJob(18),
      seedJob(19),
      seedJob(20, {
        status: "failed", stage: "failed", stageDetail: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        error: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        finishedAt: Date.now() - 10000, downloadStartedAt: Date.now() - 11 * 60 * 1000, failedAtDownload: true,
      }),
    ]),
    "tianya-imagegen-counter": "20",
  });
  await initJobs();
  stopPolling();
  await sleep(50);
  assert.equal(getJobs().length, 4);
});

test("中转跑完：WebP 先下先完成，PNG 后台到了再把主图换成 PNG", async () => {
  resetFake();
  fakeRelayJob("cb-fetch-17").status = "done";
  fakeRelayJob("cb-fetch-17").progress = 100;
  await __tickForTest();
  // 等后台 PNG 到了，主图换成 PNG（WebP 先下先完成、PNG 后补）
  await waitFor(() => job(17)?.status === "done" && job(17)?.imageFileName === "moss_dash_17.png", 8000, "17 号单取回完成");
  const done = job(17);
  assert.equal(done.status, "done");
  assert.equal(done.imageFileName, "moss_dash_17.png");
  assert.equal(done.webpFileName, "moss_dash_17.webp");
  // WebP 比 PNG 先下
  assert.equal(fake.downloadOrder[0], "webp");
  // 两份文件都在本地
  await Filesystem.readFile({ path: "images/moss_dash_17.webp" });
  await Filesystem.readFile({ path: "images/moss_dash_17.png" });
  // 其他单不受影响：18/19 中转还说排队中，仍在等、不判失败
  assert.equal(job(18).status, "queued");
  assert.equal(job(19).status, "queued");
});

test("结果还没准备好（webp/png 都 404）：留在 downloading 等下一轮，不判失败；准备好后取回", async () => {
  resetFake();
  fakeRelayJob("cb-fetch-18").status = "done";
  fake.downloadMode = "not-ready";
  await __tickForTest();
  let j = job(18);
  assert.equal(j.status, "downloading", "404 不是失败，等下一轮");
  assert.match(j.stageDetail || "", /还没准备好/);
  // 再跑一轮：还是 downloading，不判失败、不乱跳
  await __tickForTest();
  j = job(18);
  assert.equal(j.status, "downloading");
  assert.match(j.stageDetail || "", /还没准备好/);
  // 准备好了：下一轮取回。注意 downloading 分支的下载是后台跑的（不阻塞
  // tick），上一轮的后台任务可能还没跑完、下一轮会跳过 busy 的单，所以
  // 多跑几轮、每轮之间留一点时间，直到取回完成。
  fake.downloadMode = "good";
  for (let i = 0; i < 6 && job(18)?.status !== "done"; i++) {
    await __tickForTest();
    await sleep(50);
  }
  assert.equal(job(18).status, "done");
});

test("下载时断网：只写网络断开、不判失败，恢复后继续下载", async () => {
  resetFake();
  fakeRelayJob("cb-fetch-19").status = "done";
  fake.downloadMode = "down";
  await __tickForTest();
  let j = job(19);
  assert.equal(j.status, "downloading", "断网不判失败，等恢复");
  assert.match(j.stageDetail || "", /网络暂时断开/);
  assert.equal(isNetworkDown(), true);
  // 网络恢复后下一轮：正常取回（同上，downloading 分支的下载是后台跑的，
  // 多跑几轮直到取回完成）
  fake.downloadMode = "good";
  for (let i = 0; i < 6 && job(19)?.status !== "done"; i++) {
    await __tickForTest();
    await sleep(50);
  }
  assert.equal(job(19).status, "done");
});

test("重新取回：失败在下载的 Kaggle 单，中转已跑完，点一下只取回成品", async () => {
  resetFake();
  fakeRelayJob("cb-fetch-20").status = "done";
  fakeRelayJob("cb-fetch-20").progress = 100;
  await refetchJob(20);
  await waitFor(() => job(20)?.status === "done", 8000, "20 号单重新取回完成");
  const j = job(20);
  assert.equal(j.status, "done");
  assert.equal(j.failedAtDownload, false, "完成后下载失败标记应清掉");
});
