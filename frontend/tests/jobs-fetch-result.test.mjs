// tests/jobs-fetch-result.test.mjs — 取图线（v1.2.25）：
// ① 文件名错位修法：App 不再按任务号拼文件名去找，扫 kernel 输出列表找
//    实际产出的最终图（{prefix}_数字.png/.webp），排除 lowres 中间文件和 log；
//    今晚实锤用例：任务 17、kernel 13、输出 moss_dash_16.png，三个号全对不上。
// ② 下载 404 不死循环：记成卡住（downloadStuck），给一句含实际文件名的人话，
//    轮询不再自动重试，点「重新取回」才真正再试。
// ③ 查输出列表网络异常自动重试 3 次（带退避），都失败才报人话；轮询一次失败
//    不打回状态、不让用户看到状态来回跳。
// 跑法：npm test。fetch 桩模拟 Kaggle 中转；Filesystem 桩用内存文件表。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import { Filesystem, __resetFiles } from "./stubs/capacitor-filesystem.mjs";
import {
  __tickForTest,
  getJobs,
  initJobs,
  refetchJob,
  saveSettings,
  stopPolling,
} from "../src/lib/jobs.js";
import { KAGGLE_RELAY_BASE, KaggleClient } from "../src/lib/kaggle.js";
import { outputFileName } from "../src/lib/notebook.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  stopPolling();
  __resetStore();
  __resetFiles();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, timeoutMs = 15000, what = "条件") {
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

const OUT = (name, size) => ({
  fileName: name,
  url: `https://storage.googleapis.com/kaggle-output/${name}`,
  ...(size != null ? { size } : {}),
});

// 可编程的平台行为（每个测试按需改）
const fake = {
  kernelBySlug: {}, // kernelSlug -> "queued" | "running" | "complete" | "error"
  outputBySlug: {}, // kernelSlug -> 单页文件列表
  outputPages: {}, // kernelSlug -> 每页文件列表的数组（翻页用）
  listMode: "ok", // "ok" | "throw-once" | "throw-always"
  listCalls: 0,
  listCallsBySlug: {},
  dl404: false, // /dl 下载回 404（只对 moss_dash_16.png）
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
  if (u.includes("GetKernelSessionStatus")) {
    const body = JSON.parse(opts?.body || "{}");
    const state = fake.kernelBySlug[body.kernelSlug] || "running";
    if (state === "running") return jsonRes(200, { status: "RUNNING" });
    if (state === "complete") return jsonRes(200, { status: "COMPLETE" });
    if (state === "error") return jsonRes(200, { status: "ERROR", failureMessage: "GPU OOM" });
    return jsonRes(200, { status: "QUEUED" });
  }
  if (u.includes("ListKernelSessionOutput")) {
    fake.listCalls++;
    const body = JSON.parse(opts?.body || "{}");
    const slug = body.kernelSlug;
    fake.listCallsBySlug[slug] = (fake.listCallsBySlug[slug] || 0) + 1;
    if (fake.listMode === "throw-always") throw new TypeError("fetch failed");
    if (fake.listMode === "throw-once" && fake.listCallsBySlug[slug] === 1) {
      throw new TypeError("fetch failed");
    }
    const pages = fake.outputPages[slug];
    if (pages) {
      const idx = body.pageToken ? parseInt(body.pageToken, 10) : 0;
      return jsonRes(200, {
        files: pages[idx] ?? [],
        nextPageToken: idx + 1 < pages.length ? String(idx + 1) : null,
      });
    }
    return jsonRes(200, { files: fake.outputBySlug[slug] ?? [], nextPageToken: null });
  }
  if (u.includes("kernels/list")) {
    return jsonRes(200, []);
  }
  if (u.startsWith(`${KAGGLE_RELAY_BASE}/dl?`)) {
    if (fake.dl404 && u.includes("moss_dash_16.png")) {
      return jsonRes(404, { error: { code: 404, message: "not found" } });
    }
    return bytesRes(u.includes(".webp") ? WEBP_BYTES : PNG_BYTES);
  }
  throw new Error(`测试桩没接这个 URL：${method} ${u}`);
};

function resetFake() {
  fake.kernelBySlug = {};
  fake.outputBySlug = {};
  fake.outputPages = {};
  fake.listMode = "ok";
  fake.listCalls = 0;
  fake.listCallsBySlug = {};
  fake.dl404 = false;
}

function seedJob(id, extra) {
  return {
    id,
    model: "moss",
    prompt: `fetch result test ${id}`,
    ratioKey: "auto",
    width: 1280,
    height: 1920,
    seed: 4000 + id,
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

function job(id) {
  return getJobs().find((j) => j.id === id);
}

before(async () => {
  await saveSettings({ kaggleUsername: "u", kaggleToken: "KGAT-testtoken", relayKey: "test-relay-key", galleryKey: "test-gallery-key", galleryUrl: "https://gallery.example.test" });
});

test("预置：7 个 Kaggle running 单（17/18 三号错位、19 lowres、20 404、21/22 重试、23 探输出）", async () => {
  resetFake();
  const old = Date.now() - 25 * 60 * 1000;
  __seedStore({
    "tianya-imagegen-jobs": JSON.stringify([
      // 17：今晚实锤那单——任务 17、kernel 13、输出 moss_dash_16.png
      seedJob(17, { kaggleRef: "u/app-moss-comfyui-kaggle-13", kaggleSlug: "app-moss-comfyui-kaggle-13" }),
      // 18：重提同一单——任务 18，kernel 14，输出还是 moss_dash_16.png
      seedJob(18, { kaggleRef: "u/app-moss-comfyui-kaggle-14", kaggleSlug: "app-moss-comfyui-kaggle-14" }),
      seedJob(19), // 只有 lowres
      seedJob(20), // 下载 404
      seedJob(21), // 查列表单次断网
      seedJob(22), // 查列表一直断网
      seedJob(23, { pushedAt: old, stageStartedAt: old }), // 跑了 25 分钟，探输出兜底
    ]),
    "tianya-imagegen-counter": "23",
  });
  await initJobs();
  stopPolling();
  await sleep(50);
  assert.equal(getJobs().length, 7);
});

test("任务 17 / kernel 13 / 输出 moss_dash_16.png：三个号对不上，仍能取回实际文件", async () => {
  resetFake();
  fake.kernelBySlug = { "app-moss-comfyui-kaggle-13": "complete" };
  fake.outputBySlug = {
    "app-moss-comfyui-kaggle-13": [
      OUT("moss_lowres_00001_.png", 120000),
      OUT("moss_dash_16.png", 10584088),
      OUT("moss_dash_16.webp", 966408),
    ],
  };
  await __tickForTest();
  const j = job(17);
  assert.equal(j.status, "done", "不再按任务号找 moss_dash_17.png，实际文件 moss_dash_16.png 能取回");
  assert.equal(j.stageDetail, "已完成，图片已保存");
  // WebP 先行写盘；PNG 后台补，补完主图换成 PNG 原图
  await Filesystem.readFile({ path: "images/moss_dash_17.webp" });
  await waitFor(
    async () => {
      try {
        await Filesystem.readFile({ path: "images/moss_dash_17.png" });
        return true;
      } catch {
        return false;
      }
    },
    8000,
    "后台 PNG（moss_dash_17.png）写盘",
  );
  await waitFor(() => job(17).imageFileName === "moss_dash_17.png", 8000, "后台 PNG 补完主图换成 PNG");
  // 其他单不受影响：18 的 kernel 还在跑，19/20/21/22 也还在跑
  assert.equal(job(18).status, "running");
});

test("重提同一单（任务 18 / kernel 14 / 输出仍是 moss_dash_16.png）：仍能取回实际文件", async () => {
  resetFake();
  fake.kernelBySlug = { "app-moss-comfyui-kaggle-14": "complete" };
  fake.outputBySlug = {
    "app-moss-comfyui-kaggle-14": [
      OUT("moss_lowres_00001_.png", 120000),
      OUT("moss_dash_16.png", 10584088),
      OUT("moss_dash_16.webp", 966408),
    ],
  };
  await __tickForTest();
  const j = job(18);
  assert.equal(j.status, "done", "重提后任务号又变了，仍按实际文件取回");
  await waitFor(() => job(18).imageFileName === "moss_dash_18.png", 8000, "后台 PNG 补完主图换成 PNG");
});

test("输出列表里只有 lowres：不误判为成品，直接判失败并说清原因，不死循环", async () => {
  resetFake();
  fake.kernelBySlug = { "app-moss-comfyui-kaggle-19": "complete" };
  fake.outputBySlug = {
    "app-moss-comfyui-kaggle-19": [
      OUT("moss_lowres_00001_.png", 120000),
      { fileName: "moss_dash_19.log", url: "https://storage.googleapis.com/kaggle-output/moss_dash_19.log" },
    ],
  };
  await __tickForTest();
  const j = job(19);
  assert.equal(j.status, "failed", "只有 lowres 不是成品，判失败而不是回滚到 running 死循环");
  assert.match(j.error || "", /没找到这单的成品图/);
  assert.match(j.error || "", /共扫 2 个文件/);
  // 再跑两轮：失败是终态，不会再翻、不再跳
  await __tickForTest();
  await __tickForTest();
  assert.equal(job(19).status, "failed");
});

test("下载 404：记成卡住、给一句含实际文件名的人话，轮询不再自动重试；修好后点「重新取回」能真正取回", async () => {
  resetFake();
  fake.kernelBySlug = { "app-moss-comfyui-kaggle-20": "complete" };
  fake.outputBySlug = {
    // 只有 PNG，没有 WebP：走 PNG 主路才会撞上 404
    "app-moss-comfyui-kaggle-20": [OUT("moss_dash_16.png", 10584088)],
  };
  fake.dl404 = true;
  await __tickForTest();
  let j = job(20);
  assert.equal(j.status, "downloading", "404 不是网络断开，留在 downloading 等用户处理");
  assert.equal(j.downloadStuck, true, "404 要记成卡住");
  assert.match(j.stageDetail || "", /moss_dash_16\.png/, "人话里要写云端实际文件名");
  assert.match(j.stageDetail || "", /重新取回/);
  const callsAfterStuck = fake.listCallsBySlug["app-moss-comfyui-kaggle-20"] || 0;
  const detailAfterStuck = j.stageDetail;
  // 再跑两轮：卡住了不再自动重试，状态一动不动（23 号单的探输出还会查它自己的列表，不管它）
  await __tickForTest();
  await __tickForTest();
  j = job(20);
  assert.equal(j.status, "downloading");
  assert.equal(j.downloadStuck, true);
  assert.equal(j.stageDetail, detailAfterStuck, "状态不乱跳");
  assert.equal(
    fake.listCallsBySlug["app-moss-comfyui-kaggle-20"] || 0,
    callsAfterStuck,
    "卡住后不再查这单的输出列表",
  );
  // 还 404 时点「重新取回」：清掉卡住标记、真正再试一次，结果还是卡住
  await refetchJob(20);
  j = job(20);
  assert.equal(j.downloadStuck, true);
  assert.match(j.stageDetail || "", /moss_dash_16\.png/);
  // 修好下载再点「重新取回」：真正取回，任务完成
  fake.dl404 = false;
  await refetchJob(20);
  j = job(20);
  assert.equal(j.status, "done");
  assert.equal(j.downloadStuck ?? null, null);
  assert.equal(j.imageFileName, "moss_dash_20.png");
});

test("查输出列表单次网络异常：自动重试，重试后成功能继续取图", async () => {
  resetFake();
  fake.kernelBySlug = { "app-moss-comfyui-kaggle-21": "complete" };
  fake.outputBySlug = {
    "app-moss-comfyui-kaggle-21": [
      OUT("moss_lowres_00001_.png", 120000),
      OUT("moss_dash_16.png", 10584088),
      OUT("moss_dash_16.webp", 966408),
    ],
  };
  fake.listMode = "throw-once";
  await __tickForTest();
  const j = job(21);
  assert.equal(j.status, "done", "第一次断了、重试通了，图照样取回");
  assert.equal(
    fake.listCallsBySlug["app-moss-comfyui-kaggle-21"],
    2,
    "单次异常只多发一次请求（重试 1 次即成功）",
  );
});

test("查输出列表一直断网：重试 3 次都失败才报提示，状态留在 downloading 不乱跳", async () => {
  resetFake();
  fake.kernelBySlug = { "app-moss-comfyui-kaggle-22": "complete" };
  fake.outputBySlug = {
    "app-moss-comfyui-kaggle-22": [
      OUT("moss_dash_16.png", 10584088),
      OUT("moss_dash_16.webp", 966408),
    ],
  };
  fake.listMode = "throw-always";
  await __tickForTest();
  let j = job(22);
  assert.equal(j.status, "downloading", "断网不判失败，等恢复");
  assert.match(j.stageDetail || "", /网络暂时断开/, "多次失败后报一句人话，不是一上来就报连不上");
  assert.equal(fake.listCallsBySlug["app-moss-comfyui-kaggle-22"], 3, "一轮里重试了 3 次");
  const detail = j.stageDetail;
  // 再跑一轮：还是 downloading、同一句提示，不在状态之间来回跳
  await __tickForTest();
  j = job(22);
  assert.equal(j.status, "downloading");
  assert.equal(j.stageDetail, detail, "第二轮提示不变，不乱跳");
  assert.equal(fake.listCallsBySlug["app-moss-comfyui-kaggle-22"], 6, "每轮都重试 3 次");
  // 网络恢复后下一轮：正常取回（也证明断网那次没把任务弄坏）
  fake.listMode = "ok";
  await __tickForTest();
  assert.equal(job(22).status, "done");
});

test("轮询探输出时查列表断网：不改任务状态、不写报错，保持上次的状态继续等", async () => {
  resetFake();
  fake.kernelBySlug = { "app-moss-comfyui-kaggle-23": "running" };
  fake.outputBySlug = { "app-moss-comfyui-kaggle-23": [] };
  fake.listMode = "throw-always";
  const before = fake.listCallsBySlug["app-moss-comfyui-kaggle-23"] || 0;
  await __tickForTest();
  const j = job(23);
  assert.equal(j.status, "running");
  assert.match(j.stageDetail || "", /云端正在生成/, "探输出失败不改状态，保留上次的进度说明");
  assert.doesNotMatch(j.stageDetail || "", /连不上|网络不太稳/, "不把报错写进进度里吓用户");
  assert.equal(
    fake.listCallsBySlug["app-moss-comfyui-kaggle-23"] - before,
    3,
    "探输出那次请求也重试了 3 次",
  );
});

// ---- findResultImage 单元测试（直接调 KaggleClient，不走任务轮询） ----

function resultClient() {
  return new KaggleClient({ username: "u", key: "KGAT-testtoken" });
}

test("findResultImage：多个候选时取最大的（有 size 按 size），WebP 配同号 PNG", async () => {
  resetFake();
  fake.outputBySlug = {
    "app-moss-comfyui-kaggle-99": [
      OUT("moss_dash_15.png", 100),
      OUT("moss_dash_16.png", 10584088),
      OUT("moss_dash_16.webp", 966408),
      OUT("moss_lowres_00001_.png", 99999999),
    ],
  };
  const disc = await resultClient().findResultImage("u/app-moss-comfyui-kaggle-99", {
    prefix: "moss_dash",
    preferredId: 17,
  });
  assert.equal(disc.png?.fileName, "moss_dash_16.png", "lowres 再大也不算成品；15 号比 16 号小");
  assert.equal(disc.webp?.fileName, "moss_dash_16.webp", "WebP 配同号的 PNG");
  assert.equal(disc.exhausted, true);
  assert.equal(disc.scanned, 4);
});

test("findResultImage：与任务号同号的优先（哪怕它比别的小）", async () => {
  resetFake();
  fake.outputBySlug = {
    "app-moss-comfyui-kaggle-99": [
      OUT("moss_dash_17.png", 100),
      OUT("moss_dash_16.png", 999999),
    ],
  };
  const disc = await resultClient().findResultImage("u/app-moss-comfyui-kaggle-99", {
    prefix: "moss_dash",
    preferredId: 17,
  });
  assert.equal(disc.png?.fileName, "moss_dash_17.png", "同号优先于最大");
});

test("findResultImage：只有 lowres 和 log 时不误判，exhausted=true", async () => {
  resetFake();
  fake.outputBySlug = {
    "app-moss-comfyui-kaggle-99": [
      OUT("moss_lowres_00001_.png", 120000),
      { fileName: "moss_dash_99.log", url: "https://storage.googleapis.com/kaggle-output/moss_dash_99.log" },
    ],
  };
  const disc = await resultClient().findResultImage("u/app-moss-comfyui-kaggle-99", {
    prefix: "moss_dash",
    preferredId: 99,
  });
  assert.equal(disc.png, null);
  assert.equal(disc.webp, null);
  assert.equal(disc.exhausted, true);
  assert.equal(disc.scanned, 2);
});

test("findResultImage：输出列表翻两页，第二页的文件也能找到", async () => {
  resetFake();
  fake.outputPages = {
    "app-moss-comfyui-kaggle-99": [
      [OUT("moss_lowres_00001_.png", 120000)],
      [OUT("moss_dash_16.png", 10584088), OUT("moss_dash_16.webp", 966408)],
    ],
  };
  const disc = await resultClient().findResultImage("u/app-moss-comfyui-kaggle-99", {
    prefix: "moss_dash",
    preferredId: 17,
  });
  assert.equal(disc.png?.fileName, "moss_dash_16.png");
  assert.equal(disc.webp?.fileName, "moss_dash_16.webp");
  assert.equal(disc.exhausted, true);
  assert.equal(disc.scanned, 3);
  assert.equal(fake.listCallsBySlug["app-moss-comfyui-kaggle-99"], 2, "翻了两页");
});

test("findResultImage：没有 size 时按文件名数字取最新的一次产出", async () => {
  resetFake();
  fake.outputBySlug = {
    "app-moss-comfyui-kaggle-99": [OUT("moss_dash_15.png"), OUT("moss_dash_16.png")],
  };
  const disc = await resultClient().findResultImage("u/app-moss-comfyui-kaggle-99", {
    prefix: "moss_dash",
    preferredId: 17,
  });
  assert.equal(disc.png?.fileName, "moss_dash_16.png");
});
