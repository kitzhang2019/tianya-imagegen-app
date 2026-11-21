// tests/jobs-idempotent.test.mjs — 提交幂等（v3.0：中转版）：
// 固定 slug、提交回包丢了进待确认、5 分钟窗口过后判失败、retryJob 按中转状态
// 恢复旧单或新开一单（Kaggle 复用同一个 kaggleSlug）、网络未恢复不建新单。
// v3.0 回包丢失的单无法像老路那样靠查 kernel 恢复（中转没有按 appJobId
// 查单的接口、任务号丢了就对不上），5 分钟窗口过后判失败、再点重新提交。
// 跑法：npm test。fetch 桩模拟 Colab 中转：模板读磁盘真文件，
// POST /job 提交、GET /job/<id> 查状态按 fake 的设定应答。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import {
  __resetOrphansForTest,
  __saveJobsForTest,
  __tickForTest,
  deleteJob,
  getJobs,
  initJobs,
  isNetworkDown,
  onNetworkChange,
  retryJob,
  saveSettings,
  stopPolling,
  submitJob,
} from "../src/lib/jobs.js";
import { COLAB_RELAY_BASE } from "../src/lib/colab.js";

const realFetch = globalThis.fetch;
const qwenTemplate = fs.readFileSync(
  new URL("../public/notebooks/qwen-comfyui-kaggle.ipynb", import.meta.url),
  "utf8",
);

after(() => {
  globalThis.fetch = realFetch;
  stopPolling();
  __resetStore();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, timeoutMs = 5000, what = "条件") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error(`超时未达成：${what}`);
}

// 可编程的中转行为（每个测试按需改）
const fake = {
  status: "down", // "down"（断网）| "absent"（404）| "running" | "queued" | "failed" | "done"
  submit: "ok", // "ok" | "down"（提交请求发出去但回包丢了）
  submitCalls: [], // 记录每次真正发出的提交（请求体）
  submitSeq: 0,
};

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

function textRes(status, text) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "text/plain" },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("notebooks/")) return textRes(200, qwenTemplate);
  const mPost = u === `${COLAB_RELAY_BASE}/job` && (opts?.method || "GET") === "POST";
  if (mPost) {
    const body = JSON.parse(opts?.body || "{}");
    fake.submitCalls.push(body);
    if (fake.submit === "down") throw new TypeError("fetch failed");
    fake.submitSeq += 1;
    return jsonRes(200, { ok: true, job_id: `cb-relay-${fake.submitSeq}` });
  }
  const mFail = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)/fail$`));
  if (mFail && (opts?.method || "GET") === "POST") {
    return jsonRes(200, { ok: true, job: { id: mFail[1], status: "failed" } });
  }
  const mGet = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)$`));
  if (mGet) {
    if (fake.status === "down") throw new TypeError("fetch failed");
    if (fake.status === "absent") return jsonRes(404, { ok: false, error: "not found" });
    return jsonRes(200, {
      ok: true,
      job: { id: mGet[1], status: fake.status, progress: fake.status === "running" ? 40 : 0, stage: fake.status === "running" ? "生成中" : "排队中" },
    });
  }
  throw new Error(`测试桩没预料到的请求：${u}`);
};

const netEvents = [];
onNetworkChange((down) => netEvents.push(down));

function seedJob(id, extra) {
  return {
    id,
    model: "qwen",
    prompt: `idempotent test ${id}`,
    ratioKey: "auto",
    width: 1024,
    height: 1536,
    seed: 1000 + id,
    status: "failed",
    stage: "failed",
    backend: "kaggle",
    colabJobId: `cb-idem-${id}`,
    kaggleRef: null,
    kaggleSlug: `app-qwen-comfyui-kaggle-${id}`,
    createdAt: Date.now(),
    pushedAt: null,
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: null,
    finishedAt: Date.now(),
    error: "之前失败了",
    imageFileName: `qwen_test_${id}.png`,
    ...extra,
  };
}

