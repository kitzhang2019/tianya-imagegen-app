// tests/jobs-delete-cancel.test.mjs — 删任务先取消平台任务（v1.2.25）：
// App 里删除一条任务时，先去平台上取消对应的那一单，再删本地记录。
// Kaggle 经中转调 DeleteKernel RPC；Colab 调中转 POST /job/<id>/fail。
// 只对未完结的任务发取消；平台已没了（404）当已取消；取消失败时任务留着、
// 记一条看得见的提示，等联网后重试删除。跑法：npm test。
// fetch 桩模拟 Kaggle 中转 + Colab 中转；Filesystem 桩用内存文件表。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  cancelRemoteJob,
  deleteJob,
  getJobs,
  initJobs,
  saveSettings,
  stopPolling,
} from "../src/lib/jobs.js";
import { KAGGLE_API_BASE, KAGGLE_RELAY_BASE, KaggleClient } from "../src/lib/kaggle.js";
import { COLAB_RELAY_BASE, ColabClient } from "../src/lib/colab.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  stopPolling();
  __resetStore();
  __resetFiles();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 可编程的平台行为（每个测试按需改）
const fake = {
  deleteKernel: "ok", // "ok" | "404" | "down" | "403"
  deleteCalls: [], // { url, body, headers, stillListed }
  colabFail: "ok", // "ok" | "404" | "down"
  failCalls: [], // { id, headers, body, stillListed }
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

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = opts?.method || "GET";
  if (u.includes("DeleteKernel")) {
    if (fake.deleteKernel === "down") throw new TypeError("fetch failed");
    if (fake.deleteKernel === "404") {
      return jsonRes(404, { error: { code: 404, message: "kernel not found" } });
    }
    if (fake.deleteKernel === "403") {
      return jsonRes(403, { error: { code: 403, message: "Permission denied" } });
    }
    const body = JSON.parse(opts?.body || "{}");
    // 取消发出去时任务必须还在本地列表里（先取消、后删记录的顺序证据）
    fake.deleteCalls.push({ url: u, body, headers: opts?.headers || {}, stillListed: getJobs().some((j) => j.kaggleRef === `u/${body.kernelSlug}`) });
    return jsonRes(200, {});
  }
  if (u.includes("GetKernelSessionStatus")) {
    return jsonRes(200, { status: "QUEUED" });
  }
  const mFail = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)/fail$`));
  if (mFail && method === "POST") {
    if (fake.colabFail === "down") throw new TypeError("fetch failed");
    if (fake.colabFail === "404") return jsonRes(404, { ok: false, error: "job not found" });
    fake.failCalls.push({
      id: mFail[1],
      headers: opts?.headers || {},
      body: opts?.body,
      stillListed: getJobs().some((j) => j.colabJobId === mFail[1]),
    });
    return jsonRes(200, { ok: true, job: { id: mFail[1], status: "failed" } });
  }
  const mGet = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)$`));
  if (mGet && method === "GET") {
    return jsonRes(200, { ok: true, job: { id: mGet[1], status: "queued", progress: 0, stage: "排队中" } });
  }
  throw new Error(`测试桩没预料到的请求：${method} ${u}`);
};

function resetFake() {
  fake.deleteKernel = "ok";
  fake.deleteCalls = [];
  fake.colabFail = "ok";
  fake.failCalls = [];
}

function seedJob(id, extra) {
  return {
    id,
    model: "moss",
    prompt: `delete cancel test ${id}`,
    ratioKey: "auto",
    width: 1280,
    height: 1920,
    seed: 3000 + id,
    status: "running",
    stage: "running",
    backend: "kaggle",
    colabJobId: null,
    kaggleRef: `u/app-moss-comfyui-kaggle-${id}`,
    kaggleSlug: `app-moss-comfyui-kaggle-${id}`,
    createdAt: Date.now(),
    pushedAt: Date.now(),
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: Date.now(),
    finishedAt: null,
    error: null,
    imageFileName: null,
    webpFileName: null,
    downloadStartedAt: null,
    ...extra,
  };
}

before(async () => {
  await saveSettings({ kaggleUsername: "u", kaggleToken: "KGAT-testtoken", relayKey: "test-relay-key", galleryKey: "", galleryUrl: "" });
});

