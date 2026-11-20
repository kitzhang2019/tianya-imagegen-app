// tests/jobs-colab-timeout-recovery.test.mjs — v1.2.27：Colab 超时判失败前向中转做
// 最后核对 + 已超时失败的单可恢复 + release 固定文案不再展示成“已重新排队”。
// 真实案例：cb-mwnioez0-4ac4（Krea2，2026-11-19 20:19 提交）因中转 KV list
// 上限卡在排队 6 小时+，App 按 6 小时线判失败停轮询；08:00 上限重置后中转
// 08:03 领走、08:20 跑完，但 App 再也没去查，图没下来。本版修两点：
// ① 超时判失败前先 GET /job/<id> 核对一次，跑完就取图、不判失败；
// ② 已失败的 Colab 单在打开/刷新时再核对一次，跑完就取图回来、不重提。
// 另：中转 release 接口的 note 是固定文案“已重新排队”，两次分配失败后任务
// 其实是 failed——不再原样展示，改成诚实的“已失败、请点重新提交”。
// 全部用桩/模拟，不碰真中转、不取真图、不推画廊。跑法：npm test。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __tickForTest,
  deleteJob,
  getJobs,
  honestColabFailureMessage,
  initJobs,
  saveSettings,
  stopPolling,
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
  jobs: new Map(), // jobId -> { status, progress, stage, error }
  postCalls: [],
  getCalls: [],
};

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = opts?.method || "GET";
  if (u === `${COLAB_RELAY_BASE}/job` && method === "POST") {
    fake.postCalls.push({ headers: opts?.headers || {}, body: opts?.body });
    const body = JSON.parse(opts?.body || "{}");
    const id = `cb-test-${fake.postCalls.length}`;
    fake.jobs.set(id, { id, status: "queued", progress: 0, stage: "排队中", model: body.model });
    return jsonRes(200, { ok: true, job_id: id });
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
  fake.jobs.clear();
  fake.postCalls = [];
  fake.getCalls = [];
}

function seedColabJob(id, extra) {
  return {
    id,
    model: "krea2",
    prompt: `colab timeout recovery test ${id}`,
    ratioKey: "auto",
    width: 1280,
    height: 1600,
    seed: 3000 + id,
    status: "queued",
    stage: "queued",
    backend: "colab",
    colabJobId: `cb-t${id}`,
    colabProgress: null,
    kaggleRef: null,
    kaggleSlug: null,
    createdAt: Date.now(),
    pushedAt: Date.now(),
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: null,
    finishedAt: null,
    error: null,
    imageFileName: `krea2_test_${id}.png`,
    webpFileName: null,
    downloadStartedAt: null,
    colabRecoveryCheckedAt: null,
    ...extra,
  };
}

const SEEDED_IDS = [201, 202, 203, 204, 205, 206];

// 每单测试前：把所有已种子的任务恢复到“不会被本轮轮询误伤”的状态，
// 再由各测试单独配置目标任务。活跃单的中转状态一律设 queued（轮询只
// 更新进度、不判失败）；失败单的恢复核查时间记成现在（本轮不核查），
// 除非测试单独清掉。目标任务的中转状态由各测试在 quarantine 之后覆盖。
function quarantineAll() {
  for (const j of getJobs()) {
    if (j.colabJobId) {
      fake.jobs.set(j.colabJobId, { id: j.colabJobId, status: "queued", progress: 0, stage: "排队中" });
    }
    if (j.status === "failed") {
      j.colabRecoveryCheckedAt = Date.now();
    }
  }
}

function jobById(id) {
  const job = getJobs().find((j) => j.id === id);
  assert.ok(job, `种子任务 #${id} 应在列表里`);
  return job;
}

before(async () => {
  await saveSettings({ relayKey: "test-relay-key" });
  resetFake();
  // 先给所有种子任务配好中转状态，initJobs 触发的首轮轮询才不会 404 误伤
  for (const id of SEEDED_IDS) {
    fake.jobs.set(`cb-t${id}`, { id: `cb-t${id}`, status: "queued", progress: 0, stage: "排队中" });
  }
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      seedColabJob(201),
      seedColabJob(202),
      seedColabJob(203, { status: "failed", stage: "failed", error: "云端排队超过 6 小时仍没开始，已自动结束。", finishedAt: Date.now() }),
      seedColabJob(204, { status: "failed", stage: "failed", error: "云端排队超过 6 小时仍没开始，已自动结束。", finishedAt: Date.now() }),
      seedColabJob(205),
      seedColabJob(206, { status: "running", stage: "running" }),
    ]),
    "tianya-imagegen-counter": "206",
  });
  await initJobs();
  stopPolling();
  await sleep(200); // 等 initJobs 触发的首轮轮询跑完，再开始各测试
});

test("honestColabFailureMessage：release 固定文案不展示成已重排", () => {
  // 真实文案：2026-11-20 06:33 古风 Krea2 单 cb-mwo4mkf2-17ab 两次 T4 503 后
  const msg = honestColabFailureMessage("Colab 未能分配 T4（503/容量不足），已重新排队");
  assert.doesNotMatch(msg, /已重新排队/);
  assert.match(msg, /T4（503\/容量不足）/);
  assert.match(msg, /任务已失败/);
  assert.match(msg, /重新提交/);
  // release 没带 note 时中转的默认 error
  const msg2 = honestColabFailureMessage("released too many times");
  assert.doesNotMatch(msg2, /已重新排队/);
  assert.match(msg2, /任务已失败/);
  assert.match(msg2, /重新提交/);
  // 只有“已重新排队”、没有原因时也不展示它
  const msg3 = honestColabFailureMessage("已重新排队");
  assert.doesNotMatch(msg3, /已重新排队。/);
  assert.match(msg3, /任务已失败/);
  // 普通失败原因原样保留（只加前缀）
  assert.equal(honestColabFailureMessage("daemon crashed"), "Colab 中转：daemon crashed");
  // 空原因给默认文案
  assert.equal(honestColabFailureMessage(""), "Colab 中转返回失败（没给具体原因）。");
  assert.equal(honestColabFailureMessage(null), "Colab 中转返回失败（没给具体原因）。");
});

