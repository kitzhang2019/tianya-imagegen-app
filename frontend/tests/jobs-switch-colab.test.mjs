// tests/jobs-switch-colab.test.mjs — v3.0.1：任务卡片「切换到 Colab」按钮。
// 失败任务还是这一单，原地改成走 Colab 再提交：同一个 id、同一个种子、
// 同一套提示词/模型/LoRA/超分设置，只把后端换成 Colab，状态回到排队，
// 由 pumpQueue → runColabJob 重新提交（拿新的 colabJobId、进轮询）。
// 成功/进行中的任务调 switchToColabJob 抛错（UI 层也会把按钮置灰）。
// 跑法：npm test。fetch 桩只接提交（POST /job）与模板读取；
// Filesystem 桩用内存文件表。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  getJobs,
  initJobs,
  saveSettings,
  stopPolling,
  switchToColabJob,
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

let submitCount = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = opts?.method || "GET";
  if (u.includes("notebooks/")) {
    const m = ["moss", "qwen", "krea2", "zimage"].find((x) => u.includes(x)) || "qwen";
    return textRes(200, templates[m]);
  }
  if (u === `${COLAB_RELAY_BASE}/job` && method === "POST") {
    submitCount += 1;
    return jsonRes(200, { ok: true, job_id: `cb-test-switch-${submitCount}` });
  }
  throw new Error(`测试桩没预料到的请求：${method} ${u}`);
};

function seedJob(overrides) {
  return {
    id: 401,
    model: "krea2",
    prompt: "switch colab test prompt",
    ratioKey: "auto",
    width: 1280,
    height: 1920,
    seed: 4401,
    status: "failed",
    stage: "failed",
    stageDetail: "Kaggle 队列满了",
    backend: "kaggle",
    colabJobId: "cb-old-failed",
    kaggleRef: null,
    kaggleSlug: "app-krea2-comfyui-kaggle-401",
    createdAt: Date.now(),
    pushedAt: Date.now(),
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: Date.now(),
    finishedAt: null,
    error: "Kaggle 队列满了",
    imageFileName: "krea2_test_401.png",
    webpFileName: null,
    downloadStartedAt: null,
    useLora: true,
    useUpscale: true,
    useColabUpscale: false,
    ...overrides,
  };
}

before(async () => {
  await saveSettings({ relayKey: "test-relay-key" });
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      seedJob({ id: 401 }),
      seedJob({ id: 402, status: "done", stage: "done", stageDetail: "已完成，图片已保存", error: null, finishedAt: Date.now() }),
      seedJob({ id: 403, backend: "colab", colabJobId: "cb-old-colab-failed", kaggleSlug: null }),
    ]),
    "tianya-imagegen-counter": "403",
  });
  await initJobs();
  stopPolling();
  await sleep(50);
});

test("失败的 Kaggle 任务原地切到 Colab：同一 id、同一种子，后端变 colab，重新提交", async () => {
  const old = getJobs().find((j) => j.id === 401);
  assert.ok(old);
  assert.equal(old.status, "failed");
  const job = await switchToColabJob(401);
  // 同一条任务：id、种子、提示词、模型、LoRA、超分设置都不变
  assert.equal(job.id, 401);
  assert.equal(job.seed, 4401);
  assert.equal(job.model, "krea2");
  assert.equal(job.prompt, "switch colab test prompt");
  assert.equal(job.ratioKey, "auto");
  assert.equal(job.useLora, true);
  assert.equal(job.useUpscale, true);
  assert.equal(job.useColabUpscale, false);
  // 后端换成 Colab，slug 清掉；提交走 pumpQueue → runColabJob，拿到新的中转任务号
  assert.equal(job.backend, "colab");
  assert.equal(job.kaggleSlug, null);
  await waitFor(() => {
    const cur = getJobs().find((j) => j.id === 401);
    return cur && cur.status === "queued" && cur.colabJobId === "cb-test-switch-1";
  }, 8000, "切换后的任务提交到 Colab");
  const after = getJobs().find((j) => j.id === 401);
  assert.equal(after.backend, "colab");
  assert.equal(after.seed, 4401);
  assert.equal(after.kaggleSlug, null);
  assert.notEqual(after.colabJobId, "cb-old-failed");
});

test("失败的 Colab 任务也能切（同一单重提，拿新的中转任务号）", async () => {
  const job = await switchToColabJob(403);
  assert.equal(job.id, 403);
  assert.equal(job.seed, 4401);
  assert.equal(job.backend, "colab");
  await waitFor(() => {
    const cur = getJobs().find((j) => j.id === 403);
    return cur && cur.status === "queued" && cur.colabJobId === "cb-test-switch-2";
  }, 8000, "切换后的 Colab 任务重新提交");
  const after = getJobs().find((j) => j.id === 403);
  assert.equal(after.id, 403);
  assert.equal(after.seed, 4401);
  assert.notEqual(after.colabJobId, "cb-old-colab-failed");
});

test("成功的任务不能切换：抛错", async () => {
  await assert.rejects(() => switchToColabJob(402), /只有失败的任务才能切换到 Colab/);
});

test("找不到的 id 抛错", async () => {
  await assert.rejects(() => switchToColabJob(99999), /找不到这条任务/);
});
