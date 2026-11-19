// tests/jobs-delete-cancel.test.mjs — 删任务流程（v1.2.25，最终版）：
// 删排队中（没开始生成）的任务：取消平台任务（Kaggle 调 DeleteKernel RPC、
// Colab 调中转 POST /job/<id>/fail），再删本地记录。
// 删已开始生成 / 已跑完的任务：不取消（GPU 的活已经花了），任务记录从列表
// 删掉，留一条轻量后台跟踪（只存平台任务 id 和元数据），继续轮询它跑完，
// 成品图取回进 App 本地图库（WebP+PNG 原图、元数据齐全），用户在图库里
// 手动点上传到画廊。删任务时绝不自动推公开画廊。
// 查不到状态按“已开始”处理（先取图，取不到再取消），不把可能已出图的单取消掉。
// 跑法：npm test。fetch 桩模拟 Kaggle 中转 + Colab 中转；Filesystem 桩用内存文件表。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore, __readStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __tickForTest,
  cancelRemoteJob,
  deleteJob,
  getJobs,
  getOrphans,
  initJobs,
  saveSettings,
  stopPolling,
} from "../src/lib/jobs.js";
import { KAGGLE_API_BASE, KAGGLE_RELAY_BASE, KaggleClient } from "../src/lib/kaggle.js";
import { COLAB_RELAY_BASE, ColabClient } from "../src/lib/colab.js";
import { outputFileName } from "../src/lib/notebook.js";

const realFetch = globalThis.fetch;
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

// 可编程的平台行为（每个测试按需改）
const fake = {
  deleteKernel: "ok", // "ok" | "404" | "down" | "403"
  deleteCalls: [], // { url, body, headers, stillListed }
  colabFail: "ok", // "ok" | "404" | "down"
  failCalls: [], // { id, headers, body, stillListed }
  kernelStatus: "queued", // 全局覆盖："queued" 时按 kernelBySlug 逐单返回；其他值全局生效
  kernelBySlug: {}, // kernelSlug -> "queued" | "running" | "complete" | "error"
  outputFiles: [], // ListKernelSessionOutput 返回的文件 [{ fileName, url }]
  colabJobs: {}, // colabJobId -> { status, progress, stage, error }，缺省排队中
  galleryCalls: [], // 推公开画廊的调用（应一直是空的：删任务不自动推画廊）
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

function bytesRes(bytes) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => "application/octet-stream" },
    text: async () => "",
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = opts?.method || "GET";
  if (u.includes("gallery.example.test")) {
    fake.galleryCalls.push(u);
    return jsonRes(200, { ok: true, id: "gallery-test-id" });
  }
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
    if (fake.kernelStatus === "down") throw new TypeError("fetch failed");
    if (fake.kernelStatus === "404") return jsonRes(404, { error: "not found" });
    let state = fake.kernelStatus;
    if (state === "queued") {
      const body = JSON.parse(opts?.body || "{}");
      state = fake.kernelBySlug[body.kernelSlug] || "queued";
    }
    if (state === "running") return jsonRes(200, { status: "RUNNING" });
    if (state === "complete") return jsonRes(200, { status: "COMPLETE" });
    if (state === "error") return jsonRes(200, { status: "ERROR", failureMessage: "GPU OOM" });
    return jsonRes(200, { status: "QUEUED" });
  }
  if (u.includes("ListKernelSessionOutput")) {
    return jsonRes(200, { files: fake.outputFiles, nextPageToken: null });
  }
  if (u.includes("kernels/list")) {
    return jsonRes(200, []);
  }
  if (u.startsWith(`${KAGGLE_RELAY_BASE}/dl?`)) {
    return bytesRes(PNG_BYTES);
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
  const mDl = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)/(webp|png)$`));
  if (mDl && method === "GET") {
    return bytesRes(mDl[2] === "webp" ? WEBP_BYTES : PNG_BYTES);
  }
  const mGet = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([^/]+)$`));
  if (mGet && method === "GET") {
    const remote = fake.colabJobs[mGet[1]] || { id: mGet[1], status: "queued", progress: 0, stage: "排队中" };
    return jsonRes(200, { ok: true, job: remote });
  }
  throw new Error(`测试桩没预料到的请求：${method} ${u}`);
};