test("超时最后核对：排队超 6 小时、中转说已跑完 -> 取图完成、不判失败、不重提", async () => {
  resetFake();
  quarantineAll();
  const job = jobById(201);
  job.status = "queued";
  job.stage = "queued";
  job.createdAt = Date.now() - 7 * 3600 * 1000; // 排队 7 小时，已超 6 小时线
  fake.jobs.set("cb-t201", { id: "cb-t201", status: "done", progress: 100, stage: "已完成" });
  const postBefore = fake.postCalls.length;
  await __tickForTest();
  const cur = jobById(201);
  assert.equal(cur.status, "done");
  // WebP 先行已存好（webpFileName）；后台 PNG 可能随后把主图 imageFileName
  // 换成 .png，所以不直接断言 imageFileName 的后缀
  assert.ok(cur.webpFileName.endsWith(".webp"));
  const { data } = await Filesystem.readFile({ path: `images/${cur.webpFileName}`, directory: "DATA" });
  assert.ok(data.length > 0);
  assert.equal(fake.postCalls.length, postBefore); // 没重新提交
});

test("超时最后核对：排队超 6 小时、中转也确认没跑完 -> 才判失败", async () => {
  resetFake();
  quarantineAll();
  const job = jobById(202);
  job.status = "queued";
  job.stage = "queued";
  job.createdAt = Date.now() - 7 * 3600 * 1000;
  fake.jobs.set("cb-t202", { id: "cb-t202", status: "queued", progress: 0, stage: "排队中" });
  const postBefore = fake.postCalls.length;
  await __tickForTest();
  const cur = jobById(202);
  assert.equal(cur.status, "failed");
  assert.match(cur.error, /云端排队超过 6 小时/);
  assert.equal(fake.postCalls.length, postBefore);
});

test("超时最后核对：生成超 2 小时、中转说已跑完 -> 取图完成、不判失败", async () => {
  resetFake();
  quarantineAll();
  const job = jobById(206);
  job.status = "running";
  job.stage = "running";
  job.stageStartedAt = Date.now() - 3 * 3600 * 1000; // 生成 3 小时，已超 2 小时线
  fake.jobs.set("cb-t206", { id: "cb-t206", status: "done", progress: 100, stage: "已完成" });
  const postBefore = fake.postCalls.length;
  await __tickForTest();
  const cur = jobById(206);
  assert.equal(cur.status, "done");
  assert.ok(cur.webpFileName.endsWith(".webp"));
  assert.equal(fake.postCalls.length, postBefore);
});

test("已失败单恢复：超时判失败后中转跑完了，刷新一次就取图回来、不重提", async () => {
  resetFake();
  quarantineAll();
  const job = jobById(203);
  assert.equal(job.status, "failed");
  job.colabRecoveryCheckedAt = null; // 清掉节流，本轮允许核对
  fake.jobs.set("cb-t203", { id: "cb-t203", status: "done", progress: 100, stage: "已完成" });
  const postBefore = fake.postCalls.length;
  await __tickForTest();
  const cur = jobById(203);
  assert.equal(cur.status, "done");
  assert.ok(cur.webpFileName.endsWith(".webp"));
  const { data } = await Filesystem.readFile({ path: `images/${cur.webpFileName}`, directory: "DATA" });
  assert.ok(data.length > 0);
  assert.equal(fake.postCalls.length, postBefore); // 没重新提交、没新开一单
});

test("已失败单恢复：中转还没跑完 -> 保持失败、不重提、记一次核查时间", async () => {
  resetFake();
  quarantineAll();
  const job = jobById(204);
  assert.equal(job.status, "failed");
  job.colabRecoveryCheckedAt = null;
  fake.jobs.set("cb-t204", { id: "cb-t204", status: "queued", progress: 0, stage: "排队中" });
  const postBefore = fake.postCalls.length;
  await __tickForTest();
  const cur = jobById(204);
  assert.equal(cur.status, "failed");
  assert.equal(fake.postCalls.length, postBefore);
  assert.ok(typeof cur.colabRecoveryCheckedAt === "number" && cur.colabRecoveryCheckedAt > 0);
});

test("文案端到端：中转 failed 带 release 固定文案 -> 任务失败文案里没有“已重新排队”", async () => {
  resetFake();
  quarantineAll();
  const job = jobById(205);
  job.status = "queued";
  job.stage = "queued";
  job.createdAt = Date.now(); // 没超时，走正常轮询的 failed 分支
  fake.jobs.set("cb-t205", {
    id: "cb-t205",
    status: "failed",
    error: "Colab 未能分配 T4（503/容量不足），已重新排队",
  });
  await __tickForTest();
  const cur = jobById(205);
  assert.equal(cur.status, "failed");
  assert.doesNotMatch(cur.error, /已重新排队/);
  assert.match(cur.error, /T4（503\/容量不足）/);
  assert.match(cur.error, /任务已失败/);
  assert.match(cur.error, /重新提交/);
});
