// tests/jobs-kaggle-relay.test.mjs — v3.0：Kaggle 后端改走 Colab 中转。
// 提交（请求体含 backend=kaggle、notebookText、kaggleSlug、datasetSources、
// title、appJobId）、轮询复用中转路径、旧任务迁移标记、队列满不再自动切
// Colab（改由守护进程瞬态重排）。跑法：npm test。fetch 桩模拟中转；
// 模板读磁盘真文件；Filesystem 桩用内存文件表。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __resetOrphansForTest,
  __tickForTest,
  deleteJob,
  getJobProgress,
  getJobs,
  initJobs,
  saveSettings,
  stopPolling,
  submitJob,
} from "../src/lib/jobs.js";
import { COLAB_RELAY_BASE } from "../src/lib/colab.js";

const realFetch = globalThis.fetch;
const templates = {};
for (const m of ["moss", "qwen", "krea2", "zimage"]) {
  templates[m] = fs.readFileSync(new URL(`../public/notebooks/${m}-comfyui-kaggle.ipynb`, import.meta.url), "utf8");
}

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

function textRes(status, text) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "text/plain" },
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
  submit: "ok", // "ok" | "401" | "down"
  jobs: new Map(), // jobId -> { status, progress, stage, error }
  postCalls: [],
  getCalls: [],
  failCalls: [],
};

function fakeRelayJob(id) {
  if (!fake.jobs.has(id)) fake.jobs.set(id, { id, status: "queued", progress: 0, stage: "排队中" });
  return fake.jobs.get(id);
}

function resetFake() {
  fake.submit = "ok";
  fake.jobs.clear();
  fake.postCalls = [];
  fake.getCalls = [];
  fake.failCalls = [];
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = opts?.method || "GET";
  if (u.includes("notebooks/")) {
    const m = ["moss", "qwen", "krea2", "zimage"].find((x) => u.includes(x)) || "qwen";
    return textRes(200, templates[m]);
  }
  if (u === `${COLAB_RELAY_BASE}/job` && method === "POST") {
    fake.postCalls.push({ headers: opts?.headers || {}, body: opts?.body });
    if (fake.submit === "down") throw new TypeError("fetch failed");
    if (fake.submit === "401") return jsonRes(401, { ok: false, error: "unauthorized" });
    const body = JSON.parse(opts?.body || "{}");
    const id = `cb-test-${fake.postCalls.length}`;
    fake.jobs.set(id, { id, status: "queued", progress: 0, stage: "排队中", model: body.model, backend: body.backend });
    return jsonRes(200, { ok: true, job_id: id });
  }
  const mFail = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)/fail$`));
  if (mFail && method === "POST") {
    fake.failCalls.push(mFail[1]);
    const job = fake.jobs.get(mFail[1]);
    if (job) job.status = "failed";
    return jsonRes(200, { ok: true, job: job ?? { id: mFail[1], status: "failed" } });
  }
  const m = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)(?:/(webp|png))?$`));
  if (m) {
    const [, id, format] = m;
    if (format === "webp") return bytesRes(WEBP_BYTES);
    if (format === "png") return bytesRes(PNG_BYTES);
    fake.getCalls.push(id);
    const job = fake.jobs.get(id);
    if (!job) return jsonRes(404, { ok: false, error: "not found" });
    return jsonRes(200, { ok: true, job });
  }
  throw new Error(`测试桩没预料到的请求：${method} ${u}`);
};

async function clearActiveJobs() {
  for (const j of getJobs().filter((x) => ["running", "queued", "preparing", "queued-local", "downloading"].includes(x.status))) {
    await deleteJob(j.id);
  }
  await __resetOrphansForTest();
}

before(async () => {
  await saveSettings({ relayKey: "test-relay-key" });
});