function resetFake() {
  fake.deleteKernel = "ok";
  fake.deleteCalls = [];
  fake.colabFail = "ok";
  fake.failCalls = [];
  fake.kernelStatus = "queued";
  fake.kernelBySlug = {
    "app-moss-comfyui-kaggle-201": "running",
    "app-moss-comfyui-kaggle-214": "running",
  };
  fake.outputFiles = [];
  // 平台侧的真实状态：203/207 跑着、211 排队中（与种子任务的本地状态一致）
  fake.colabJobs = {
    "cb-del-203": { id: "cb-del-203", status: "running", progress: 40, stage: "生成中" },
    "cb-del-207": { id: "cb-del-207", status: "running", progress: 30, stage: "生成中" },
    "cb-del-211": { id: "cb-del-211", status: "queued", progress: 0, stage: "排队中" },
  };
  fake.galleryCalls = [];
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
    imageFileName: outputFileName("moss", id),
    webpFileName: null,
    downloadStartedAt: null,
    ...extra,
  };
}

before(async () => {
  await saveSettings({ kaggleUsername: "u", kaggleToken: "KGAT-testtoken", relayKey: "test-relay-key", galleryKey: "test-gallery-key", galleryUrl: "https://gallery.example.test" });
});

test("预置：Kaggle 跑着/排队、Colab 跑着、已完结、自动切换、还没建出的单", async () => {
  resetFake();
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      seedJob(201), // Kaggle running（已开始生成）
      seedJob(202, { status: "queued", stage: "queued" }), // Kaggle 排队中
      seedJob(203, { backend: "colab", colabJobId: "cb-del-203", kaggleRef: null, kaggleSlug: null }), // Colab running
      seedJob(204, { status: "done", stage: "done", finishedAt: Date.now(), imageFileName: "moss_test_204.png" }), // 已完成
      seedJob(205, { status: "failed", stage: "failed", finishedAt: Date.now(), error: "之前失败了" }), // 已失败
      seedJob(206, { status: "failed", stage: "failed", backend: "colab", colabJobId: "cb-del-206", kaggleRef: null, kaggleSlug: null, finishedAt: Date.now(), error: "之前失败了" }), // Colab 已失败
      // 自动切换过的单：Kaggle 满了切到 Colab，kaggleRef 本来就是 null
      seedJob(207, { backend: "colab", autoSwitchedToColab: true, colabJobId: "cb-del-207", kaggleRef: null, kaggleSlug: "app-moss-comfyui-kaggle-207" }),
      seedJob(208, { status: "queued-local", stage: "queued-local", kaggleRef: null, kaggleSlug: "app-moss-comfyui-kaggle-208" }), // 还没建出
      seedJob(209, { status: "preparing", stage: "preparing", backend: "colab", colabJobId: null, kaggleRef: null, kaggleSlug: null }), // Colab 还没拿到任务号
      seedJob(210, { status: "queued", stage: "queued" }), // Kaggle 排队中（给 404 测试用）
      seedJob(211, { status: "queued", stage: "queued", backend: "colab", colabJobId: "cb-del-211", kaggleRef: null, kaggleSlug: null }), // Colab 排队中（给 404 测试用）
      seedJob(212, { status: "queued", stage: "queued" }), // Kaggle 排队中（给取消失败测试用）
      seedJob(213, { status: "queued", stage: "queued" }), // Kaggle 排队中（给查不到状态测试用）
      seedJob(214), // Kaggle running（给平台失败的后台跟踪测试用）
    ]),
    "tianya-imagegen-counter": "214",
  });
  await initJobs();
  stopPolling();
  await sleep(50);
  assert.equal(getJobs().length, 14);
});

test("删 Kaggle running 任务：不取消、留后台跟踪，任务从列表消失", async () => {
  resetFake();
  const res = await deleteJob(201);
  assert.equal(res.ok, true);
  assert.equal(res.detached, true, "已开始生成的单删时要留后台跟踪");
  assert.equal(fake.deleteCalls.length, 0, "已开始生成就不停 kernel");
  assert.equal(fake.failCalls.length, 0);
  assert.equal(getJobs().some((j) => j.id === 201), false, "任务记录从列表删掉");
  const orphans = getOrphans();
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, 201);
  assert.equal(orphans[0].kaggleRef, "u/app-moss-comfyui-kaggle-201");
  assert.equal(orphans[0].model, "moss");
  assert.ok(orphans[0].deletedAt);
});