test("预置：Kaggle 跑着/排队、Colab 跑着、已完结、自动切换、还没建出的单", async () => {
  resetFake();
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      seedJob(201), // Kaggle running
      seedJob(202, { status: "queued", stage: "queued" }), // Kaggle 排队中
      seedJob(203, { backend: "colab", colabJobId: "cb-del-203", kaggleRef: null, kaggleSlug: null }), // Colab running
      seedJob(204, { status: "done", stage: "done", finishedAt: Date.now(), imageFileName: "moss_test_204.png" }), // 已完成
      seedJob(205, { status: "failed", stage: "failed", finishedAt: Date.now(), error: "之前失败了" }), // 已失败
      seedJob(206, { status: "failed", stage: "failed", backend: "colab", colabJobId: "cb-del-206", kaggleRef: null, kaggleSlug: null, finishedAt: Date.now(), error: "之前失败了" }), // Colab 已失败
      // 自动切换过的单：Kaggle 满了切到 Colab，kaggleRef 本来就是 null
      seedJob(207, { backend: "colab", autoSwitchedToColab: true, colabJobId: "cb-del-207", kaggleRef: null, kaggleSlug: "app-moss-comfyui-kaggle-207" }),
      seedJob(208, { status: "queued-local", stage: "queued-local", kaggleRef: null, kaggleSlug: "app-moss-comfyui-kaggle-208" }), // 还没建出
      seedJob(209, { status: "preparing", stage: "preparing", backend: "colab", colabJobId: null, kaggleRef: null, kaggleSlug: null }), // Colab 还没拿到任务号
      seedJob(210), // Kaggle running（给 404 测试用）
      seedJob(211, { backend: "colab", colabJobId: "cb-del-211", kaggleRef: null, kaggleSlug: null }), // Colab running（给 404 测试用）
      seedJob(212), // Kaggle running（给取消失败测试用）
    ]),
    "tianya-imagegen-counter": "212",
  });
  await initJobs();
  stopPolling();
  await sleep(50);
  assert.equal(getJobs().length, 12);
});

test("删 Kaggle running 任务：先调 DeleteKernel 再删本地记录", async () => {
  resetFake();
  const res = await deleteJob(201);
  assert.equal(res.ok, true);
  assert.equal(fake.deleteCalls.length, 1);
  const call = fake.deleteCalls[0];
  assert.ok(call.url.startsWith(KAGGLE_RELAY_BASE), "取消走 Kaggle 中转，不直连 kaggle.com");
  assert.ok(call.url.includes("kernels.KernelsApiService/DeleteKernel"), "调 DeleteKernel RPC，不用 403 的 CancelKernelSession");
  assert.deepEqual(call.body, { userName: "u", kernelSlug: "app-moss-comfyui-kaggle-201" });
  assert.match(call.headers.Authorization || "", /KGAT-testtoken/);
  assert.equal(call.stillListed, true, "发取消时任务还在本地列表里（先取消、后删记录）");
  assert.equal(fake.failCalls.length, 0);
  assert.equal(getJobs().some((j) => j.id === 201), false);
});

test("删 Kaggle 排队中任务也要取消", async () => {
  resetFake();
  const res = await deleteJob(202);
  assert.equal(res.ok, true);
  assert.equal(fake.deleteCalls.length, 1);
  assert.equal(fake.deleteCalls[0].body.kernelSlug, "app-moss-comfyui-kaggle-202");
  assert.equal(getJobs().some((j) => j.id === 202), false);
});

test("删 Colab running 任务：调中转 fail 再删本地记录", async () => {
  resetFake();
  const res = await deleteJob(203);
  assert.equal(res.ok, true);
  assert.equal(fake.failCalls.length, 1);
  const call = fake.failCalls[0];
  assert.equal(call.id, "cb-del-203");
  assert.equal(call.headers["X-Colab-Key"], "test-relay-key");
  assert.match(String(call.body || ""), /删除/);
  assert.equal(call.stillListed, true, "发取消时任务还在本地列表里");
  assert.equal(fake.deleteCalls.length, 0);
  assert.equal(getJobs().some((j) => j.id === 203), false);
});

test("已完成/已失败任务不发取消，直接删本地", async () => {
  resetFake();
  assert.equal((await deleteJob(204)).ok, true);
  assert.equal((await deleteJob(205)).ok, true);
  assert.equal((await deleteJob(206)).ok, true);
  assert.equal(fake.deleteCalls.length, 0);
  assert.equal(fake.failCalls.length, 0);
  assert.equal(getJobs().some((j) => [204, 205, 206].includes(j.id)), false);
});

