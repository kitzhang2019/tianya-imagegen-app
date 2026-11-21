// tests/jobs-redownload.test.mjs — v1.2.28「重新下载」：失败在下载回存的任务
// （云端已生成完、10 分钟内没下回来）卡片上给「重新下载」按钮，只重试下载
// 同一份云端成品，不重新提交、不重新生成、不换种子；云端成品已取不回
// （kernel 已删 / 中转已没这单）时如实说、按钮撤掉；再失败也不判丢，按钮
// 保留可反复点。真实案例：2026-11-21 用户截图，Krea2 Kaggle 单（2560×4544）
// 下载回存超 10 分钟被判失败，卡片只有「重新提交」（重新生成、白白浪费
// GPU 时间和额度），图在云端其实还在。
// 跑法：npm test。fetch 桩模拟 Kaggle API + Colab 中转；Filesystem 桩用内存
// 文件表；createImageBitmap 在 Node 里不存在，缩略图会静默失败（不影响出图），
// 这是预期的。下载桩用 downloadMode 开关：good = 返回真图；oversize = 返回
// 超过 20MB 的图（下载立即报“超过 20MB 回存上限”，不走 2s/4s 重试退避，
// 测试跑得快；也不是“内容不对”，不会进 downloadStuck，轮询上限到了会再判失败）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __saveJobsForTest,
  __tickForTest,
  getJobs,
  initJobs,
  refetchJob,
  stopPolling,
} from "../src/lib/jobs.js";
import { COLAB_RELAY_BASE } from "../src/lib/colab.js";

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
// 超过 20MB 回存上限的图：下载立即报“超过 20MB 回存上限”（KaggleError，
// 不重试、不走退避），且不是“内容不对”，不会进 downloadStuck。
const OVERSIZE_BYTES = new Uint8Array(21 * 1024 * 1024);

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

// 下载开关：good = 返回真图；oversize = 返回超大图（立即失败、不重试）。
let downloadMode = "good";
// 22 号单的 kernel 已被删：状态接口回 404。
const GONE_SLUGS = new Set(["kaggle-22"]);

function slugIdFromBody(opts) {
  const m = String(opts?.body || "").match(/kaggle-(\d+)/);
  return m ? Number(m[1]) : 9;
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  // Colab 中转：/job/<id> 查状态，/job/<id>/webp|png 下图。
  if (u.startsWith(COLAB_RELAY_BASE)) {
    const m = u.match(new RegExp(`^${COLAB_RELAY_BASE.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}/job/([^/]+)(?:/(webp|png))?$`));
    if (!m) throw new Error(`测试桩没预料到的请求：${u}`);
    const [, id, format] = m;
    if (format === "webp") return bytesRes(WEBP_BYTES);
    if (format === "png") return bytesRes(PNG_BYTES);
    if (id === "cb-t31") return jsonRes(200, { ok: true, job: { id, status: "done", progress: 100, stage: "已完成" } });
    return jsonRes(404, { ok: false, error: "not found" });
  }
  // Kaggle：状态接口——22 号单的 kernel 已删，回 404；其余回 COMPLETE。
  if (u.includes("GetKernelSessionStatus")) {
    const id = slugIdFromBody(opts);
    if (GONE_SLUGS.has(`kaggle-${id}`)) return jsonRes(404, { code: 404, message: "Not Found" });
    return jsonRes(200, { status: "COMPLETE" });
  }
  // Kaggle：输出列表——按请求里的任务号回同号成品图。
  if (u.includes("ListKernelSessionOutput")) {
    const id = slugIdFromBody(opts);
    return jsonRes(200, {
      files: [
        { fileName: `moss_dash_${id}.png`, url: `https://www.kaggleusercontent.com/x/moss_dash_${id}.png` },
        { fileName: `moss_dash_${id}.webp`, url: `https://www.kaggleusercontent.com/x/moss_dash_${id}.webp` },
      ],
    });
  }
  // Kaggle：下图（经中转 /dl，URL 里仍带原文件名）。
  const dl = u.match(/moss_dash_(\d+)\.(webp|png)/);
  if (dl) {
    if (downloadMode === "oversize") return bytesRes(OVERSIZE_BYTES);
    return bytesRes(dl[2] === "webp" ? WEBP_BYTES : PNG_BYTES);
  }
  throw new Error(`测试桩没预料到的请求：${u}`);
};