test("删 Kaggle 排队中任务：先调 DeleteKernel 再删本地记录", async () => {
  resetFake();
  const res = await deleteJob(202);
  assert.equal(res.ok, true);
  assert.equal(res.detached, undefined);
  assert.equal(fake.deleteCalls.length, 1);
  const call = fake.deleteCalls[0];
  assert.ok(call.url.startsWith(KAGGLE_RELAY_BASE), "取消走 Kaggle 中转，不直连 kaggle.com");
  assert.ok(call.url.includes("kernels.KernelsApiService/DeleteKernel"), "调 DeleteKernel RPC，不用 403 的 CancelKernelSession");
  assert.deepEqual(call.body, { userName: "u", kernelSlug: "app-moss-comfyui-kaggle-202" });
  assert.match(call.headers.Authorization || "", /KGAT-testtoken/);
  assert.equal(call.stillListed, true, "发取消时任务还在本地列表里（先取消、后删记录）");
  assert.equal(fake.failCalls.length, 0);
  assert.equal(getJobs().some((j) => j.id === 202), false);
  assert.equal(getOrphans().some((o) => o.id === 202), false, "排队中的单取消了，不用后台跟踪");
});

test("删 Colab running 任务：不取消、留后台跟踪", async () => {
  resetFake();
  const res = await deleteJob(203);
  assert.equal(res.ok, true);
  assert.equal(res.detached, true);
  assert.equal(fake.failCalls.length, 0, "已开始生成就不标失败");
  assert.equal(fake.deleteCalls.length, 0);
  assert.equal(getJobs().some((j) => j.id === 203), false);
  const orphan = getOrphans().find((o) => o.id === 203);
  assert.ok(orphan);
  assert.equal(orphan.colabJobId, "cb-del-203");
});

test("已完成/已失败任务不发取消、不留跟踪，直接删本地", async () => {
  resetFake();
  assert.equal((await deleteJob(204)).ok, true);
  assert.equal((await deleteJob(205)).ok, true);
  assert.equal((await deleteJob(206)).ok, true);
  assert.equal(fake.deleteCalls.length, 0);
  assert.equal(fake.failCalls.length, 0);
  assert.equal(getJobs().some((j) => [204, 205, 206].includes(j.id)), false);
  assert.equal(getOrphans().some((o) => [204, 205, 206].includes(o.id)), false);
});

test("自动切换后的任务按新后端处理：running 的 Colab 单留跟踪，不碰 Kaggle", async () => {
  resetFake();
  const res = await deleteJob(207);
  assert.equal(res.ok, true);
  assert.equal(res.detached, true);
  assert.equal(fake.failCalls.length, 0);
  assert.equal(fake.deleteCalls.length, 0, "原来那个 Kaggle 的本来就没建出来，不去取消");
  assert.equal(getJobs().some((j) => j.id === 207), false);
  assert.ok(getOrphans().find((o) => o.id === 207));
});

test("还没建出平台任务的删本地即可，不发取消、不留跟踪", async () => {
  resetFake();
  assert.equal((await deleteJob(208)).ok, true); // queued-local，无 kaggleRef
  assert.equal((await deleteJob(209)).ok, true); // preparing，无 colabJobId
  assert.equal(fake.deleteCalls.length, 0);
  assert.equal(fake.failCalls.length, 0);
  assert.equal(getOrphans().some((o) => [208, 209].includes(o.id)), false);
});

test("查不到状态按已开始处理：断网时不取消、留后台跟踪", async () => {
  resetFake();
  fake.kernelStatus = "down"; // 状态接口直接抛错
  const res = await deleteJob(213);
  assert.equal(res.ok, true);
  assert.equal(res.detached, true, "查不到状态不能断言它还在排队，不取消");
  assert.equal(fake.deleteCalls.length, 0);
  assert.equal(getJobs().some((j) => j.id === 213), false);
  assert.ok(getOrphans().find((o) => o.id === 213));
  fake.kernelStatus = "queued";
});

test("平台 404 当已取消：排队中的 Kaggle 与 Colab 单都照常删掉", async () => {
  resetFake();
  fake.deleteKernel = "404";
  fake.colabFail = "404";
  // 404 分支本身：cancelRemoteJob 直接验证一次
  assert.deepEqual(await cancelRemoteJob(getJobs().find((j) => j.id === 210)), { ok: true, alreadyGone: true });
  assert.deepEqual(await cancelRemoteJob(getJobs().find((j) => j.id === 211)), { ok: true, alreadyGone: true });
  assert.equal((await deleteJob(210)).ok, true);
  assert.equal((await deleteJob(211)).ok, true);
  assert.equal(getJobs().some((j) => [210, 211].includes(j.id)), false);
  assert.equal(getOrphans().some((o) => [210, 211].includes(o.id)), false);
});

