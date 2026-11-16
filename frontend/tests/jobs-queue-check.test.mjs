// tests/jobs-queue-check.test.mjs — 排队超时自动核查测试：进排队超 30 分钟
// 才核查（绝对时长，四模型统一；不再按预估总时长算）、三种核查结论的
// 括号备注文案、未超时不核查、10 分钟内不重复核查、10 分钟后刷新、
// 离开排队后停止刷新；上次核查时间随任务持久化。
// 跑法：npm test。fetch 桩模拟 Kaggle API：GetKernelSessionStatus /
// ListKernelSessionOutput 按 fake 的设定应答。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __readStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import {
  QUEUE_CHECK_AFTER_MS,
  __tickForTest,
  deleteJob,
  estimateTotalMs,
  formatQueueCheckNote,
  getJobs,
  initJobs,
  isQueueOverdue,
  performQueueCheck,
  saveSettings,
  stopPolling,
} from "../src/lib/jobs.js";
import { KaggleClient } from "../src/lib/kaggle.js";

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
  stopPolling();
  __resetStore();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 可编程的云端行为（每个测试按需改）
const fake = {
  status: "queued", // "queued" | "running" | "unknown"（不认识的状态值）| "down"（断网）
  outputFiles: [], // ListKernelSessionOutput 第一页返回的文件
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

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("GetKernelSessionStatus")) {
    if (fake.status === "down") throw new TypeError("fetch failed");
    if (fake.status === "running") return jsonRes(200, { status: "RUNNING" });
    if (fake.status === "queued") return jsonRes(200, { status: "QUEUED" });
    if (fake.status === "unknown") return jsonRes(200, { status: "SOMETHING_ELSE" });
    return jsonRes(404, { error: "not found" });
  }
  if (u.includes("ListKernelSessionOutput")) {
    if (fake.status === "down") throw new TypeError("fetch failed");
    return jsonRes(200, { files: fake.outputFiles, nextPageToken: null });
  }
  if (u.includes("kernels/list")) {
    return jsonRes(200, []);
  }
  throw new Error(`测试桩没预料到的请求：${u}`);
};

function seedJob(id, extra) {
  return {
    id,
    model: "qwen",
    prompt: `queue check test ${id}`,
    ratioKey: "auto",
    width: 1024,
    height: 1536,
    seed: 2000 + id,
    status: "queued",
    stage: "queued",
    stageDetail: "云端排队中",
    kaggleRef: `u/app-qwen-comfyui-kaggle-${id}`,
    kaggleSlug: `app-qwen-comfyui-kaggle-${id}`,
    createdAt: Date.now(),
    pushedAt: Date.now(),
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: null,
    finishedAt: null,
    error: null,
    imageFileName: `qwen_test_${id}.png`,
    queueCheckAt: null,
    queueCheckNote: null,
    ...extra,
  };
}

function jobById(id) {
  return getJobs().find((j) => j.id === id);
}

/** 持久化下来的任务记录（Preferences 里那份），用来断言上次核查时间真的存盘了。 */
function persistedJobById(id) {
  const raw = __readStore("tianya-imagegen-jobs");
  const list = raw ? JSON.parse(raw) : [];
  return list.find((j) => j.id === id);
}

/** 把一单改成“进排队 31 分钟”：超过 30 分钟触发线（正好 30 分钟不触发，
 * 判定是严格大于）。 */
function makeOverdue(id) {
  const job = jobById(id);
  const past = Date.now() - 31 * 60 * 1000;
  job.createdAt = past;
  job.pushedAt = past;
  job.stageStartedAt = past;
  return job;
}

// 2026-11-15 12:36 UTC = 北京时间 20:36，文案里的时间必须是这个。
const FIXED_TS = Date.UTC(2026, 10, 15, 12, 36, 0);

test("括号备注文案：四种结论 + 北京时间", () => {
  assert.equal(formatQueueCheckNote("queued", FIXED_TS), "（20:36 自动核查：仍在排队）");
  assert.equal(formatQueueCheckNote("running", FIXED_TS), "（20:36 自动核查：已在生成）");
  assert.equal(formatQueueCheckNote("has-output", FIXED_TS), "（20:36 自动核查：已有输出文件）");
  assert.equal(
    formatQueueCheckNote("queued-no-output", FIXED_TS),
    "（20:36 自动核查：仍在排队，暂无输出文件）",
  );
});