test("自动切换后的任务按新后端取消：只调 Colab fail，不碰 Kaggle", async () => {
  resetFake();
  const res = await deleteJob(207);
  assert.equal(res.ok, true);
  assert.equal(fake.failCalls.length, 1);
  assert.equal(fake.failCalls[0].id, "cb-del-207");
  assert.equal(fake.deleteCalls.length, 0, "原来那个 Kaggle 的本来就没建出来，不去取消");
  assert.equal(getJobs().some((j) => j.id === 207), false);
});

test("还没建出平台任务的删本地即可，不发取消", async () => {
  resetFake();
  assert.equal((await deleteJob(208)).ok, true); // queued-local，无 kaggleRef
  assert.equal((await deleteJob(209)).ok, true); // preparing，无 colabJobId
  assert.equal(fake.deleteCalls.length, 0);
  assert.equal(fake.failCalls.length, 0);
});

test("平台 404 当已取消：Kaggle 与 Colab 都照常删掉", async () => {
  resetFake();
  fake.deleteKernel = "404";
  fake.colabFail = "404";
  // 404 分支本身：cancelRemoteJob 直接验证一次
  assert.deepEqual(await cancelRemoteJob(getJobs().find((j) => j.id === 210)), { ok: true, alreadyGone: true });
  assert.deepEqual(await cancelRemoteJob(getJobs().find((j) => j.id === 211)), { ok: true, alreadyGone: true });
  assert.equal((await deleteJob(210)).ok, true);
  assert.equal((await deleteJob(211)).ok, true);
  assert.equal(getJobs().some((j) => [210, 211].includes(j.id)), false);
});

test("取消失败：任务留着、有看得见的提示，联网后再删能删掉", async () => {
  resetFake();
  fake.deleteKernel = "down"; // 断网：DeleteKernel 发不出去
  // cancelRemoteJob 先验证报错分支
  const cancel = await cancelRemoteJob(getJobs().find((j) => j.id === 212));
  assert.equal(cancel.ok, false);
  assert.match(cancel.error, /连不上 Kaggle API/);
  // 走完整 deleteJob：取消失败就不删本地，提示写进任务行
  const res = await deleteJob(212);
  assert.equal(res.ok, false);
  const kept = getJobs().find((j) => j.id === 212);
  assert.ok(kept, "取消失败的任务不能静默删掉");
  assert.match(kept.stageDetail || "", /平台取消失败/);
  assert.ok(kept.cancelError, "cancelError 记下来，任务行能看到");
  // 网络恢复：再删一次就能删掉
  fake.deleteKernel = "ok";
  assert.equal((await deleteJob(212)).ok, true);
  assert.equal(getJobs().some((j) => j.id === 212), false);
});

test("KaggleClient.deleteKernel：404 当已取消，403 抛错", async () => {
  const client = new KaggleClient({ username: "u", key: "KGAT-testtoken" });
  resetFake();
  fake.deleteKernel = "404";
  assert.deepEqual(await client.deleteKernel("u/app-x-comfyui-kaggle-1"), { alreadyGone: true });
  fake.deleteKernel = "403";
  await assert.rejects(() => client.deleteKernel("u/app-x-comfyui-kaggle-1"), /403/);
  fake.deleteKernel = "ok";
  assert.deepEqual(await client.deleteKernel("u/app-x-comfyui-kaggle-1"), { alreadyGone: false });
  assert.equal(fake.deleteCalls.length, 1);
  assert.ok(fake.deleteCalls[0].url.startsWith(`${KAGGLE_API_BASE}/kernels.KernelsApiService/DeleteKernel`));
});

test("ColabClient.failJob：404 当已取消", async () => {
  const client = new ColabClient({ key: "test-relay-key" });
  resetFake();
  fake.colabFail = "404";
  assert.deepEqual(await client.failJob("cb-del-999"), { alreadyGone: true });
  fake.colabFail = "ok";
  assert.deepEqual(await client.failJob("cb-del-999"), { alreadyGone: false });
  assert.equal(fake.failCalls.length, 1);
  assert.equal(fake.failCalls[0].id, "cb-del-999");
});

test("删不存在的任务不报错", async () => {
  const res = await deleteJob(9999);
  assert.equal(res.ok, true);
});
