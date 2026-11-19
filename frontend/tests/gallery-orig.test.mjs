// tests/gallery-orig.test.mjs — 推图成功后后台补 PNG 原图（attach-orig）。
// 跑法：npm test。fetch 桩模拟画廊 upload.php / attach-orig 与 Kaggle 输出
// 列表 + PNG 下载；Filesystem 桩用内存文件表；任务只走 pushJobToGallery，
// 不跑生图流程。补原图是 fire-and-forget：推图成功即算成功，补不上只把
// 原因记进任务记录（galleryOrigPushed/galleryOrigError），不标任务失败、
// 不重试、不弹窗——下面每个失败用例都断言这一点。
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import { getJobs, initJobs, pushJobToGallery, stopPolling } from "../src/lib/jobs.js";
import { pushToGallery } from "../src/lib/gallery.js";
import { pngDimensions } from "../src/lib/kaggle.js";
import { bytesToBase64 } from "../src/lib/notebook.js";

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

const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

/** 最小 PNG：8 字节魔数 + IHDR（宽/高大端 uint32），CRC 不填（不校验）。 */
function makePng(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8); // IHDR 长度
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes[24] = 8; // 位深
  bytes[25] = 2; // 颜色类型 RGB
  return bytes;
}

function jsonRes(status, obj) {
  const text = JSON.stringify(obj);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
    json: async () => obj,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

function bytesRes(bytes) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => "application/octet-stream" },
    text: async () => "",
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
}

// ---- fetch 桩的行为开关（各用例按需改，文件内测试按顺序跑）----
const attachCalls = []; // {id, imageSize}
let uploadId = "20261119000000-abcdef"; // null = 回包里没有 id
let attachResponse = { status: 200, body: { ok: true, id: "20261119000000-abcdef", orig: "images/20261119000000-abcdef.png" } };

function listFilesFor(slug) {
  const m = /-(\d+)$/.exec(slug || "");
  const id = m ? m[1] : "4";
  // 9 号单的内核输出里没有 PNG（只剩 WebP）：模拟“找不到成品图”。
  if (id === "9") {
    return [{ fileName: "moss_dash_9.webp", url: "https://www.kaggleusercontent.com/x/moss_dash_9.webp" }];
  }
  return [
    { fileName: `moss_dash_${id}.png`, url: `https://www.kaggleusercontent.com/x/moss_dash_${id}.png` },
    { fileName: `moss_dash_${id}.webp`, url: `https://www.kaggleusercontent.com/x/moss_dash_${id}.webp` },
  ];
}

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("attach-orig")) {
    const body = init?.body;
    const id = typeof body?.get === "function" ? body.get("id") : null;
    const image = typeof body?.get === "function" ? body.get("image") : null;
    attachCalls.push({ id, imageSize: image?.size ?? null });
    return jsonRes(attachResponse.status, attachResponse.body);
  }
  if (u.includes("upload.php")) {
    return jsonRes(200, uploadId ? { ok: true, id: uploadId, url: `images/${uploadId}.webp` } : { ok: true });
  }
  if (u.includes("ListKernelSessionOutput")) {
    let slug = "";
    try {
      slug = JSON.parse(String(init?.body || "{}")).kernelSlug || "";
    } catch {
      slug = "";
    }
    return jsonRes(200, { files: listFilesFor(slug) });
  }
  const m = /moss_dash_(\d+)\.png/.exec(u);
  if (m) {
    // 7 号单的 PNG 尺寸故意错（1024×1536，任务是 2560×3840）：模拟尺寸对不上。
    const dims = m[1] === "7" ? [1024, 1536] : [2560, 3840];
    return bytesRes(makePng(dims[0], dims[1]));
  }
  throw new Error(`测试桩没预料到的请求：${u}`);
};

function doneJob(id, extra = {}) {
  return {
    id, model: "moss", prompt: "p", seed: id, width: 2560, height: 3840, ratioKey: "r2x3v",
    status: "done", stage: "done", stageDetail: "已完成，图片已保存",
    createdAt: Date.now() - 60000, finishedAt: Date.now() - 60000,
    kaggleRef: `u/app-moss-comfyui-kaggle-${id}`, backend: "kaggle", colabJobId: null,
    imageFileName: `moss_dash_${id}.webp`, webpFileName: `moss_dash_${id}.webp`,
    galleryPushed: null, galleryError: null, galleryOrigPushed: null, galleryOrigError: null,
    ...extra,
  };
}

before(async () => {
  __seedStore({
    "tianya-imagegen-settings": JSON.stringify({
      kaggleUsername: "u", kaggleToken: "t", galleryKey: "k",
      galleryUrl: "https://example.invalid/upload.php",
    }),
    "tianya-imagegen-jobs": JSON.stringify([
      doneJob(4),
      doneJob(5),
      // 6 号是 Colab 单：没有 kaggleRef，补原图应跳过。
      doneJob(6, { backend: "colab", kaggleRef: null, colabJobId: "cb-test-6" }),
      doneJob(7),
      doneJob(8),
      doneJob(9),
    ]),
    "tianya-imagegen-counter": "9",
  });
  for (const id of [4, 5, 6, 7, 8, 9]) {
    await Filesystem.writeFile({ path: `images/moss_dash_${id}.webp`, data: bytesToBase64(WEBP_BYTES) });
  }
  await initJobs();
});

