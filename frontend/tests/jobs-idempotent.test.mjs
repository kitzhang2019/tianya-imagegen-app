// tests/jobs-idempotent.test.mjs — 提交幂等测试：固定 slug、push 丢回包进待确认、
// 重连后查状态恢复、已有运行中 kernel 时不二次 push、断网横条状态。
// 跑法：npm test。fetch 桩模拟 Kaggle API：模板读磁盘真文件，
// GetKernelSessionStatus / kernels/push / kernels/list 按 fake 的设定应答。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import {
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
import { KaggleClient } from "../src/lib/kaggle.js";

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

// 可编程的云端行为（每个测试按需改）
const fake = {
  status: "down", // "down"（断网）| "absent"（404）| "running" | "queued" | "forbidden"（状态接口 403）
  list: [], // kernels/list 返回的 ref 列表
  push: "ok", // "ok" | "down"（push 请求发出去但回包丢了）
  pushCalls: [], // 记录每次真正发出的 push 的 slug
  deleteCalls: [], // v1.2.25：删任务先调 DeleteKernel 取消云端 kernel
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
  if (u.includes("GetKernelSessionStatus")) {
    if (fake.status === "down") throw new TypeError("fetch failed");
    if (fake.status === "running") return jsonRes(200, { status: "RUNNING" });
    if (fake.status === "queued") return jsonRes(200, { status: "QUEUED" });
    if (fake.status === "forbidden") {
      // Kaggle 对不存在的 kernel 查状态回 403（不是 404）
      return jsonRes(403, { error: { code: 403, message: "Permission 'kernels.get' was denied", status: "PERMISSION_DENIED" } });
    }
    // 默认：只有推过才算存在（模拟 kernel 建出后状态接口才跟得上）
    if (fake.pushCalls.length > 0) return jsonRes(200, { status: "RUNNING" });
    return jsonRes(404, { error: "not found" });
  }
  if (u.includes("DeleteKernel")) {
    const body = JSON.parse(opts?.body || "{}");
    fake.deleteCalls.push(body);
    return jsonRes(200, {});
  }
  if (u.includes("/kernels/push")) {
    if (fake.push === "down") throw new TypeError("fetch failed");
    const body = JSON.parse(opts?.body || "{}");
    fake.pushCalls.push(body.slug);
    return jsonRes(200, { ref: body.slug, versionNumber: 1, url: `https://www.kaggle.com/code/${body.slug}` });
  }
  if (u.includes("kernels/list")) {
    if (fake.status === "down") throw new TypeError("fetch failed");
    return jsonRes(200, fake.list.map((ref) => ({ ref })));
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

test("重启后 preparing 任务进待确认，不直接失败", async () => {
  // 预置：三条已失败的旧单（给后面 retryJob 用）+ 一条重启时中断在准备阶段的单。
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      seedJob(90),
      seedJob(91),
      seedJob(92),
      seedJob(93, { status: "preparing", stage: "preparing", error: null, finishedAt: null }),
    ]),
    "tianya-imagegen-counter": "93",
  });
  await saveSettings({ kaggleUsername: "u", kaggleToken: "t", galleryKey: "", galleryUrl: "" });
  // fake.status 默认 "down"：重启后的轮询查不到云端，只能进待确认，不能判失败、不能重推。
  await initJobs();
  stopPolling();
  await sleep(50); // 让 initJobs 里那轮 tick 跑完
  const job93 = getJobs().find((j) => j.id === 93);
  assert.ok(job93);
  assert.equal(job93.status, "preparing");
  assert.equal(job93.stage, "confirming");
  assert.notEqual(job93.status, "failed");
  assert.equal(isNetworkDown(), true);
  assert.equal(netEvents[netEvents.length - 1], true);
});

test("提交即固定 slug：app- 前缀，与管理站区分", async () => {
  fake.status = "absent";
  fake.list = [];
  fake.push = "ok";
  fake.pushCalls = [];
  const job = await submitJob({ model: "qwen", prompt: "idempotent test 1" });
  assert.equal(job.kaggleSlug, `app-qwen-comfyui-kaggle-${job.id}`);
  await waitFor(
    () => getJobs().find((j) => j.id === job.id)?.status === "running",
    5000,
    "新单跑到 running",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.kaggleRef, `u/app-qwen-comfyui-kaggle-${job.id}`);
  assert.equal(fake.pushCalls.length, 1);
  assert.equal(fake.pushCalls[0], `u/app-qwen-comfyui-kaggle-${job.id}`);
  assert.equal(isNetworkDown(), false);
});