test("取消失败：排队中的任务留着、有看得见的提示，联网后再删能删掉", async () => {
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

test("后台跟踪：Kaggle 跑完取图进本地图库，跟踪记录清理、不自动推画廊", async () => {
  resetFake();
  // 201 的跟踪还在（前面删 running 单时留下的）
  const orphan = getOrphans().find((o) => o.id === 201);
  assert.ok(orphan, "201 的后台跟踪还在");
  fake.kernelStatus = "complete";
  fake.outputFiles = [{ fileName: orphan.imageFileName, url: "https://www.kaggleusercontent.com/test/moss_201.png" }];
  await __tickForTest();
  const done = getJobs().find((j) => j.id === 201);
  assert.ok(done, "跑完的图插回任务列表（进本地图库）");
  assert.equal(done.status, "done");
  assert.equal(done.imageFileName, orphan.imageFileName);
  assert.equal(done.detachedFromDelete, true);
  assert.equal(done.galleryPushed, null, "不自动推画廊，等用户在图库里手动点上传");
  const { data } = await Filesystem.readFile({ path: `images/${orphan.imageFileName}`, directory: "DATA" });
  assert.ok(data.length > 0, "成品图已存到本机");
  assert.equal(getOrphans().some((o) => o.id === 201), false, "取图完成后跟踪记录清理");
  assert.equal(JSON.parse(__readStore("tianya-imagegen-orphans") || "[]").some((o) => o.id === 201), false, "Preferences 里的跟踪记录也清了");
  assert.equal(fake.galleryCalls.length, 0, "整个过程没碰公开画廊");
  fake.kernelStatus = "queued";
  fake.outputFiles = [];
});

test("后台跟踪：Colab 跑完取图进本地图库，跟踪记录清理", async () => {
  resetFake();
  const orphan = getOrphans().find((o) => o.id === 203);
  assert.ok(orphan, "203 的后台跟踪还在");
  fake.colabJobs["cb-del-203"] = { id: "cb-del-203", status: "done", progress: 100, stage: "完成" };
  await __tickForTest();
  await waitFor(() => getJobs().find((j) => j.id === 203)?.status === "done", 8000, "Colab 跟踪的单跑完进图库");
  const done = getJobs().find((j) => j.id === 203);
  assert.equal(done.detachedFromDelete, true);
  assert.equal(done.galleryPushed, null, "不自动推画廊");
  // PNG 后台补上：主图换成 PNG 原图（WebP+PNG 双份都在本机）
  await waitFor(() => getJobs().find((j) => j.id === 203)?.imageFileName.endsWith(".png"), 8000, "PNG 原图后台补上");
  assert.equal(getOrphans().some((o) => o.id === 203), false, "取图完成后跟踪记录清理");
  assert.equal(fake.galleryCalls.length, 0, "整个过程没碰公开画廊");
});

test("删任务不自动推公开画廊：所有取回的图都没进画廊", async () => {
  // 前面两轮后台取图跑完后，没有任何一次画廊调用，取回的图 galleryPushed 仍是 null
  assert.equal(fake.galleryCalls.length, 0);
  for (const job of getJobs().filter((j) => j.status === "done")) {
    assert.notEqual(job.galleryPushed, true, `任务 ${job.id} 不应被自动推到画廊`);
  }
});

test("后台跟踪：平台失败了变失败任务进列表（看得见），跟踪记录清理", async () => {
  resetFake();
  // 214 还在跑着：先删（留跟踪），再让平台报失败
  fake.kernelStatus = "running";
  const res = await deleteJob(214);
  assert.equal(res.detached, true);
  assert.equal(fake.deleteCalls.length, 0);
  assert.ok(getOrphans().find((o) => o.id === 214));
  fake.kernelStatus = "error";
  await __tickForTest();
  const failed = getJobs().find((j) => j.id === 214);
  assert.ok(failed, "平台失败的单插回一条失败任务，不静默丢掉");
  assert.equal(failed.status, "failed");
  assert.match(failed.error || "", /GPU OOM/);
  assert.equal(getOrphans().some((o) => o.id === 214), false, "失败后跟踪记录清理");
  fake.kernelStatus = "queued";
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