test("isQueueOverdue：只看排队阶段 + 进排队超 30 分钟（绝对时长）", () => {
  const now = Date.now();
  assert.equal(QUEUE_CHECK_AFTER_MS, 30 * 60 * 1000);
  // 预估算法口径：qwen 1024×1536 的预估总时长约 9 分钟（生成约 4 分钟 +
  // 排队留量 5 分钟）；生成段按 2026-11-15 实测重标过（2048×3072 约 16 分钟），
  // 不再拿预估当核查触发条件（Live Activities 的预计完成时间照旧用它）
  const est = estimateTotalMs({ model: "qwen", width: 1024, height: 1536 });
  assert.ok(est > 8 * 60 * 1000 && est < 10 * 60 * 1000);
  const base = { model: "qwen", width: 1024, height: 1536, stage: "queued" };
  // 29 分钟不核查，31 分钟核查；正好 30 分钟也不触发（严格大于）
  assert.equal(isQueueOverdue({ ...base, stageStartedAt: now - 29 * 60 * 1000 }, now), false);
  assert.equal(isQueueOverdue({ ...base, stageStartedAt: now - 30 * 60 * 1000 }, now), false);
  assert.equal(isQueueOverdue({ ...base, stageStartedAt: now - 31 * 60 * 1000 }, now), true);
  // 进排队时间以 stageStartedAt 为准：提交 60 分钟前、进排队才 10 分钟，不核查
  assert.equal(
    isQueueOverdue(
      { ...base, createdAt: now - 60 * 60 * 1000, stageStartedAt: now - 10 * 60 * 1000 },
      now,
    ),
    false,
  );
  // 老任务没有 stageStartedAt 时退回 createdAt
  assert.equal(
    isQueueOverdue({ ...base, createdAt: now - 31 * 60 * 1000, stageStartedAt: undefined }, now),
    true,
  );
  // 不在排队阶段：再久也不核查
  assert.equal(isQueueOverdue({ ...base, stage: "running", stageStartedAt: now - 31 * 60 * 1000 }, now), false);
  assert.equal(isQueueOverdue({ ...base, stage: "queued-local", stageStartedAt: now - 31 * 60 * 1000 }, now), false);
  // MOSS 2:3 一单预估约 51 分钟（2026-11-16 底图改 1280 后，实测约 46 分钟
  // 生成 + 5 分钟排队留量）：以前排队 50 分钟触发不了（50 < 51），现在
  // 31 分钟就能触发（绝对 30 分钟规则）。
  const moss = { model: "moss", width: 2560, height: 3840, stage: "queued" };
  assert.ok(estimateTotalMs(moss) > 50 * 60 * 1000);
  assert.equal(isQueueOverdue({ ...moss, stageStartedAt: now - 50 * 60 * 1000 }, now), true);
});

test("预置任务并启动轮询", async () => {
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      seedJob(101), // 未超时不核查
      seedJob(102), // 超时触发：仍在排队
      seedJob(103), // 未知状态 + 有输出文件
      seedJob(104), // 未知状态 + 无输出文件
      seedJob(105), // performQueueCheck 直接调用
      seedJob(106), // 10 分钟后刷新 + 离开排队后停止
      seedJob(107), // 10 分钟内不重复核查
    ]),
    "tianya-imagegen-counter": "107",
  });
  await saveSettings({ kaggleUsername: "u", kaggleToken: "t", galleryKey: "", galleryUrl: "" });
  fake.status = "queued";
  fake.outputFiles = [];
  await initJobs();
  stopPolling();
  await sleep(50); // 让 initJobs 里那轮 tick 跑完（都未超时，不应写任何备注）
  for (const id of [101, 102, 103, 104, 105, 106, 107]) {
    const job = jobById(id);
    assert.ok(job, `job ${id} 应在`);
    assert.equal(job.queueCheckAt, null);
    assert.doesNotMatch(job.stageDetail || "", /自动核查/);
  }
});

test("未超时不核查", async () => {
  fake.status = "queued";
  fake.outputFiles = [];
  await __tickForTest();
  const job = jobById(101); // createdAt 就是现在，进排队才 0 分钟，远没到 30 分钟
  assert.equal(job.status, "queued");
  assert.equal(job.queueCheckAt, null);
  assert.equal(job.queueCheckNote, null);
  assert.doesNotMatch(job.stageDetail || "", /自动核查/);
});

test("超时触发核查：状态认出是排队 → 仍在排队，时间随任务持久化", async () => {
  fake.status = "queued";
  fake.outputFiles = [];
  makeOverdue(102);
  await __tickForTest();
  const job = jobById(102);
  assert.equal(job.status, "queued");
  assert.match(job.stageDetail, /（\d{2}:\d{2} 自动核查：仍在排队）/);
  assert.ok(typeof job.queueCheckAt === "number" && Date.now() - job.queueCheckAt < 60 * 1000);
  assert.ok(job.stageDetail.endsWith(job.queueCheckNote)); // 备注是进度说明的最后一节，只一条
  // 持久化那份里也有上次核查时间与备注，不只放内存
  const saved = persistedJobById(102);
  assert.equal(saved.queueCheckAt, job.queueCheckAt);
  assert.equal(saved.queueCheckNote, job.queueCheckNote);
  // 下一轮 tick（10 分钟内）：不重复核查，备注原样保留在进度里
  const checkedAt = job.queueCheckAt;
  const note = job.queueCheckNote;
  await __tickForTest();
  const again = jobById(102);
  assert.equal(again.queueCheckAt, checkedAt);
  assert.equal(again.queueCheckNote, note);
  assert.match(again.stageDetail, /自动核查：仍在排队/);
});