function jobById(id) {
  return getJobs().find((j) => j.id === id);
}

test("pngDimensions：读 IHDR 尺寸；不是 PNG / 太短 / IHDR 标记不对返回 null", () => {
  assert.deepEqual(pngDimensions(makePng(2560, 3840)), { width: 2560, height: 3840 });
  assert.deepEqual(pngDimensions(makePng(1024, 1536)), { width: 1024, height: 1536 });
  assert.equal(pngDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null); // 太短
  const badMagic = makePng(1, 1);
  badMagic[0] = 0x00;
  assert.equal(pngDimensions(badMagic), null);
  const badIhdr = makePng(1, 1);
  badIhdr[12] = 0x00;
  assert.equal(pngDimensions(badIhdr), null);
  assert.equal(pngDimensions(null), null);
});

test("pushToGallery：成功回包里的画廊图 id 要带出来", async () => {
  uploadId = "20261119000000-abcdef";
  const res = await pushToGallery({
    url: "https://example.invalid/upload.php",
    key: "k",
    job: { model: "qwen", prompt: "p", seed: 1, width: 1024, height: 1024, createdAt: Date.now() },
    imageBytes: WEBP_BYTES,
    fileName: "qwen_dash_1.webp",
    contentType: "image/webp",
  });
  assert.equal(res.ok, true);
  assert.equal(res.galleryId, "20261119000000-abcdef");
});

test("pushJobToGallery 成功后，后台把 PNG 原图补上（Kaggle 单）", async () => {
  uploadId = "20261119000000-abcdef";
  attachResponse = { status: 200, body: { ok: true, id: uploadId, orig: `images/${uploadId}.png` } };
  attachCalls.length = 0;
  const res = await pushJobToGallery(4);
  assert.equal(res.ok, true);
  const job = jobById(4);
  assert.equal(job.galleryPushed, true);
  await waitFor(() => jobById(4)?.galleryOrigPushed === true, 8000, "后台补原图完成");
  assert.equal(jobById(4).galleryOrigPushed, true);
  assert.equal(jobById(4).galleryOrigError, null);
  assert.equal(attachCalls.length, 1);
  assert.equal(attachCalls[0].id, "20261119000000-abcdef");
  assert.equal(attachCalls[0].imageSize, makePng(2560, 3840).length);
});

test("补原图被画廊拒绝：推图仍算成功，失败原因记进任务记录", async () => {
  uploadId = "20261119000000-abcdef";
  attachResponse = { status: 403, body: { ok: false, error: "密钥不对" } };
  attachCalls.length = 0;
  const res = await pushJobToGallery(5);
  assert.equal(res.ok, true);
  await waitFor(() => jobById(5)?.galleryOrigPushed === false, 8000, "补原图失败记进任务记录");
  assert.equal(jobById(5).galleryPushed, true);
  assert.equal(jobById(5).galleryOrigPushed, false);
  assert.match(jobById(5).galleryOrigError, /密钥不对/);
  assert.equal(attachCalls.length, 1);
});

test("Colab 单跳过补原图：不调 attach-orig，不记错", async () => {
  attachCalls.length = 0;
  const res = await pushJobToGallery(6);
  assert.equal(res.ok, true);
  await sleep(400); // 给后台一点时间，确认它真的没跑
  assert.equal(jobById(6).galleryPushed, true);
  assert.equal(jobById(6).galleryOrigPushed, null);
  assert.equal(jobById(6).galleryOrigError, null);
  assert.equal(attachCalls.length, 0);
});

test("PNG 尺寸与任务最终尺寸对不上：不贴，只记原因", async () => {
  uploadId = "20261119000000-abcdef";
  attachResponse = { status: 200, body: { ok: true, id: uploadId, orig: `images/${uploadId}.png` } };
  attachCalls.length = 0;
  const res = await pushJobToGallery(7);
  assert.equal(res.ok, true);
  await waitFor(() => jobById(7)?.galleryOrigPushed === false, 8000, "尺寸对不上记进任务记录");
  assert.equal(jobById(7).galleryPushed, true);
  assert.match(jobById(7).galleryOrigError, /对不上/);
  assert.equal(attachCalls.length, 0);
});

test("画廊回包里没有图 id：不贴，只记原因", async () => {
  uploadId = null;
  attachCalls.length = 0;
  const res = await pushJobToGallery(8);
  assert.equal(res.ok, true);
  await waitFor(() => jobById(8)?.galleryOrigPushed === false, 8000, "没有图 id 记进任务记录");
  assert.equal(jobById(8).galleryPushed, true);
  assert.match(jobById(8).galleryOrigError, /图 id/);
  assert.equal(attachCalls.length, 0);
  uploadId = "20261119000000-abcdef"; // 恢复，后面的用例还要用
});

test("内核输出里没找到 PNG：不贴，只记原因", async () => {
  uploadId = "20261119000000-abcdef";
  attachResponse = { status: 200, body: { ok: true, id: uploadId, orig: `images/${uploadId}.png` } };
  attachCalls.length = 0;
  const res = await pushJobToGallery(9);
  assert.equal(res.ok, true);
  await waitFor(() => jobById(9)?.galleryOrigPushed === false, 8000, "找不到 PNG 记进任务记录");
  assert.equal(jobById(9).galleryPushed, true);
  assert.match(jobById(9).galleryOrigError, /没找到/);
  assert.equal(attachCalls.length, 0);
});
