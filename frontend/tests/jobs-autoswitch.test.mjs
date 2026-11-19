// tests/jobs-autoswitch.test.mjs — Kaggle 队列满自动切 Colab 测试：
// 队列满（Kaggle 原文 "Maximum batch GPU session count of 2 reached"）
// → 同一单改走 Colab 重提（只切一次）；Colab 未配密钥不切；其他错误不切。
// 跑法：npm test。fetch 桩同时模拟 Kaggle API 与 Colab 中转。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __tickForTest,
  getJobs,
  initJobs,
  saveSettings,
  stopPolling,
  submitJob,
} from "../src/lib/jobs.js";
import { isKaggleQueueFullErrorText } from "../src/lib/kaggle.js";
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

// 可编程的云端行为（每个测试按需改）
const fake = {
  push: "queue-full", // "queue-full" | "401" | "ok"
  pushCalls: [],
  submit: "ok", // "ok" | "401" | "down"
  jobs: new Map(), // colab jobId -> { status, progress, stage, error }
  postCalls: [],
  getCalls: [],
};

function fakeRelayJob(id) {
  if (!fake.jobs.has(id)) fake.jobs.set(id, { id, status: "queued", progress: 0, stage: "排队中" });
  return fake.jobs.get(id);
}

function resetFake() {
  fake.push = "queue-full";
  fake.pushCalls = [];
  fake.submit = "ok";
  fake.jobs.clear();
  fake.postCalls = [];
  fake.getCalls = [];
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = opts?.method || "GET";
  if (u.includes("notebooks/")) return textRes(200, qwenTemplate);
  if (u.includes("GetKernelSessionStatus")) {
    return jsonRes(404, { error: "not found" });
  }
  if (u.includes("/kernels/push")) {
    const body = JSON.parse(opts?.body || "{}");
    fake.pushCalls.push(body.slug);
    if (fake.push === "queue-full") {
      // Kaggle 队列满的实测拒法：403 + 原文
      return jsonRes(403, { message: "Maximum batch GPU session count of 2 reached" });
    }
    if (fake.push === "401") {
      return jsonRes(401, { message: "Invalid credentials" });
    }
    return jsonRes(200, { ref: body.slug, versionNumber: 1, url: `https://www.kaggle.com/code/${body.slug}` });
  }
  if (u.includes("kernels/list")) {
    return jsonRes(200, []);
  }
  if (u === `${COLAB_RELAY_BASE}/job` && method === "POST") {
    fake.postCalls.push({ headers: opts?.headers || {}, body: opts?.body });
    if (fake.submit === "down") throw new TypeError("fetch failed");
    if (fake.submit === "401") return jsonRes(401, { ok: false, error: "unauthorized" });
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

before(async () => {
  await saveSettings({ kaggleUsername: "u", kaggleToken: "t", relayKey: "test-relay-key" });
});

test("isKaggleQueueFullErrorText：只认队列满原文", () => {
  assert.equal(isKaggleQueueFullErrorText("Maximum batch GPU session count of 2 reached"), true);
  assert.equal(
    isKaggleQueueFullErrorText("Kaggle API 返回 403：Maximum batch GPU session count of 2 reached。常见原因是 Kaggle 账号还没做手机号验证。"),
    true,
  );
  assert.equal(isKaggleQueueFullErrorText("maximum batch gpu session count of 2 reached"), true);
  assert.equal(isKaggleQueueFullErrorText("Kaggle API 拒绝了凭据（401：Invalid credentials）。"), false);
  assert.equal(isKaggleQueueFullErrorText("连不上 Kaggle API（推送 kernel）：fetch failed"), false);
  assert.equal(isKaggleQueueFullErrorText(""), false);
  assert.equal(isKaggleQueueFullErrorText(null), false);
});

test("已切过的单再遇队列满不重切：直接失败、后端仍是 Kaggle", async () => {
  resetFake();
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      {
        id: 201,
        model: "qwen",
        prompt: "autoswitch guard 201",
        ratioKey: "auto",
        width: 1024,
        height: 1536,
        seed: 2201,
        status: "queued-local",
        stage: "queued-local",
        backend: "kaggle",
        autoSwitchedToColab: true, // 已切过一次
        kaggleRef: null,
        kaggleSlug: "app-qwen-comfyui-kaggle-201",
        createdAt: Date.now(),
        pushedAt: null,
        verifyDeadlineAt: null,
        stageStartedAt: Date.now(),
        runningStartedAt: null,
        finishedAt: null,
        error: null,
        imageFileName: "qwen_test_201.png",
        webpFileName: null,
        downloadStartedAt: null,
        colabJobId: null,
        colabProgress: null,
      },
    ]),
    "tianya-imagegen-counter": "201",
  });
  await initJobs();
  await waitFor(() => getJobs().find((j) => j.id === 201)?.status === "failed", 8000, "已切过的单判失败");
  const cur = getJobs().find((j) => j.id === 201);
  assert.equal(cur.backend, "kaggle");
  assert.equal(cur.autoSwitchedToColab, true);
  assert.match(cur.error, /Maximum batch GPU session count/);
  assert.equal(fake.pushCalls.length, 1); // Kaggle 只尝试推过一次
  assert.equal(fake.postCalls.length, 0); // 没往 Colab 发过提交
});

