// tests/jobs-foreground-refresh.test.mjs — 切回前台立刻刷新任务状态：
// iOS 切到后台会挂起定时器，轮询停掉；回来只靠 20 秒定时器要等下一轮，
// 切回来马上跑一轮 refreshJobsNow，状态立刻跟上；已有轮询在跑时第二次
// 调用跳过，不重复发请求。跑法：npm test。fetch 桩模拟 Kaggle API。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import {
  getJobs,
  initJobs,
  refreshJobsNow,
  stopPolling,
} from "../src/lib/jobs.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  stopPolling();
  __resetStore();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let statusCalls = 0;
let statusDelayMs = 0;

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
    statusCalls += 1;
    if (statusDelayMs) await sleep(statusDelayMs);
    return jsonRes(200, { status: "RUNNING" });
  }
  if (u.includes("ListKernelSessionOutput")) {
    return jsonRes(200, { files: [], nextPageToken: null });
  }
  if (u.includes("kernels/list")) {
    return jsonRes(200, []);
  }
  throw new Error(`测试桩没预料到的请求：${u}`);
};

function seedJob(id) {
  return {
    id,
    model: "qwen",
    prompt: `foreground refresh test ${id}`,
    ratioKey: "auto",
    width: 1024,
    height: 1536,
    seed: 3000 + id,
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
    imageFileName: `qwen_fg_${id}.png`,
    queueCheckAt: null,
    queueCheckNote: null,
  };
}

test("refreshJobsNow 立刻跑一轮轮询，排队单变 running", async () => {
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([seedJob(201)]),
    "tianya-imagegen-counter": "201",
  });
  await initJobs();
  stopPolling();
  await refreshJobsNow(); // 先等 startPolling 那轮跑完，避免和下面的计数抢
  statusCalls = 0;
  const job0 = getJobs().find((j) => j.id === 201);
  assert.equal(job0.status, "running");
  await refreshJobsNow(); // 再跑一轮，确认状态接口真的被调到
  const job = getJobs().find((j) => j.id === 201);
  assert.equal(job.status, "running");
  assert.match(job.stageDetail || "", /云端正在生成/);
  assert.ok(statusCalls >= 1, "应至少调一次状态接口");
});

test("已有轮询在跑时，第二次 refreshJobsNow 跳过不重复发请求", async () => {
  statusDelayMs = 120;
  statusCalls = 0;
  const p1 = refreshJobsNow();
  const p2 = refreshJobsNow();
  await Promise.all([p1, p2]);
  assert.equal(statusCalls, 1, "慢的那轮状态接口只应被调一次");
  statusDelayMs = 0;
  const job = getJobs().find((j) => j.id === 201);
  assert.equal(job.status, "running");
});
