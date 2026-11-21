// tests/gallery-push-ring.test.mjs — v1.2.28 画廊推送进度圈：状态只读推
// 送结果，不改推送逻辑、不自动推。galleryPushRingState(job, pushingJobIds)
//  - pushing：这张正在推送（调用方把 id 放进 pushing 集合）
//  - ok：已推送成功（任务记录 galleryPushed === true）
//  - error：推送失败（galleryPushed === false）
//  - null：没推过 / 与推送无关
// 叉号状态下重新推送入口不变：推送入口是图库选择模式的「推送到画廊」按
// 钮，与这个状态显示无关（本文件只测状态函数；入口本身 main.js 里没动）。
// 跑法：npm test。
import { test } from "node:test";
import assert from "node:assert/strict";
import { galleryPushRingState } from "../src/lib/jobs.js";

const job = (overrides) => ({
  id: 1, model: "moss", prompt: "p", status: "done",
  ...overrides,
});

test("galleryPushRingState：没推过返回 null", () => {
  assert.equal(galleryPushRingState(job({})), null);
  assert.equal(galleryPushRingState(job({ galleryPushed: undefined }), new Set()), null);
  assert.equal(galleryPushRingState(job({ galleryPushed: null })), null);
  assert.equal(galleryPushRingState(null), null);
  assert.equal(galleryPushRingState(undefined, new Set([1])), null);
});

test("galleryPushRingState：推送进行中优先于已存状态", () => {
  const pushing = new Set([1]);
  assert.equal(galleryPushRingState(job({}), pushing), "pushing");
  // 之前推成功过的图，再推一次时也显示转圈，不是旧的 ✓
  assert.equal(galleryPushRingState(job({ galleryPushed: true }), pushing), "pushing");
  // 之前推失败的图，再推一次时也显示转圈，不是旧的 ✗
  assert.equal(galleryPushRingState(job({ galleryPushed: false }), pushing), "pushing");
  // 不在 pushing 集合里的另一张图不受影响
  assert.equal(galleryPushRingState(job({ id: 2 }), pushing), null);
});

test("galleryPushRingState：推送完按任务记录显示 ✓/✗", () => {
  assert.equal(galleryPushRingState(job({ galleryPushed: true })), "ok");
  assert.equal(galleryPushRingState(job({ galleryPushed: false })), "error");
  // pushing 集合空了以后，成功/失败状态还在（持久状态，不随页面刷新丢）
  assert.equal(galleryPushRingState(job({ galleryPushed: true }), new Set()), "ok");
  assert.equal(galleryPushRingState(job({ galleryPushed: false }), new Set()), "error");
});