test("队列满 → 同一单自动切 Colab：提示词/种子原样带过去，跑完只推一次", async () => {
  resetFake();
  const job = await submitJob({ model: "qwen", prompt: "autoswitch test", backend: "kaggle" });
  assert.equal(job.backend, "kaggle");
  assert.equal(job.autoSwitchedToColab, false);
  await waitFor(
    () => {
      const cur = getJobs().find((j) => j.id === job.id);
      return cur?.backend === "colab" && cur?.status === "queued" && !!cur?.colabJobId;
    },
    8000,
    "队列满的单切到 Colab 并进排队",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.autoSwitchedToColab, true);
  assert.match(cur.colabJobId, /^cb-test-/);
  assert.match(cur.stageDetail, /Kaggle 队列已满，已自动切换到 Colab 生成/);
  assert.equal(fake.pushCalls.length, 1); // Kaggle 只尝试推过一次（被拒）
  assert.equal(fake.postCalls.length, 1); // 只往 Colab 提交过一次
  const body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.model, "qwen");
  assert.equal(body.prompt, "autoswitch test");
  assert.equal(body.seed, job.seed); // 种子原样带过去
  assert.equal(fake.postCalls[0].headers["X-Colab-Key"], "test-relay-key");
  // 切换说明在 Colab 轮询里一直带着
  const remote = fakeRelayJob(cur.colabJobId);
  remote.status = "running";
  remote.progress = 40;
  remote.stage = "生成中";
  await __tickForTest();
  let cur2 = getJobs().find((j) => j.id === job.id);
  assert.equal(cur2.status, "running");
  assert.match(cur2.stageDetail, /Kaggle 队列已满，已自动切换到 Colab 生成 · Colab：生成中 · 40%/);
  // 跑完：WebP 下回来完成，PNG 后台补上
  remote.status = "done";
  remote.progress = 100;
  await __tickForTest();
  cur2 = getJobs().find((j) => j.id === job.id);
  assert.equal(cur2.status, "done");
  assert.equal(cur2.backend, "colab");
  assert.ok(cur2.imageFileName.endsWith(".webp"));
  const { data } = await Filesystem.readFile({ path: `images/${cur2.imageFileName}`, directory: "DATA" });
  assert.ok(data.length > 0);
  await waitFor(() => getJobs().find((j) => j.id === job.id)?.imageFileName.endsWith(".png"), 8000, "PNG 后台补上");
});

