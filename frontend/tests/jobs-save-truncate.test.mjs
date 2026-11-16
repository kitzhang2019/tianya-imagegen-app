// tests/jobs-save-truncate.test.mjs — saveJobs 截断 50 条时，删掉多余任务的本机文件
// （只截记录不删文件会在手机上慢慢泄漏存储）。跑法：npm test。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { __deletedFiles, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __saveJobsForTest,
  getJobs,
  initJobs,
  stopPolling,
} from "../src/lib/jobs.js";

after(() => {
  stopPolling();
  __resetStore();
  __resetFiles();
});

test("saveJobs：51 条截成 50 条时，多余那条的 PNG/WebP/缩略图都被删掉", async () => {
  const jobs = [];
  for (let id = 1; id <= 51; id++) {
    jobs.push({
      id, model: "moss", prompt: "p", seed: id, width: 2560, height: 3840, ratioKey: "r2x3v",
      status: "done", stage: "done", createdAt: 1700000000000 + id,
      imageFileName: `moss_dash_${id}.png`,
      webpFileName: `moss_dash_${id}.webp`,
      thumbFileName: `moss_dash_${id}-thumb.webp`,
    });
  }
  __seedStore({
    "tianya-imagegen-settings": JSON.stringify({ kaggleUsername: "u", kaggleToken: "t", galleryKey: "", galleryUrl: "" }),
    "tianya-imagegen-jobs": JSON.stringify(jobs),
    "tianya-imagegen-counter": "51",
  });
  await initJobs();
  assert.equal(getJobs().length, 50);
  assert.ok(!getJobs().some((j) => j.id === 51));
  assert.ok(__deletedFiles.includes("images/moss_dash_51.png"));
  assert.ok(__deletedFiles.includes("images/moss_dash_51.webp"));
  assert.ok(__deletedFiles.includes("images/moss_dash_51-thumb.webp"));
  // 前 50 条的文件没被误删
  assert.ok(!__deletedFiles.some((p) => p.includes("moss_dash_50")));
  // 再调一次 saveJobs：已是 50 条，不再删
  const deletedBefore = __deletedFiles.length;
  await __saveJobsForTest();
  assert.equal(getJobs().length, 50);
  assert.equal(__deletedFiles.length, deletedBefore);
});