async function clearActiveJobs() {
  // 先把占着 2 并发的运行中/排队中/准备中/本地排队/下载中任务清掉，否则新单进不了 pumpQueue。
  for (const j of getJobs().filter((x) => ["running", "queued", "preparing", "queued-local", "downloading"].includes(x.status))) {
    await deleteJob(j.id);
  }
  await __resetOrphansForTest(); // 删跑着的单会留后台跟踪，清理时一并清掉
}

test("重启后 preparing 任务不断网判失败，只记网络断开", async () => {
  // 预置：三条已失败的旧单（给后面 retryJob 用）+ 一条重启时中断在准备阶段的单。
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      seedJob(90),
      seedJob(91),
      seedJob(92),
      seedJob(93, { status: "preparing", stage: "preparing", error: null, finishedAt: null }),
      seedJob(94, { status: "queued", stage: "queued", error: null, finishedAt: null }),
    ]),
    "tianya-imagegen-counter": "94",
  });
  await saveSettings({ relayKey: "test-relay-key", galleryKey: "", galleryUrl: "" });
  // fake.status 默认 "down"：重启后的轮询查不到中转，只能记网络断开，不能判失败、不能重推。
  await initJobs();
  stopPolling();
  await sleep(50); // 让 initJobs 里那轮 tick 跑完
  // 有任务号但还停在 preparing 的单：tick 当 queued 继续轮询，不判失败
  const job93 = getJobs().find((j) => j.id === 93);
  assert.ok(job93);
  assert.equal(job93.status, "queued");
  assert.notEqual(job93.status, "failed");
  // 排队中的单查状态断网：只记网络断开，不判失败
  const job94 = getJobs().find((j) => j.id === 94);
  assert.ok(job94);
  assert.equal(job94.status, "queued");
  assert.notEqual(job94.status, "failed");
  assert.equal(isNetworkDown(), true);
  assert.equal(netEvents[netEvents.length - 1], true);
});

test("提交即固定 slug：app- 前缀，与管理站区分", async () => {
  await clearActiveJobs();
  fake.status = "queued";
  fake.submit = "ok";
  fake.submitCalls = [];
  const job = await submitJob({ model: "qwen", prompt: "idempotent test 1" });
  assert.equal(job.kaggleSlug, `app-qwen-comfyui-kaggle-${job.id}`);
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    5000,
    "新单提交到中转、排队中",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.colabJobId, "cb-relay-1");
  assert.equal(cur.kaggleRef, null, "v3.0 不再产生 kaggleRef");
  assert.equal(fake.submitCalls.length, 1);
  const body = fake.submitCalls[0];
  assert.equal(body.backend, "kaggle");
  assert.equal(body.kaggleSlug, `app-qwen-comfyui-kaggle-${job.id}`);
  assert.equal(body.title, `app-qwen-comfyui-kaggle-${job.id}`);
  assert.equal(body.appJobId, job.id);
  assert.ok(body.notebookText.length > 1000);
  // 提示词在 notebook 里是 base64（PROMPT = b64decode(...)），按 base64 断言
  const promptB64 = Buffer.from("idempotent test 1", "utf8").toString("base64");
  assert.ok(body.notebookText.includes(promptB64));
  // 中转说开始跑了：轮询跟上，成功查到状态后网络断开标记清掉
  fake.status = "running";
  await __tickForTest();
  assert.equal(getJobs().find((j) => j.id === job.id)?.status, "running");
  assert.equal(isNetworkDown(), false);
});

test("提交回包丢失：任务进待确认，不标失败", async () => {
  await clearActiveJobs();
  fake.status = "absent";
  fake.submit = "down"; // 提交请求发出去但回包丢了（代理断开）
  fake.submitCalls = [];
  const job = await submitJob({ model: "qwen", prompt: "idempotent test 2" });
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.stage === "confirming",
    5000,
    "丢回包的单进待确认",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.status, "preparing");
  assert.equal(cur.stage, "confirming");
  assert.match(cur.stageDetail, /网络暂时断开/);
  assert.equal(cur.kaggleSlug, `app-qwen-comfyui-kaggle-${job.id}`);
  assert.equal(isNetworkDown(), true);
  assert.equal(netEvents[netEvents.length - 1], true);
});