const NOW = Date.now();
const ELEVEN_MIN_AGO = NOW - 11 * 60 * 1000;

function baseJob(id, extra) {
  return {
    id, model: "moss", prompt: "p", seed: id, width: 2560, height: 3840, ratioKey: "r2x3v",
    createdAt: NOW - 60000, pushedAt: NOW - 60000, stageStartedAt: NOW - 60000,
    kaggleRef: `u/app-moss-comfyui-kaggle-${id}`, imageFileName: `moss_dash_${id}.png`,
    loraKeys: ["guanlan"], useUpscale: true,
    ...extra,
  };
}

async function seedAndInit() {
  __seedStore({
    "tianya-imagegen-settings": JSON.stringify({ kaggleUsername: "u", kaggleToken: "t", relayKey: "test-relay-key", galleryKey: "", galleryUrl: "" }),
    "tianya-imagegen-jobs": JSON.stringify([
      // 21 号单：Kaggle，失败在下载（10 分钟上限到），kernel 还在。
      baseJob(21, {
        status: "failed", stage: "failed", stageDetail: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        error: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        finishedAt: NOW - 10000, downloadStartedAt: ELEVEN_MIN_AGO, failedAtDownload: true,
      }),
      // 22 号单：Kaggle，失败在下载，但 kernel 已被删（取不回来了）。
      baseJob(22, {
        status: "failed", stage: "failed", stageDetail: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        error: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        finishedAt: NOW - 10000, downloadStartedAt: ELEVEN_MIN_AGO, failedAtDownload: true,
      }),
      // 23 号单：Kaggle，生成失败（不是下载失败），没有下载失败标记。
      baseJob(23, {
        status: "failed", stage: "failed", stageDetail: "云端运行失败",
        error: "云端运行失败", finishedAt: NOW - 10000,
      }),
      // 24 号单：正在下载、时钟 1 分钟前——种子时先记成卡住，让 initJobs 那
      // 轮轮询跳过它（不然那轮就会直接取图完成）；tick 测试里再清掉卡住标记、
      // 把时钟拨到 11 分钟前，验证 10 分钟上限判失败时记下载失败标记。
      baseJob(24, {
        status: "downloading", stage: "downloading", stageDetail: "正在下载结果图…",
        downloadStartedAt: NOW - 60000, downloadStuck: true,
      }),
      // 25 号单：Kaggle，失败在下载——用来走“再失败也不判丢、按钮保留可反复点”整轮。
      baseJob(25, {
        status: "failed", stage: "failed", stageDetail: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        error: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        finishedAt: NOW - 10000, downloadStartedAt: ELEVEN_MIN_AGO, failedAtDownload: true,
      }),
      // 31 号单：Colab，失败在下载，中转那边已跑完。恢复核查时间记成现在，
      // 让 initJobs 那轮轮询跳过自动恢复（本文件测手动重新下载那条路）。
      {
        id: 31, model: "krea2", prompt: "p", seed: 31, width: 1280, height: 1600, ratioKey: "auto",
        status: "failed", stage: "failed", stageDetail: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        error: "下载回存重试超过 10 分钟仍没成功，已自动结束。",
        createdAt: NOW - 60000, pushedAt: NOW - 60000, stageStartedAt: NOW - 60000,
        backend: "colab", colabJobId: "cb-t31", kaggleRef: null, imageFileName: "krea2_test_31.png",
        finishedAt: NOW - 10000, downloadStartedAt: ELEVEN_MIN_AGO, failedAtDownload: true,
        colabRecoveryCheckedAt: NOW,
      },
    ]),
    "tianya-imagegen-counter": "31",
  });
  await initJobs();
  // initJobs 启动的轮询会立刻跑一轮（种子单都是终态/卡住/恢复核查刚做过，
  // 不会触发下载）；停掉 20 秒定时器、等这轮跑完，再手动点重新下载。
  stopPolling();
  await sleep(300);
}