test("旧任务迁移：v1.2.28 直接提交的 Kaggle 单（无 colabJobId）标失败、请重提", async () => {
  resetFake();
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      {
        id: 301, model: "qwen", prompt: "old direct kaggle 301", ratioKey: "auto",
        width: 1024, height: 1536, seed: 3301, status: "running", stage: "running",
        stageDetail: "云端正在生成", backend: "kaggle", colabJobId: null,
        kaggleRef: "u/app-qwen-comfyui-kaggle-301", kaggleSlug: "app-qwen-comfyui-kaggle-301",
        createdAt: Date.now(), pushedAt: Date.now(), verifyDeadlineAt: null,
        stageStartedAt: Date.now(), runningStartedAt: Date.now(), finishedAt: null,
        error: null, imageFileName: "qwen_test_301.png", webpFileName: null,
        downloadStartedAt: null,
      },
      {
        id: 302, model: "qwen", prompt: "old done kaggle 302", ratioKey: "auto",
        width: 1024, height: 1536, seed: 3302, status: "done", stage: "done",
        stageDetail: "已完成，图片已保存", backend: "kaggle", colabJobId: null,
        kaggleRef: "u/app-qwen-comfyui-kaggle-302", kaggleSlug: "app-qwen-comfyui-kaggle-302",
        createdAt: Date.now(), pushedAt: Date.now(), verifyDeadlineAt: null,
        stageStartedAt: Date.now(), runningStartedAt: Date.now(), finishedAt: Date.now(),
        error: null, imageFileName: "qwen_test_302.png", webpFileName: null,
        downloadStartedAt: null,
      },
      {
        id: 303, model: "qwen", prompt: "queued-local kaggle 303", ratioKey: "auto",
        width: 1024, height: 1536, seed: 3303, status: "queued-local", stage: "queued-local",
        stageDetail: "本地排队，等空闲的云端会话", backend: "kaggle", colabJobId: null,
        kaggleRef: null, kaggleSlug: "app-qwen-comfyui-kaggle-303",
        createdAt: Date.now(), pushedAt: null, verifyDeadlineAt: null,
        stageStartedAt: Date.now(), runningStartedAt: null, finishedAt: null,
        error: null, imageFileName: "qwen_test_303.png", webpFileName: null,
        downloadStartedAt: null,
      },
    ]),
    "tianya-imagegen-counter": "302",
  });
  await initJobs();
  stopPolling();
  await sleep(50);
  const old = getJobs().find((j) => j.id === 301);
  assert.ok(old);
  assert.equal(old.status, "failed");
  assert.match(old.error, /v3\.0 改走中转代劳/);
  assert.match(old.error, /旧版直接提交/);
  assert.match(old.error, /请重新提交/);
  // 已完成的旧单不动
  const done = getJobs().find((j) => j.id === 302);
  assert.equal(done.status, "done");
  // 还没提交过的 queued-local 单不标失败：pumpQueue 会走中转重新提交它
  await waitFor(
    () => {
      const j = getJobs().find((x) => x.id === 303);
      return j && j.status !== "failed" && !!j.colabJobId;
    },
    8000,
    "queued-local 的 Kaggle 单走中转提交",
  );
  const ql = getJobs().find((j) => j.id === 303);
  assert.equal(ql.status, "queued");
  assert.equal(ql.backend, "kaggle");
});

test("Kaggle 提交走中转：请求体含 backend=kaggle、notebookText、kaggleSlug、datasetSources、title、appJobId", async () => {
  resetFake();
  const job = await submitJob({ model: "qwen", prompt: "kaggle relay submit test", backend: "kaggle" });
  assert.equal(job.backend, "kaggle");
  assert.equal(job.kaggleSlug, `app-qwen-comfyui-kaggle-${job.id}`);
  assert.equal(job.kaggleRef, null, "新任务不再产生 kaggleRef");
  assert.equal(job.colabJobId, null);
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "Kaggle 单进排队",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.ok(cur.colabJobId);
  assert.match(cur.colabJobId, /^cb-test-/);
  assert.equal(cur.stageDetail, "已提交到中转（Kaggle），排队中");
  assert.equal(fake.postCalls.length, 1);
  assert.equal(fake.postCalls[0].headers["X-Colab-Key"], "test-relay-key");
  const body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.backend, "kaggle");
  assert.equal(body.model, "qwen");
  assert.equal(body.prompt, "kaggle relay submit test");
  assert.equal(body.seed, job.seed);
  assert.equal(body.source, "app");
  assert.equal(typeof body.notebookText, "string");
  assert.ok(body.notebookText.length > 1000, "notebook 文本应是完整 .ipynb");
  // 提示词在 notebook 里是 base64（PROMPT = b64decode(...)），按 base64 断言
  const promptB64 = Buffer.from("kaggle relay submit test", "utf8").toString("base64");
  assert.ok(body.notebookText.includes(promptB64), "notebook 里应打进提示词（base64）");
  assert.equal(body.kaggleSlug, `app-qwen-comfyui-kaggle-${job.id}`);
  assert.equal(body.title, body.kaggleSlug);
  assert.equal(body.appJobId, job.id);
  assert.ok(Array.isArray(body.datasetSources));
  assert.ok(body.datasetSources.includes("kitzhang2019/seedvr2-7b"), "开超分应挂 SeedVR 7B 数据集");
  // 旧直连路不再发请求：没有 Kaggle API 调用
  assert.equal(fake.getCalls.length, 0);
});