test("push 回包丢失：任务进待确认，不标失败", async () => {
  // 先把前面测试留下的活跃任务清掉，否则 2 并发满了、新单进不了 pumpQueue。
  for (const j of getJobs().filter((x) => x.status === "running" || x.status === "preparing" || x.status === "queued-local")) {
    await deleteJob(j.id);
  }
  fake.status = "absent";
  fake.list = [];
  fake.push = "down"; // push 请求发出去但回包丢了（代理断开）
  fake.pushCalls = [];
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

test("重连后查状态恢复：不再二次 push", async () => {
  // 网络恢复，云端其实已建出 kernel（push 请求当时已到云端，只是回包丢了）。
  fake.status = "running";
  fake.push = "ok";
  const pushCallsBefore = fake.pushCalls.length;
  await __tickForTest();
  await waitFor(
    () => getJobs().find((j) => j.prompt === "idempotent test 2")?.status === "running",
    5000,
    "丢回包的单重连后恢复 running",
  );
  const cur = getJobs().find((j) => j.prompt === "idempotent test 2");
  assert.equal(cur.kaggleRef, `u/app-qwen-comfyui-kaggle-${cur.id}`);
  assert.equal(fake.pushCalls.length, pushCallsBefore); // 没再 push
  assert.equal(isNetworkDown(), false);
  assert.equal(netEvents[netEvents.length - 1], false);
});

test("retryJob：云端已有这单在跑，恢复旧单、不二次 push", async () => {
  fake.status = "running";
  fake.push = "ok";
  fake.pushCalls = [];
  const before = getJobs().length;
  const retried = await retryJob(90);
  assert.equal(retried.id, 90); // 恢复的是旧单，不是新单
  assert.equal(getJobs().length, before); // 没建新任务
  await waitFor(
    () => getJobs().find((j) => j.id === 90)?.status === "running",
    5000,
    "旧单恢复 running",
  );
  assert.equal(fake.pushCalls.length, 0); // 没 push
  const cur = getJobs().find((j) => j.id === 90);
  assert.equal(cur.kaggleRef, "u/app-qwen-comfyui-kaggle-90");
});

test("retryJob：确认云端没有时才建新任务，复用同一个 slug", async () => {
  // 先把占着 2 并发的运行中/本地排队任务清掉，否则新单进不了 pumpQueue。
  for (const j of getJobs().filter((x) => x.status === "running" || x.status === "preparing" || x.status === "queued-local")) {
    await deleteJob(j.id);
  }
  fake.status = "absent";
  fake.list = [];
  fake.push = "ok";
  fake.pushCalls = [];
  const before = getJobs().length;
  const retried = await retryJob(91);
  assert.notEqual(retried.id, 91);
  assert.equal(retried.kaggleSlug, "app-qwen-comfyui-kaggle-91"); // 复用旧 slug
  assert.equal(getJobs().length, before + 1);
  await waitFor(
    () => getJobs().find((j) => j.id === retried.id)?.status === "running",
    5000,
    "新单跑到 running",
  );
  assert.equal(fake.pushCalls.length, 1);
  assert.equal(fake.pushCalls[0], "u/app-qwen-comfyui-kaggle-91");
});

test("retryJob：网络未恢复时不建新任务", async () => {
  fake.status = "down";
  fake.push = "down";
  fake.pushCalls = [];
  const before = getJobs().length;
  await assert.rejects(() => retryJob(92), /网络还没恢复/);
  assert.equal(getJobs().length, before);
  assert.equal(fake.pushCalls.length, 0);
  assert.equal(isNetworkDown(), true);
});

test("confirmKernelExists：状态接口 403 + 列表里没有 = 确认不存在，可以推", async () => {
  const client = new KaggleClient({ username: "u", key: "t" });
  fake.status = "forbidden";
  fake.list = [];
  const res = await client.confirmKernelExists("u/app-qwen-comfyui-kaggle-999");
  assert.equal(res.exists, false);
  assert.equal(res.inconclusive, false);
  // 列表本身读不到时仍不可确认
  fake.status = "down";
  const down = await client.confirmKernelExists("u/app-qwen-comfyui-kaggle-999");
  assert.equal(down.exists, false);
  assert.equal(down.inconclusive, true);
});

test("confirmKernelExists：404=确认不存在，断网=不可确认", async () => {
  const client = new KaggleClient({ username: "u", key: "t" });
  fake.status = "absent";
  fake.list = [];
  const absent = await client.confirmKernelExists("u/app-qwen-comfyui-kaggle-999");
  assert.equal(absent.exists, false);
  assert.equal(absent.inconclusive, false);
  fake.status = "down";
  const down = await client.confirmKernelExists("u/app-qwen-comfyui-kaggle-999");
  assert.equal(down.exists, false);
  assert.equal(down.inconclusive, true);
  fake.status = "running";
  const running = await client.confirmKernelExists("u/app-qwen-comfyui-kaggle-999");
  assert.equal(running.exists, true);
  assert.equal(running.inconclusive, false);
});