test("10 分钟内不重复核查：上次备注原样保留", async () => {
  fake.status = "queued";
  fake.outputFiles = [];
  const job = makeOverdue(107);
  const checkedAt = Date.now() - 5 * 60 * 1000;
  job.queueCheckAt = checkedAt;
  job.queueCheckNote = "（20:00 自动核查：仍在排队）";
  await __tickForTest();
  const cur = jobById(107);
  assert.equal(cur.queueCheckAt, checkedAt);
  assert.equal(cur.queueCheckNote, "（20:00 自动核查：仍在排队）");
  assert.match(cur.stageDetail, /（20:00 自动核查：仍在排队）/);
});

test("performQueueCheck：三种核查结论", async () => {
  const client = new KaggleClient({ username: "u", key: "t" });
  const job = jobById(105);
  // 状态接口直接认出是排队：不用查输出列表
  assert.equal(await performQueueCheck(job, client, "queued"), "queued");
  // 状态接口认出是在生成
  fake.status = "running";
  assert.equal(await performQueueCheck(job, client, "unknown"), "running");
  // 状态接口不认识：查输出列表，有文件 → 已有输出文件
  fake.status = "unknown";
  fake.outputFiles = [{ fileName: "something.png", url: "https://example.com/something.png" }];
  assert.equal(await performQueueCheck(job, client, "unknown"), "has-output");
  // 状态接口不认识：输出列表是空的 → 仍在排队，暂无输出文件
  fake.outputFiles = [];
  assert.equal(await performQueueCheck(job, client, "unknown"), "queued-no-output");
  // 两边都问不到：返回 null，不记时间不写备注
  fake.status = "down";
  assert.equal(await performQueueCheck(job, client, "unknown"), null);
});

test("未知状态 + 有输出文件 → 已有输出文件", async () => {
  fake.status = "unknown";
  fake.outputFiles = [{ fileName: "something.png", url: "https://example.com/something.png" }];
  makeOverdue(103);
  await __tickForTest();
  const job = jobById(103);
  assert.equal(job.status, "queued");
  assert.match(job.stageDetail, /自动核查：已有输出文件/);
  assert.ok(job.queueCheckAt);
});

test("未知状态 + 无输出文件 → 仍在排队，暂无输出文件", async () => {
  fake.status = "unknown";
  fake.outputFiles = [];
  makeOverdue(104);
  await __tickForTest();
  const job = jobById(104);
  assert.equal(job.status, "queued");
  assert.match(job.stageDetail, /自动核查：仍在排队，暂无输出文件/);
  assert.ok(job.queueCheckAt);
});

test("10 分钟后刷新备注；离开排队后停止刷新", async () => {
  fake.status = "queued";
  fake.outputFiles = [];
  const job = makeOverdue(106);
  job.queueCheckAt = Date.now() - 11 * 60 * 1000;
  job.queueCheckNote = "（19:00 自动核查：仍在排队）";
  await __tickForTest();
  const refreshed = jobById(106);
  assert.ok(refreshed.queueCheckAt > Date.now() - 60 * 1000); // 重新核查过
  assert.notEqual(refreshed.queueCheckNote, "（19:00 自动核查：仍在排队）");
  assert.match(refreshed.stageDetail, /自动核查：仍在排队/);
  // 离开排队：状态接口说在生成，任务进 running；备注不再更新
  fake.status = "running";
  await __tickForTest();
  const running = jobById(106);
  assert.equal(running.status, "running");
  assert.equal(running.stage, "running");
  assert.equal(running.queueCheckAt, refreshed.queueCheckAt);
  assert.equal(running.queueCheckNote, refreshed.queueCheckNote);
  assert.doesNotMatch(running.stageDetail || "", /自动核查/);
  // 再跑一轮：上次核查时间纹丝不动
  await __tickForTest();
  assert.equal(jobById(106).queueCheckAt, refreshed.queueCheckAt);
  // 收尾：把这轮被带进 running 的其他测试单清掉，不影响别的测试文件
  for (const j of getJobs().filter((x) => x.status === "running")) {
    await deleteJob(j.id);
  }
});