test("回包丢失的单 5 分钟窗口过后判失败（中转没有按 appJobId 查单的接口，恢复不了）", async () => {
  // v3.0 回包丢了就对不上中转任务号，窗口过后只能判失败、再点重新提交。
  const job = getJobs().find((j) => j.prompt === "idempotent test 2");
  assert.ok(job);
  job.verifyDeadlineAt = Date.now() - 1000;
  await __saveJobsForTest();
  await __tickForTest();
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.status, "failed");
  assert.match(cur.error || "", /没收到中转的回包/);
  assert.match(cur.error || "", /请重新提交/);
});

test("retryJob：中转已有这单在跑，恢复旧单、不二次提交", async () => {
  fake.status = "running";
  fake.submit = "ok";
  fake.submitCalls = [];
  const before = getJobs().length;
  const retried = await retryJob(90);
  assert.equal(retried.id, 90); // 恢复的是旧单，不是新单
  assert.equal(getJobs().length, before); // 没建新任务
  await waitFor(
    () => getJobs().find((j) => j.id === 90)?.status === "running",
    5000,
    "旧单恢复 running",
  );
  assert.equal(fake.submitCalls.length, 0); // 没提交
  const cur = getJobs().find((j) => j.id === 90);
  assert.equal(cur.colabJobId, "cb-idem-90");
  assert.match(cur.stageDetail || "", /Kaggle：生成中/);
});

test("retryJob：确认中转没有时才建新任务，复用同一个 slug", async () => {
  await clearActiveJobs();
  fake.status = "absent";
  fake.submit = "ok";
  fake.submitCalls = [];
  const before = getJobs().length;
  const retried = await retryJob(91);
  assert.notEqual(retried.id, 91);
  assert.equal(retried.kaggleSlug, "app-qwen-comfyui-kaggle-91"); // 复用旧 slug
  assert.equal(getJobs().length, before + 1);
  await waitFor(
    () => getJobs().find((j) => j.id === retried.id)?.status === "queued",
    5000,
    "新单提交到中转、排队中",
  );
  assert.equal(fake.submitCalls.length, 1);
  assert.equal(fake.submitCalls[0].kaggleSlug, "app-qwen-comfyui-kaggle-91");
  // 中转说开始跑了：轮询跟上
  fake.status = "running";
  await __tickForTest();
  assert.equal(getJobs().find((j) => j.id === retried.id)?.status, "running");
});

test("retryJob：网络未恢复时不建新任务", async () => {
  fake.status = "down";
  fake.submit = "down";
  fake.submitCalls = [];
  const before = getJobs().length;
  await assert.rejects(() => retryJob(92), /网络还没恢复/);
  assert.equal(getJobs().length, before);
  assert.equal(fake.submitCalls.length, 0);
  assert.equal(isNetworkDown(), true);
});

test("retryJob：回包丢失判失败的单重新提交，复用同一个 slug", async () => {
  await clearActiveJobs();
  const old = getJobs().find((j) => j.prompt === "idempotent test 2");
  assert.ok(old);
  assert.equal(old.status, "failed");
  fake.status = "queued";
  fake.submit = "ok";
  fake.submitCalls = [];
  const retried = await retryJob(old.id);
  assert.notEqual(retried.id, old.id);
  assert.equal(retried.kaggleSlug, old.kaggleSlug); // 复用旧 slug
  await waitFor(
    () => getJobs().find((j) => j.id === retried.id)?.status === "queued",
    5000,
    "新单提交到中转、排队中",
  );
  assert.equal(fake.submitCalls.length, 1);
  assert.equal(fake.submitCalls[0].kaggleSlug, old.kaggleSlug);
});