test("Colab 未配密钥 → 不切、失败且报错明确", async () => {
  resetFake();
  await saveSettings({ relayKey: "" });
  const job = await submitJob({ model: "qwen", prompt: "autoswitch no key test", backend: "kaggle" });
  await waitFor(() => getJobs().find((j) => j.id === job.id)?.status === "failed", 8000, "没配密钥的单判失败");
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.backend, "kaggle");
  assert.equal(cur.autoSwitchedToColab, false);
  assert.match(cur.error, /Colab 中转密钥/);
  assert.match(cur.error, /等 Kaggle 空出位置/);
  assert.equal(fake.postCalls.length, 0); // 没往 Colab 发过提交
  await saveSettings({ relayKey: "test-relay-key" });
});

test("其他错误（401）→ 不切、按原样失败", async () => {
  resetFake();
  fake.push = "401";
  const job = await submitJob({ model: "qwen", prompt: "autoswitch 401 test", backend: "kaggle" });
  await waitFor(() => getJobs().find((j) => j.id === job.id)?.status === "failed", 8000, "401 的单判失败");
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.backend, "kaggle");
  assert.equal(cur.autoSwitchedToColab, false);
  assert.match(cur.error, /401/);
  assert.equal(fake.postCalls.length, 0); // 没往 Colab 发过提交
});

test("自动切 Colab：提交时 7B 关、3B 开，切过去后按 7B 的关走（镜像，不被 3B 默认值改掉）", async () => {
  resetFake();
  // 提交 Kaggle 时 3B 开关是灰的、用户设不了：存的是之前 Colab 会话留下的开。
  const job = await submitJob({ model: "qwen", prompt: "autoswitch mirror off test", backend: "kaggle", useUpscale: false, useColabUpscale: true });
  assert.equal(job.useUpscale, false);
  assert.equal(job.useColabUpscale, true);
  await waitFor(
    () => {
      const cur = getJobs().find((j) => j.id === job.id);
      return cur?.backend === "colab" && cur?.status === "queued" && !!cur?.colabJobId;
    },
    8000,
    "队列满的单切到 Colab 并进排队",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.autoSwitchedToColab, true);
  assert.equal(cur.useColabUpscale, false); // 镜像：7B 的关带过来了
  assert.equal(fake.postCalls.length, 1);
  const body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.useUpscale, false); // 中转收到的也是关
  // 跑完收尾，别占着并发位
  const remote = fakeRelayJob(cur.colabJobId);
  remote.status = "done";
  remote.progress = 100;
  await __tickForTest();
  const done = getJobs().find((j) => j.id === job.id);
  assert.equal(done.status, "done");
});

test("自动切 Colab：提交时 7B 开、3B 关，切过去后按 7B 的开走（镜像）", async () => {
  resetFake();
  const job = await submitJob({ model: "qwen", prompt: "autoswitch mirror on test", backend: "kaggle", useUpscale: true, useColabUpscale: false });
  assert.equal(job.useUpscale, true);
  assert.equal(job.useColabUpscale, false);
  await waitFor(
    () => {
      const cur = getJobs().find((j) => j.id === job.id);
      return cur?.backend === "colab" && cur?.status === "queued" && !!cur?.colabJobId;
    },
    8000,
    "队列满的单切到 Colab 并进排队",
  );
  const cur = getJobs().find((j) => j.id === job.id);
  assert.equal(cur.autoSwitchedToColab, true);
  assert.equal(cur.useColabUpscale, true); // 镜像：7B 的开带过来了
  assert.equal(fake.postCalls.length, 1);
  const body = JSON.parse(fake.postCalls[0].body);
  assert.equal(body.useUpscale, true);
  const remote = fakeRelayJob(cur.colabJobId);
  remote.status = "done";
  remote.progress = 100;
  await __tickForTest();
  const done = getJobs().find((j) => j.id === job.id);
  assert.equal(done.status, "done");
});
