// tests/jobs-colab.test.mjs — Colab 后端引擎测试：提交到中转、轮询进度、
// 下载完成、401 判失败、断网进待确认、重提按中转状态恢复/新开、
// 重新生成保持后端、进度环用中转进度。跑法：npm test。
// fetch 桩模拟 Cloudflare Worker colab-relay；Filesystem 桩用内存文件表。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __tickForTest,
  deleteJob,
  getJobProgress,
  getJobs,
  initJobs,
  isNetworkDown,
  normalizeBackend,
  refetchJob,
  regenerateJob,
  retryJob,
  saveSettings,
  stopPolling,
  submitJob,
} from "../src/lib/jobs.js";
import { COLAB_RELAY_BASE } from "../src/lib/colab.js";

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
  submit: "ok", // "ok" | "401" | "down"
  jobs: new Map(), // jobId -> { status, progress, stage, error }
  postCalls: [],
  getCalls: [],
  failCalls: [], // v1.2.25：删任务先调 POST /job/<id>/fail 取消中转任务
};

function fakeRelayJob(id) {
  if (!fake.jobs.has(id)) fake.jobs.set(id, { id, status: "queued", progress: 0, stage: "排队中" });
  return fake.jobs.get(id);
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = opts?.method || "GET";
  if (u === `${COLAB_RELAY_BASE}/job` && method === "POST") {
    fake.postCalls.push({ headers: opts?.headers || {}, body: opts?.body });
    if (fake.submit === "down") throw new TypeError("fetch failed");
    if (fake.submit === "401") return jsonRes(401, { ok: false, error: "unauthorized" });
    const body = JSON.parse(opts?.body || "{}");
    const id = `cb-test-${fake.postCalls.length}`;
    fake.jobs.set(id, { id, status: "queued", progress: 0, stage: "排队中", model: body.model });
    return jsonRes(200, { ok: true, job_id: id });
  }
  const mFail = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)/fail$`));
  if (mFail && method === "POST") {
    fake.failCalls.push({ id: mFail[1], headers: opts?.headers || {}, body: opts?.body });
    const job = fake.jobs.get(mFail[1]);
    if (job) {
      job.status = "failed";
      job.error = "已在 App 里删除";
    }
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

function resetFake() {
  fake.submit = "ok";
  fake.jobs.clear();
  fake.postCalls = [];
  fake.getCalls = [];
  fake.failCalls = [];
}

function seedColabJob(id, extra) {
  return {
    id,
    model: "qwen",
    prompt: `colab test ${id}`,
    ratioKey: "auto",
    width: 1024,
    height: 1536,
    seed: 2000 + id,
    status: "failed",
    stage: "failed",
    backend: "colab",
    colabJobId: `cb-seed-${id}`,
    colabProgress: null,
    kaggleRef: null,
    kaggleSlug: null,
    createdAt: Date.now(),
    pushedAt: null,
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: null,
    finishedAt: Date.now(),
    error: "之前失败了",
    imageFileName: `qwen_test_${id}.png`,
    webpFileName: null,
    downloadStartedAt: null,
    ...extra,
  };
}

before(async () => {
  await saveSettings({ relayKey: "test-relay-key" });
});

test("normalizeBackend：只认 colab，其余一律 Kaggle", () => {
  assert.equal(normalizeBackend("colab"), "colab");
  assert.equal(normalizeBackend("kaggle"), "kaggle");
  assert.equal(normalizeBackend(undefined), "kaggle");
  assert.equal(normalizeBackend("bogus"), "kaggle");
});

test("重启后 Colab preparing 单进待确认（不走 Kaggle 的 slug 核查）", async () => {
  resetFake();
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      seedColabJob(90),
      seedColabJob(91),
      seedColabJob(92),
      seedColabJob(93, { status: "preparing", stage: "preparing", colabJobId: null, error: null, finishedAt: null }),
    ]),
    "tianya-imagegen-counter": "93",
  });
  await initJobs();
  stopPolling();
  await sleep(50);
  const job93 = getJobs().find((j) => j.id === 93);
  assert.ok(job93);
  assert.equal(job93.status, "preparing");
  assert.equal(job93.stage, "confirming");
  assert.match(job93.stageDetail, /提交结果未确认/);
  assert.notEqual(job93.status, "failed");
});

test("submitJob backend colab：提交到中转、任务存后端", async () => {
  resetFake();
  const job = await submitJob({ model: "qwen", prompt: "colab submit test", backend: "colab" });
  assert.equal(job.backend, "colab");
  assert.equal(job.kaggleSlug, null);
  assert.equal(job.colabJobId, null);
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "Colab 单进排队",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.ok(cur.colabJobId);
  assert.match(cur.colabJobId, /^cb-test-/);
  assert.equal(cur.stageDetail, "已提交到 Colab 中转，排队中");
  assert.equal(fake.postCalls.length, 1);
  assert.equal(fake.postCalls[0].headers["X-Colab-Key"], "test-relay-key");
  const body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.model, "qwen");
  assert.equal(body.source, "app");
});

test("Colab 单全流程：中转进度进进度环，done 后下 WebP 完成、PNG 后台补上", async () => {
  resetFake();
  const job = getJobs().find((j) => j.backend === "colab" && j.status === "queued");
  assert.ok(job, "上一单 Colab 单还在排队");
  const remote = fakeRelayJob(job.colabJobId);
  remote.status = "running";
  remote.progress = 40;
  remote.stage = "生成中";
  await __tickForTest();
  let cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.status, "running");
  assert.equal(cur.colabProgress, 40);
  assert.match(cur.stageDetail, /Colab：生成中 · 40%/);
  assert.equal(getJobProgress(cur).pct, 53); // 30 + 40% × 58
  remote.status = "done";
  remote.progress = 100;
  await __tickForTest();
  cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.status, "done");
  assert.equal(cur.webpFileName, cur.imageFileName);
  assert.ok(cur.imageFileName.endsWith(".webp"));
  const { data } = await Filesystem.readFile({ path: `images/${cur.imageFileName}`, directory: "DATA" });
  assert.ok(data.length > 0);
  // PNG 后台到了，主图换成 PNG 原图
  await waitFor(() => getJobs().find((j) => j.id === job.id)?.imageFileName.endsWith(".png"), 8000, "PNG 后台补上");
  cur = getJobs().find((j) => j.id === job.id);
  assert.ok(cur.webpFileName.endsWith(".webp"));
});

test("Colab 提交 401：直接判失败、提示核对密钥", async () => {
  resetFake();
  fake.submit = "401";
  const job = await submitJob({ model: "qwen", prompt: "colab 401 test", backend: "colab" });
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "failed",
    8000,
    "401 的单判失败",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.match(cur.error, /中转密钥不对/);
});

test("Colab 提交断网：进待确认、不标失败、不重推", async () => {
  resetFake();
  fake.submit = "down";
  const job = await submitJob({ model: "qwen", prompt: "colab down test", backend: "colab" });
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
  assert.equal(isNetworkDown(), true);
  // 5 分钟窗口过了：判失败，写明核对不了的原因
  cur.verifyDeadlineAt = Date.now() - 1000;
  // 直接改内存里的记录再跑一轮（verifyDeadlineAt 是引擎字段，单测里改内存即可）
  await __tickForTest();
  const after = getJobs().find((j) => j.id === job.id);
  assert.equal(after.status, "failed");
  assert.match(after.error, /无法确认任务是否已建出/);
});

test("retryJob Colab：中转还在跑就恢复旧单、不建新单", async () => {
  resetFake();
  fake.jobs.set("cb-seed-90", { id: "cb-seed-90", status: "running", progress: 60, stage: "生成中" });
  const before = fake.postCalls.length;
  const old = await retryJob(90);
  assert.equal(old.id, 90);
  assert.equal(fake.postCalls.length, before); // 没新开一单
  const cur = getJobs().find((j) => j.id === 90);
  assert.equal(cur.status, "running");
  assert.equal(cur.error, null);
});

test("retryJob Colab：中转已失败就新开一单", async () => {
  resetFake();
  fake.jobs.set("cb-seed-91", { id: "cb-seed-91", status: "failed", error: "daemon crashed" });
  await clearActiveJobs(); // 90 还在跑会占掉 2 并发里的一个，新单启动不了
  const before = fake.postCalls.length;
  const job = await retryJob(91);
  assert.notEqual(job.id, 91);
  assert.equal(job.backend, "colab");
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "重提的新单进排队",
  );
  assert.equal(fake.postCalls.length, before + 1);
});

test("retryJob Colab：中转已跑完就恢复旧单取图", async () => {
  resetFake();
  fake.jobs.set("cb-seed-92", { id: "cb-seed-92", status: "done", progress: 100 });
  const before = fake.postCalls.length;
  const old = await retryJob(92);
  assert.equal(old.id, 92);
  assert.equal(fake.postCalls.length, before);
  const cur = getJobs().find((j) => j.id === 92);
  assert.equal(cur.status, "running");
  assert.match(cur.stageDetail, /正在取图/);
  // 下一轮轮询直接取图
  await __tickForTest();
  const done = getJobs().find((j) => j.id === 92);
  assert.equal(done.status, "done");
});

// 清掉所有活跃单（2 并发满了会让新单卡在本地排队）
async function clearActiveJobs() {
  for (const j of getJobs().filter((x) => ["running", "queued", "preparing", "queued-local", "downloading"].includes(x.status))) {
    await deleteJob(j.id);
  }
}

test("regenerateJob 保持 Colab 后端", async () => {
  resetFake();
  const done = getJobs().find((j) => j.id === 92);
  assert.equal(done.status, "done");
  await clearActiveJobs();
  const job = await regenerateJob(92);
  assert.equal(job.backend, "colab");
  assert.equal(job.regeneratedFrom, 92);
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "重新生成的 Colab 单进排队",
  );
});

test("getJobProgress Colab running：没进度时按 30% 起步", () => {
  const base = {
    backend: "colab",
    status: "running",
    stage: "running",
    model: "qwen",
    width: 1024,
    height: 1536,
    createdAt: Date.now(),
    stageStartedAt: Date.now(),
  };
  assert.equal(getJobProgress({ ...base, colabProgress: null }).pct, 30);
  assert.equal(getJobProgress({ ...base, colabProgress: 100 }).pct, 88);
});

test("refetchJob Colab：downloading 的单重新取图", async () => {
  resetFake();
  await clearActiveJobs();
  const job = await submitJob({ model: "qwen", prompt: "colab refetch test", backend: "colab" });
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "Colab 单进排队",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  fakeRelayJob(cur.colabJobId).status = "done";
  // 人为把单放到 downloading（模拟下载时断网卡住），再点重新取回
  const store = getJobs();
  const inStore = store.find((j) => j.id === job.id);
  inStore.status = "downloading";
  inStore.stage = "downloading";
  const done = await refetchJob(job.id);
  assert.equal(done.status, "done");
  assert.ok(done.imageFileName.endsWith(".webp"));
});

test("Kaggle 单不受影响：没 backend 的老任务仍走 Kaggle 校验", async () => {
  // 老记录没有 backend 字段：normalizeBackend 按 Kaggle 处理，retryJob
  // 会走 Kaggle 的 confirmKernelExists——这里只断言分发本身不走 Colab。
  resetFake();
  const oldStyle = { ...seedColabJob(95), backend: undefined, colabJobId: null };
  assert.equal(normalizeBackend(oldStyle.backend), "kaggle");
  assert.equal(normalizeBackend("colab"), "colab");
  // 清掉本文件跑出来的活跃单，避免影响后续测试的 2 并发
  for (const j of getJobs().filter((x) => ["running", "queued", "preparing", "queued-local", "downloading"].includes(x.status))) {
    await deleteJob(j.id);
  }
});

// --- 超分 SeedVR 3B 开关（v1.2.23）：只管 Colab，默认开；中转收到的
// useUpscale 就是这个开关的值（关 = 底图直接出、不挂放大）。 ---
test("submitJob Colab 3B 开关：默认开，中转收到的 useUpscale 是 true", async () => {
  resetFake();
  await clearActiveJobs();
  const job = await submitJob({ model: "qwen", prompt: "colab 3b default test", backend: "colab" });
  assert.equal(job.backend, "colab");
  assert.equal(job.useColabUpscale, true);
  assert.equal(job.useUpscale, true);
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "Colab 单进排队",
  );
  assert.equal(fake.postCalls.length, 1);
  const body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.useUpscale, true);
});

test("submitJob Colab 3B 开关：关了，中转收到的 useUpscale 是 false", async () => {
  resetFake();
  await clearActiveJobs();
  const job = await submitJob({ model: "qwen", prompt: "colab 3b off test", backend: "colab", useColabUpscale: false });
  assert.equal(job.useColabUpscale, false);
  assert.equal(job.useUpscale, true); // 7B 开关没动，仍是默认开
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "Colab 单进排队",
  );
  assert.equal(fake.postCalls.length, 1);
  const body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.useUpscale, false);
});

test("submitJob Colab 老调用：只传 7B 开关关，3B 跟着关（回退，不丢旧行为）", async () => {
  resetFake();
  await clearActiveJobs();
  const job = await submitJob({ model: "qwen", prompt: "colab old style test", backend: "colab", useUpscale: false });
  assert.equal(job.useUpscale, false);
  assert.equal(job.useColabUpscale, false);
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "Colab 单进排队",
  );
  assert.equal(fake.postCalls.length, 1);
  const body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.useUpscale, false);
});

test("regenerateJob Colab：3B 关保持关（新单按原选择重放，中转收到的也是关）", async () => {
  resetFake();
  await clearActiveJobs();
  const job = await submitJob({ model: "qwen", prompt: "colab regen 3b off test", backend: "colab", useColabUpscale: false });
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "queued",
    8000,
    "Colab 单进排队",
  );
  let body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.useUpscale, false);
  const cur = getJobs().find((j) => j.id === job.id);
  fakeRelayJob(cur.colabJobId).status = "done";
  fakeRelayJob(cur.colabJobId).progress = 100;
  await __tickForTest();
  const done = getJobs().find((j) => j.id === job.id);
  assert.equal(done.status, "done");
  resetFake();
  await clearActiveJobs();
  const regen = await regenerateJob(job.id);
  assert.equal(regen.backend, "colab");
  assert.equal(regen.useColabUpscale, false);
  assert.equal(regen.regeneratedFrom, job.id);
  await waitFor(
    () => getJobs().find((j) => j.id === regen.id)?.status === "queued",
    8000,
    "重新生成的 Colab 单进排队",
  );
  assert.equal(fake.postCalls.length, 1);
  body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.useUpscale, false);
});