test("Kaggle 提交 MOSS：moodyRef 由守护进程核实，App 不挂 Moody 数据集", async () => {
  resetFake();
  await clearActiveJobs();
  const job = await submitJob({ model: "moss", prompt: "kaggle moss relay test", backend: "kaggle" });
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "MOSS Kaggle 单进排队",
  );
  assert.equal(fake.postCalls.length, 1);
  const body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.backend, "kaggle");
  assert.ok(!body.datasetSources.some((s) => String(s).includes("moody-moss-mix")), "App 不再核实/挂 Moody 数据集，等守护进程补");
  assert.ok(body.datasetSources.includes("kitzhang2019/seedvr2-7b"));
  await clearActiveJobs();
});

test("Kaggle 全流程复用中转轮询：进度进进度环，done 后下 WebP 完成、PNG 后台补上", async () => {
  resetFake();
  const job = await submitJob({ model: "qwen", prompt: "kaggle relay flow test", backend: "kaggle" });
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "Kaggle 单进排队",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  const remote = fakeRelayJob(cur.colabJobId);
  remote.status = "running";
  remote.progress = 40;
  remote.stage = "生成中";
  await __tickForTest();
  let cur2 = getJobs().find((j) => j.id === job.id);
  assert.equal(cur2.status, "running");
  assert.equal(cur2.colabProgress, 40);
  assert.match(cur2.stageDetail, /Kaggle：生成中 · 40%/);
  assert.equal(getJobProgress(cur2).pct, 53); // 30 + 40% × 58
  remote.status = "done";
  remote.progress = 100;
  await __tickForTest();
  cur2 = getJobs().find((j) => j.id === job.id);
  assert.equal(cur2.status, "done");
  assert.ok(cur2.imageFileName.endsWith(".webp"));
  const { data } = await Filesystem.readFile({ path: `images/${cur2.imageFileName}`, directory: "DATA" });
  assert.ok(data.length > 0);
  await waitFor(() => getJobs().find((j) => j.id === job.id)?.imageFileName.endsWith(".png"), 8000, "PNG 后台补上");
});

test("Kaggle 提交缺中转密钥：报错请填中转密钥，不提 Kaggle Token", async () => {
  resetFake();
  await saveSettings({ relayKey: "" });
  await assert.rejects(
    () => submitJob({ model: "qwen", prompt: "kaggle no key test", backend: "kaggle" }),
    /请先在设置里填好 Colab 中转密钥/,
  );
  await saveSettings({ relayKey: "test-relay-key" });
});

test("Kaggle 提交 401：直接判失败、提示核对密钥", async () => {
  resetFake();
  fake.submit = "401";
  const job = await submitJob({ model: "qwen", prompt: "kaggle relay 401 test", backend: "kaggle" });
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "failed",
    8000,
    "401 的单判失败",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.match(cur.error, /中转密钥不对/);
});

test("Kaggle 提交断网：进待确认、不标失败、不重推", async () => {
  resetFake();
  await clearActiveJobs();
  fake.submit = "down";
  const job = await submitJob({ model: "qwen", prompt: "kaggle relay down test", backend: "kaggle" });
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.stage === "confirming",
    8000,
    "断网的单进待确认",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.status, "preparing");
  assert.match(cur.stageDetail, /网络暂时断开/);
  assert.ok(cur.verifyDeadlineAt);
  assert.equal(fake.postCalls.length, 1); // 只发过一次提交，没盲目重推
  // 5 分钟窗口过了：判失败，写明核对不了的原因
  cur.verifyDeadlineAt = Date.now() - 1000;
  await __tickForTest();
  const after = getJobs().find((j) => j.id === job.id);
  assert.equal(after.status, "failed");
  assert.match(after.error, /无法确认任务是否已建出/);
});

test("队列满不再自动切 Colab：中转报失败就判失败、后端仍是 Kaggle、不新开提交", async () => {
  resetFake();
  await clearActiveJobs();
  const job = await submitJob({ model: "qwen", prompt: "kaggle queue full no switch test", backend: "kaggle" });
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "Kaggle 单进排队",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  const remote = fakeRelayJob(cur.colabJobId);
  remote.status = "failed";
  remote.error = "Maximum batch GPU session count of 2 reached";
  await __tickForTest();
  const after = getJobs().find((j) => j.id === job.id);
  assert.equal(after.status, "failed");
  assert.equal(after.backend, "kaggle", "队列满也不改后端、不自动切 Colab");
  assert.equal(fake.postCalls.length, 1, "没往中转发第二次提交");
  assert.doesNotMatch(after.error || "", /自动切换/);
});