test("redownload：Kaggle 失败在下载的单，点重新下载只取回成品、不重新提交", async () => {
  await seedAndInit();
  const beforeCount = getJobs().length;
  downloadMode = "good";
  await refetchJob(21);
  await waitFor(
    () => getJobs().find((j) => j.id === 21)?.status === "done" && getJobs().find((j) => j.id === 21)?.imageFileName === "moss_dash_21.webp",
    8000,
    "21 号单先以 WebP 完成",
  );
  const mid = getJobs().find((j) => j.id === 21);
  assert.equal(mid.status, "done");
  assert.equal(mid.failedAtDownload, false, "完成后下载失败标记应清掉");
  await waitFor(() => getJobs().find((j) => j.id === 21)?.imageFileName === "moss_dash_21.png", 8000, "后台 PNG 到了主图换回 PNG");
  const job = getJobs().find((j) => j.id === 21);
  assert.equal(job.status, "done");
  assert.equal(job.webpFileName, "moss_dash_21.webp");
  assert.equal(getJobs().length, beforeCount, "重新下载不能新开任务");
  await Filesystem.readFile({ path: "images/moss_dash_21.webp" });
  await Filesystem.readFile({ path: "images/moss_dash_21.png" });
});

test("redownload：kernel 已删的单，点重新下载如实说取不回来、按钮撤掉", async () => {
  await assert.rejects(() => refetchJob(22), /云端已找不到这单任务.*取不回来/);
  const job = getJobs().find((j) => j.id === 22);
  assert.equal(job.status, "failed");
  assert.equal(job.failedAtDownload, false, "取不回来就不再是“失败在下载”，按钮撤掉");
  assert.match(job.stageDetail, /重新提交/);
});

test("redownload：生成失败的单（不是下载失败）仍拒绝，继续请点重新提交", async () => {
  await assert.rejects(() => refetchJob(23), /重新提交/);
  const job = getJobs().find((j) => j.id === 23);
  assert.equal(job.status, "failed");
  assert.ok(!job.failedAtDownload, "生成失败的单没有下载失败标记（老任务字段本身就不存在）");
});

test("redownload：Colab 失败在下载的单，中转已跑完，点重新下载取回成品", async () => {
  downloadMode = "good";
  await refetchJob(31);
  await waitFor(
    () => getJobs().find((j) => j.id === 31)?.status === "done" && getJobs().find((j) => j.id === 31)?.imageFileName === "krea2_test_31.webp",
    8000,
    "31 号单先以 WebP 完成",
  );
  await waitFor(() => getJobs().find((j) => j.id === 31)?.imageFileName === "krea2_test_31.png", 8000, "后台 PNG 到了主图换回 PNG");
  const job = getJobs().find((j) => j.id === 31);
  assert.equal(job.status, "done");
  assert.equal(job.failedAtDownload, false);
});

test("redownload：10 分钟下载上限判失败时，记下载失败标记、文案提重新下载", async () => {
  const j24 = getJobs().find((j) => j.id === 24);
  assert.equal(j24.status, "downloading");
  // 清掉卡住标记、把时钟拨到 11 分钟前，再跑一轮轮询。
  j24.downloadStuck = null;
  j24.downloadStartedAt = Date.now() - 11 * 60 * 1000;
  await __saveJobsForTest();
  await __tickForTest();
  const job = getJobs().find((j) => j.id === 24);
  assert.equal(job.status, "failed");
  assert.equal(job.failedAtDownload, true, "下载上限判失败应记成失败在下载");
  assert.match(job.stageDetail, /重新下载/);
});

test("redownload：再失败也不判丢，按钮保留可反复点，通了就回来", async () => {
  // 第一次重下：下载立即失败（超大图），任务留在 downloading，没判失败。
  downloadMode = "oversize";
  await refetchJob(25);
  let job = getJobs().find((j) => j.id === 25);
  assert.equal(job.status, "downloading", "再失败也不判失败，生成结果没丢");
  assert.ok(job.downloadStartedAt && Date.now() - job.downloadStartedAt < 60 * 1000, "下载时钟应重置为现在");
  // 时钟拨到 11 分钟前，再跑一轮轮询：上限到，重新判失败，标记回来，按钮保留。
  job.downloadStartedAt = Date.now() - 11 * 60 * 1000;
  await __saveJobsForTest();
  await __tickForTest();
  job = getJobs().find((j) => j.id === 25);
  assert.equal(job.status, "failed");
  assert.equal(job.failedAtDownload, true, "第二次下载失败仍记成失败在下载，按钮保留");
  // 再点一次，这回下载通了，图回来。
  downloadMode = "good";
  await refetchJob(25);
  await waitFor(() => getJobs().find((j) => j.id === 25)?.status === "done", 8000, "25 号单重新下载成功");
  job = getJobs().find((j) => j.id === 25);
  assert.equal(job.status, "done");
  assert.equal(job.failedAtDownload, false);
});
