// tests/jobs-upscale.test.mjs — 超分开关在任务层的测试：提交存开关、
// 重提/重新生成按原选择重放、老任务（没有 useUpscale 字段）按开处理。
// 跑法：npm test。注意：测试环境里 runJob 会在后台跑起来；fetch 桩让它能读到
// 磁盘真模板、云端一律答“没有这单”，所以重提正常建新单、后台推送走完流程——
// 这里只断言任务记录里的 useUpscale 选择，不测云端推送本身。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import {
  getJobs,
  initJobs,
  regenerateJob,
  retryJob,
  saveSettings,
  stopPolling,
  submitJob,
} from "../src/lib/jobs.js";
import { upscalerLabelForJob, outputSizeForJob } from "../src/lib/notebook.js";

const realFetch = globalThis.fetch;

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

// fetch 桩：模板按模型读磁盘真文件；retryJob 前的云端核对一律答“没有这单”，
// 让重提正常建新单；其他 Kaggle 查询答空，后台 runJob 走失败/待确认分支，
// 不影响这里对任务记录的断言。
const templates = {};
for (const m of ["moss", "qwen", "krea2", "zimage"]) {
  templates[m] = fs.readFileSync(new URL(`../public/notebooks/${m}-comfyui-kaggle.ipynb`, import.meta.url), "utf8");
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("notebooks/")) {
    const m = ["moss", "qwen", "krea2", "zimage"].find((x) => u.includes(x)) || "qwen";
    return textRes(200, templates[m]);
  }
  if (u.includes("GetKernelSessionStatus")) return jsonRes(404, { error: "not found" });
  // push 直接拒掉：这里不测真推，后台 runJob 立刻失败，不进 5 分钟核实循环。
  if (u.includes("/kernels/push")) return jsonRes(400, { error: { message: "测试桩：不真推" } });
  if (u.includes("kernels/list")) return jsonRes(200, []);
  return jsonRes(404, { error: "not found" });
};

after(() => {
  globalThis.fetch = realFetch;
  stopPolling();
  __resetStore();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("老任务兼容：没有 useUpscale 字段的旧任务，重提后按开处理", async () => {
  // 预置一条 v1.2 之前的旧任务（没有 useUpscale 字段，已失败）。
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      {
        id: 41,
        model: "moss",
        prompt: "old prompt",
        ratioKey: "r3x4v",
        width: 1696,
        height: 2256,
        seed: 111,
        status: "failed",
        stage: "failed",
        createdAt: 1700000000000,
      },
    ]),
    "tianya-imagegen-counter": "41",
  });
  await saveSettings({ kaggleUsername: "u", kaggleToken: "t", galleryKey: "", galleryUrl: "" });
  await initJobs();
  const retried = await retryJob(41);
  assert.equal(retried.model, "moss");
  assert.equal(retried.prompt, "old prompt");
  assert.equal(retried.useUpscale, true);
  assert.equal(upscalerLabelForJob(retried), "SeedVR 7B");
  assert.notEqual(retried.seed, 111);
  assert.notEqual(retried.id, 41);
});

test("submitJob：不传 useUpscale 默认开，传 false 就存关", async () => {
  const onJob = await submitJob({ model: "krea2", prompt: "on" });
  assert.equal(onJob.useUpscale, true);
  const offJob = await submitJob({ model: "qwen", prompt: "off", useUpscale: false });
  assert.equal(offJob.useUpscale, false);
  await sleep(50); // 让后台的 runJob 跑完失败流程，不影响后面的断言
});

test("retryJob：关保持关，开保持开", async () => {
  const jobs = getJobs();
  const offJob = jobs.find((j) => j.prompt === "off");
  const onJob = jobs.find((j) => j.prompt === "on");
  assert.ok(offJob && onJob);
  const retriedOff = await retryJob(offJob.id);
  assert.equal(retriedOff.useUpscale, false);
  assert.equal(upscalerLabelForJob(retriedOff), "无");
  const retriedOn = await retryJob(onJob.id);
  assert.equal(retriedOn.useUpscale, true);
  assert.equal(upscalerLabelForJob(retriedOn), "SeedVR 7B");
});

test("regenerateJob：关保持关（旧图保留、新任务带原选择）", async () => {
  const jobs = getJobs();
  const offJob = jobs.find((j) => j.prompt === "off");
  assert.ok(offJob);
  // 测试里把这条任务标成已完成，regenerateJob 才放行（只改内存里的记录）。
  Object.assign(offJob, { status: "done", imageFileName: "qwen_dash_1.png" });
  const regen = await regenerateJob(offJob.id);
  assert.equal(regen.useUpscale, false);
  assert.equal(regen.regeneratedFrom, offJob.id);
  assert.equal(offJob.regeneratedBy, regen.id);
  assert.notEqual(regen.seed, offJob.seed);
});

test("Kaggle 单不受 3B 开关影响：3B 关了，Kaggle 仍按 7B 开走", async () => {
  const job = await submitJob({ model: "krea2", prompt: "kaggle 3b off", backend: "kaggle", useUpscale: true, useColabUpscale: false });
  assert.equal(job.backend, "kaggle");
  assert.equal(job.useUpscale, true);
  assert.equal(job.useColabUpscale, false);
  // 尺寸与画廊标签都跟 7B 开关走，不跟 3B 开关走
  assert.equal(upscalerLabelForJob(job), "SeedVR 7B");
  assert.deepEqual(outputSizeForJob(job), { width: job.width, height: job.height });
  await sleep(50); // 让后台的 runJob 跑完失败流程，不影响后面的断言
});

test("老 Colab 单重提：没有 3B 字段时按旧 7B 字段回退", async () => {
  await saveSettings({ relayKey: "test-relay-key" });
  const old = await submitJob({ model: "qwen", prompt: "old colab no 3b", backend: "colab", useUpscale: false });
  assert.equal(old.useColabUpscale, false);
  // 模拟 v1.2.22 之前的旧记录：删掉 3B 字段、标成失败（只改内存里的记录）。
  delete old.useColabUpscale;
  Object.assign(old, { status: "failed", stage: "failed", error: "之前失败了" });
  const retried = await retryJob(old.id);
  assert.notEqual(retried.id, old.id);
  assert.equal(retried.backend, "colab");
  assert.equal(retried.useUpscale, false);
  assert.equal(retried.useColabUpscale, false);
  await sleep(50);
});
