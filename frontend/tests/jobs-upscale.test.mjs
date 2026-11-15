// tests/jobs-upscale.test.mjs — 超分开关在任务层的测试：提交存开关、
// 重提/重新生成按原选择重放、老任务（没有 useUpscale 字段）按开处理。
// 跑法：npm test。注意：测试环境里 runJob 会在后台跑起来、但 loadTemplate
// 读不到 Vite 的 import.meta.env.BASE_URL 而失败，任务会被标失败——
// 这里只断言任务记录里的 useUpscale 选择，不测云端推送本身。
import { test, after } from "node:test";
import assert from "node:assert/strict";
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
import { upscalerLabelForJob } from "../src/lib/notebook.js";

after(() => {
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
