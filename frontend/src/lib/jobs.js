// jobs.js — 任务存储（Preferences）+ 轮询引擎 + 2 并发队列。
// 任务从提交、推送、核实、排队、生成、下载回存到画廊推送的完整状态机都在这里。

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { LiveActivities } from "@ciabosoftwaresolutions/capacitor-live-activities";
import {
  MODEL_LABELS,
  NOTEBOOK_KINDS,
  base64ToBytes,
  bytesToBase64,
  kernelBaseSlug,
  outputFileName,
  patchNotebook,
  randomSeed,
  resolveSize,
} from "./notebook.js";
import { KaggleClient, KaggleError, normalizeKaggleRef } from "./kaggle.js";
import { DEFAULT_GALLERY_URL, pushToGallery } from "./gallery.js";

const PREF_JOBS = "tianya-imagegen-jobs";
const PREF_SETTINGS = "tianya-imagegen-settings";
const PREF_COUNTER = "tianya-imagegen-counter";
const PREF_ADMIN_PASSWORD = "tianya-imagegen-admin-password";

/** 管理员密码（只存在本机 Preferences，永不写进代码/仓库）。 */
export async function getAdminPassword() {
  const { value } = await Preferences.get({ key: PREF_ADMIN_PASSWORD });
  return value || null;
}

export async function setAdminPassword(pw) {
  await Preferences.set({ key: PREF_ADMIN_PASSWORD, value: String(pw) });
}

const MAX_JOBS = 50;
const MAX_ACTIVE = 2;
const POLL_MS = 20000;
const VERIFY_WINDOW_MS = 5 * 60 * 1000; // 推送后核实 Kernel 的窗口
const VERIFY_INTERVAL_MS = 30000;
const PREPARE_BACKSTOP_MS = 20 * 60 * 1000; // preparing 超过 20 分钟没确认到 kernel -> 失败
const QUEUED_BACKSTOP_MS = 6 * 3600 * 1000; // queued 超过 6 小时 -> 失败
const DOWNLOAD_BACKSTOP_MS = 10 * 60 * 1000; // downloading 重试超过 10 分钟 -> 失败
const RECONCILE_AFTER_MS = 20 * 60 * 1000; // queued/running 超过 20 分钟就探输出列表
const PROBE_BUDGET_MS = 50000;
const FIND_BUDGET_MS = 150000;

export const STAGE_LABELS = {
  "queued-local": "本地排队",
  preparing: "准备",
  queued: "排队中",
  running: "生成中",
  downloading: "下载回存",
  done: "完成",
  failed: "失败",
};

export const DEFAULT_SETTINGS = {
  kaggleUsername: "",
  kaggleToken: "",
  galleryKey: "",
  galleryUrl: DEFAULT_GALLERY_URL,
};

export function maskSecret(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminal(job) {
  return job.status === "done" || job.status === "failed";
}

function isActive(job) {
  return (
    job.status === "preparing" ||
    job.status === "queued" ||
    job.status === "running" ||
    job.status === "downloading"
  );
}

let jobs = [];
let settings = { ...DEFAULT_SETTINGS };
let counter = 0;
let pollTimer = null;
let inited = false;

const listeners = new Set();
const blobUrls = new Map(); // jobId -> Blob URL（内存里，供立即展示）
const thumbBlobUrls = new Map(); // jobId -> 缩略图 Blob URL（内存里，供图库网格展示）
const THUMB_MAX = 480; // 缩略图最长边
const THUMB_QUALITY = 0.8; // WebP 缩略图质量
const busyJobs = new Set(); // 正在执行某一步的 jobId，避免轮询重入
const verifyingJobs = new Set(); // 正在核实 kernel 的 jobId

export function onJobsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(getJobs());
    } catch {
      // 渲染失败不影响引擎
    }
  }
}

export function getJobs() {
  return jobs;
}

export function getSettings() {
  return { ...settings };
}

export function getImageSrc(job) {
  if (!job) return null;
  const mem = blobUrls.get(job.id);
  if (mem) return mem;
  if (job.imagePath) return Capacitor.convertFileSrc(job.imagePath);
  return null;
}

/** 图库网格用的 WebP 缩略图地址；还没缩略图时先用原图顶着。 */
export function getThumbSrc(job) {
  if (!job) return null;
  const mem = thumbBlobUrls.get(job.id);
  if (mem) return mem;
  if (job.thumbPath) return Capacitor.convertFileSrc(job.thumbPath);
  return getImageSrc(job);
}

function thumbFileNameFor(imageFileName) {
  return String(imageFileName || "").replace(/\.png$/i, "-thumb.webp");
}

/** 用 canvas 把 PNG bytes 转成 WebP 缩略图（最长边 480px），返回 WebP bytes；失败返回 null。 */
async function makeThumbBytes(pngBytes) {
  try {
    const blob = new Blob([pngBytes], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", THUMB_QUALITY));
    if (!out) return null;
    return new Uint8Array(await out.arrayBuffer());
  } catch {
    return null;
  }
}

/** 给一条已完成任务生成并保存 WebP 缩略图（失败不抛错，只返回 false）。 */
async function buildThumbnail(job, pngBytes) {
  if (!job || !job.imageFileName) return false;
  try {
    let bytes = pngBytes;
    if (!bytes) {
      const { data } = await Filesystem.readFile({ path: `images/${job.imageFileName}`, directory: Directory.Data });
      bytes = base64ToBytes(data);
    }
    const thumb = await makeThumbBytes(bytes);
    if (!thumb) return false;
    const thumbFileName = thumbFileNameFor(job.imageFileName);
    await Filesystem.writeFile({
      path: `images/${thumbFileName}`,
      data: bytesToBase64(thumb),
      directory: Directory.Data,
      recursive: true,
    });
    const uri = await Filesystem.getUri({ path: `images/${thumbFileName}`, directory: Directory.Data });
    thumbBlobUrls.set(job.id, URL.createObjectURL(new Blob([thumb], { type: "image/webp" })));
    job.thumbFileName = thumbFileName;
    job.thumbPath = uri.uri;
    return true;
  } catch {
    return false;
  }
}

/** 给所有已完成但还没缩略图的任务补缩略图（打开图库时调用，老图也能用上）。 */
export async function ensureThumbnails() {
  for (const job of jobs) {
    if (job.status !== "done" || !job.imageFileName || job.thumbFileName) continue;
    const ok = await buildThumbnail(job);
    if (ok) await saveJobs();
  }
}

async function saveJobs() {
  jobs = jobs.slice(0, MAX_JOBS);
  await Preferences.set({ key: PREF_JOBS, value: JSON.stringify(jobs) });
  emit();
}

export async function saveSettings(next) {
  settings = {
    kaggleUsername: String(next.kaggleUsername ?? "").trim(),
    kaggleToken: String(next.kaggleToken ?? "").trim(),
    galleryKey: String(next.galleryKey ?? "").trim(),
    galleryUrl: String(next.galleryUrl ?? "").trim() || DEFAULT_GALLERY_URL,
  };
  await Preferences.set({ key: PREF_SETTINGS, value: JSON.stringify(settings) });
  return getSettings();
}

async function loadAll() {
  try {
    const sj = await Preferences.get({ key: PREF_JOBS });
    jobs = sj.value ? JSON.parse(sj.value) : [];
    if (!Array.isArray(jobs)) jobs = [];
  } catch {
    jobs = [];
  }
  try {
    const ss = await Preferences.get({ key: PREF_SETTINGS });
    settings = ss.value ? { ...DEFAULT_SETTINGS, ...JSON.parse(ss.value) } : { ...DEFAULT_SETTINGS };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  try {
    const sc = await Preferences.get({ key: PREF_COUNTER });
    counter = sc.value ? parseInt(sc.value, 10) || 0 : 0;
  } catch {
    counter = 0;
  }
  // 计数器至少要大于已有任务的最大 id，避免重启后 id 撞车
  for (const j of jobs) {
    if (typeof j.id === "number" && j.id > counter) counter = j.id;
  }
}

async function nextJobId() {
  counter += 1;
  await Preferences.set({ key: PREF_COUNTER, value: String(counter) });
  return counter;
}

function updateJob(id, patch) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  if (patch.stage && patch.stage !== job.stage) patch.stageStartedAt = Date.now();
  const stageChanged = patch.stage && patch.stage !== job.stage;
  // 第一次进入 running 阶段时记下开始生成的时间（只记一次，之后阶段再变也不覆盖）
  if (patch.stage === "running" && job.stage !== "running" && !job.runningStartedAt) {
    patch.runningStartedAt = Date.now();
  }
  Object.assign(job, patch);
  if (stageChanged && !isTerminal(job)) syncLiveActivity(job);
  return job;
}

/** 生成完成/失败后发一条系统通知（App 在前台或后台运行时才触发；被系统挂起后等下次打开 App 轮询到结果时再补发）。 */
async function notifyJob(job, ok) {
  try {
    if (!Capacitor.isNativePlatform()) return;
    const label = MODEL_LABELS[job.model] ?? job.model;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: job.id,
          title: ok ? "出图完成" : "生成失败",
          body: ok ? `${label} 已出图，点开查看` : `${label} 生成失败，点开查看原因`,
        },
      ],
    });
  } catch {
    // 通知发不出去不影响任务本身
  }
}

// ---------------------------------------------------------------------------
// Live Activities（锁屏 / 灵动岛常驻进度 + 当前步骤）
// ---------------------------------------------------------------------------
// 只在真机 iOS 16.2+ 上生效；不支持的设备上 isSupported() 为 false，直接跳过。
// 进度条与步骤文案：title=模型名，subtitle="步骤 · 进度%"，progress=0-1，
// timerEnd=预计完成时间（倒计时系统自己走，App 挂起后也继续；进度%则只在
// App 运行时更新）。失败不影响任务本身，全部 try/catch 包住。
const liveSyncAt = new Map(); // jobId -> 上次同步时间戳（节流用）
const LIVE_SYNC_MIN_MS = 15000; // 同步间隔下限 15 秒（阶段变化时立即同步）

function liveStateFor(job) {
  const { pct, label } = getJobProgress(job);
  const estTotalMs = estimateGenerateMs(job.model, job.width, job.height) + 5 * 60 * 1000;
  return {
    title: MODEL_LABELS[job.model] ?? job.model,
    subtitle: `${label || "处理中"} · ${pct}%`,
    progress: Math.min(1, Math.max(0, pct / 100)),
    timerEnd: Math.round((job.createdAt + estTotalMs) / 1000),
    timerStart: Math.round(job.createdAt / 1000),
    timerCountsDown: false,
    progressColor: "#a855f7",
    backgroundColor: "#1a1a2e",
  };
}

async function startLiveActivity(job) {
  try {
    if (!Capacitor.isNativePlatform()) return;
    const { supported } = await LiveActivities.isSupported();
    if (!supported) return;
    const { activityId } = await LiveActivities.start({
      attributes: { activityType: "tianya-imagegen" },
      state: liveStateFor(job),
    });
    job.liveActivityId = activityId;
    liveSyncAt.set(job.id, Date.now());
    await saveJobs();
  } catch {
    // Live Activity 不可用不影响任务本身
  }
}

async function syncLiveActivity(job, force = false) {
  try {
    if (!Capacitor.isNativePlatform()) return;
    if (!job || isTerminal(job)) return;
    const last = liveSyncAt.get(job.id) || 0;
    const stageChanged = job.stage !== (job._lastLiveStage || null);
    if (!force && !stageChanged && Date.now() - last < LIVE_SYNC_MIN_MS) return;
    job._lastLiveStage = job.stage;
    const state = liveStateFor(job);
    if (job.liveActivityId) {
      try {
        await LiveActivities.update({ activityId: job.liveActivityId, state });
        liveSyncAt.set(job.id, Date.now());
        return;
      } catch {
        // 旧活动已不存在（App 重启后），下面重新开一个
      }
    }
    const { supported } = await LiveActivities.isSupported();
    if (!supported) return;
    const { activityId } = await LiveActivities.start({
      attributes: { activityType: "tianya-imagegen" },
      state,
    });
    job.liveActivityId = activityId;
    liveSyncAt.set(job.id, Date.now());
    await saveJobs();
  } catch {
    // 同步失败不影响任务本身
  }
}

async function endLiveActivity(job, ok) {
  try {
    if (!Capacitor.isNativePlatform()) return;
    if (!job.liveActivityId) return;
    const { pct, label } = getJobProgress(job);
    await LiveActivities.end({
      activityId: job.liveActivityId,
      finalState: {
        title: MODEL_LABELS[job.model] ?? job.model,
        subtitle: ok ? `完成 · ${pct}%` : `${label || "失败"}`,
        progress: ok ? 1 : 0,
      },
      dismissalPolicy: "default",
    });
  } catch {
    // 结束失败不影响任务本身
  } finally {
    job.liveActivityId = null;
    liveSyncAt.delete(job.id);
  }
}

async function failJob(job, message) {
  updateJob(job.id, {
    status: "failed",
    stage: "failed",
    stageDetail: String(message).slice(0, 200),
    error: String(message).slice(0, 1000),
    finishedAt: Date.now(),
  });
  await saveJobs();
  notifyJob(job, false);
  endLiveActivity(job, false);
  pumpQueue();
}

function makeClient() {
  return new KaggleClient({ username: settings.kaggleUsername, key: settings.kaggleToken });
}

function requireCreds() {
  if (!settings.kaggleUsername || !settings.kaggleToken) {
    throw new Error("请先在设置里完成配置，再提交生图。");
  }
}

/** 提交一单：只建记录进本地队列，由 pumpQueue 按 2 并发启动。 */
export async function submitJob({ model, prompt, ratioKey = "auto" }) {
  requireCreds();
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("提示词不能为空。");
  if (cleanPrompt.length > 10000) throw new Error("提示词超过 10000 字上限。");
  if (!NOTEBOOK_KINDS[model]) throw new Error(`未知的模型：${model}`);
  const size = resolveSize(model, ratioKey, cleanPrompt);
  const id = await nextJobId();
  const job = {
    id,
    model,
    prompt: cleanPrompt,
    ratioKey,
    width: size.width,
    height: size.height,
    seed: randomSeed(),
    status: "queued-local",
    stage: "queued-local",
    stageDetail: "本地排队，等空闲的云端会话",
    kaggleRef: null,
    kaggleSlug: null,
    createdAt: Date.now(),
    pushedAt: null,
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: null, // 开始生成的时间（第一次进入 running 阶段才记，只记一次）；用于算“开始生成到出图”的用时
    finishedAt: null,
    error: null,
    imagePath: null,
    imageFileName: outputFileName(model, id),
    galleryPushed: null,
    galleryError: null,
    regeneratedFrom: null, // 重新生成时，指向原图任务 id
    regeneratedBy: null, // 被重新生成时，指向新图任务 id
    liveActivityId: null, // 锁屏 / 灵动岛常驻活动的 id（仅本机，不进画廊）
    outputResumeToken: null,
    outputScanned: 0,
    downloadStartedAt: null,
  };
  jobs.unshift(job);
  await saveJobs();
  startLiveActivity(job);
  pumpQueue();
  return job;
}

/** 失败任务重提：同参数、新种子、新任务号。 */
export async function retryJob(id) {
  const old = jobs.find((j) => j.id === id);
  if (!old) throw new Error("找不到这条任务");
  return submitJob({ model: old.model, prompt: old.prompt, ratioKey: old.ratioKey || "auto" });
}

/** 重新生成：同提示词/模型/比例新开一个任务（新种子），旧图保留，两图互相关联，方便对比。 */
export async function regenerateJob(id) {
  const old = jobs.find((j) => j.id === id);
  if (!old) throw new Error("找不到这张图");
  if (old.status !== "done") throw new Error("这张图还没完成，不能重新生成");
  const job = await submitJob({ model: old.model, prompt: old.prompt, ratioKey: old.ratioKey || "auto" });
  job.regeneratedFrom = old.id;
  old.regeneratedBy = job.id;
  await saveJobs();
  return job;
}

/** 找一对重新生成关联里另一张已完成的图（原图或新图），没有返回 null。 */
export function getRegenPair(job) {
  if (!job) return null;
  const otherId = job.regeneratedFrom || job.regeneratedBy;
  if (!otherId) return null;
  const other = jobs.find((j) => j.id === otherId);
  if (!other || other.status !== "done" || !getImageSrc(other)) return null;
  return other;
}

// 生成耗时估算（毫秒）：按参考尺寸实测时间，再按像素数缩放。只是估算，环不会卡死在 88% 以内。
const GEN_BASE_MS = {
  moss: { ms: 46 * 60 * 1000, px: 1696 * 2256 },
  qwen: { ms: 75 * 1000, px: 1024 * 1024 },
  krea2: { ms: 120 * 1000, px: 1024 * 1024 },
  zimage: { ms: 60 * 1000, px: 1024 * 1024 },
};

function estimateGenerateMs(model, width, height) {
  const base = GEN_BASE_MS[model] || GEN_BASE_MS.moss;
  const px = Math.max(1, (width || 1) * (height || 1));
  return Math.max(30 * 1000, base.ms * (px / base.px));
}

/** 任务进度：返回 { pct 0-100, label 阶段名 }。生成中按已耗时/估算推进，30%→88%。 */
export function getJobProgress(job) {
  if (!job) return { pct: 0, label: "" };
  const label = STAGE_LABELS[job.stage] || job.stage || "";
  if (job.status === "done") return { pct: 100, label: "完成" };
  if (job.status === "failed") return { pct: 0, label: "失败" };
  switch (job.stage) {
    case "queued-local":
      return { pct: 5, label };
    case "preparing":
      return { pct: 15, label };
    case "queued":
      return { pct: 25, label };
    case "running": {
      const since = job.stageStartedAt || job.createdAt || Date.now();
      const est = estimateGenerateMs(job.model, job.width, job.height);
      const frac = Math.min(1, Math.max(0, (Date.now() - since) / est));
      return { pct: Math.round(30 + frac * 58), label };
    }
    case "downloading":
      return { pct: 95, label };
    default:
      return { pct: 0, label };
  }
}

/** 手动推送到画廊（图库多选推送用）：读本机图片文件，按画廊设置推送，更新任务状态。 */
export async function pushJobToGallery(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error("找不到这条任务");
  if (job.status !== "done" || !job.imageFileName) throw new Error("这张图还没完成，推不了");
  if (!settings.galleryKey) throw new Error("请先在设置里填好画廊推送密钥");
  let bytes;
  try {
    const { data } = await Filesystem.readFile({ path: `images/${job.imageFileName}`, directory: Directory.Data });
    bytes = base64ToBytes(data);
  } catch {
    throw new Error("本机图片文件读不到，推不了");
  }
  const push = await pushToGallery({
    url: settings.galleryUrl,
    key: settings.galleryKey,
    job,
    pngBytes: bytes,
    fileName: job.imageFileName,
  });
  updateJob(job.id, {
    galleryPushed: push.ok,
    galleryError: push.ok ? null : push.error,
  });
  await saveJobs();
  return push;
}

export async function deleteJob(id) {
  const job = jobs.find((j) => j.id === id);
  jobs = jobs.filter((j) => j.id !== id);
  await saveJobs();
  if (job?.imageFileName) {
    try {
      await Filesystem.deleteFile({ path: `images/${job.imageFileName}`, directory: Directory.Data });
    } catch {
      // 文件删不掉不影响记录删除
    }
    if (job.thumbFileName) {
      try {
        await Filesystem.deleteFile({ path: `images/${job.thumbFileName}`, directory: Directory.Data });
      } catch {
        // 缩略图删不掉不影响
      }
    }
  }
  const url = blobUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrls.delete(id);
  }
  const thumbUrl = thumbBlobUrls.get(id);
  if (thumbUrl) {
    URL.revokeObjectURL(thumbUrl);
    thumbBlobUrls.delete(id);
  }
  pumpQueue();
}

function activeCount() {
  return jobs.filter(isActive).length;
}

/** 2 并发：有空位就把最老的本地排队任务启动起来。 */
function pumpQueue() {
  if (activeCount() >= MAX_ACTIVE) return;
  const waiting = [...jobs].reverse().find((j) => j.status === "queued-local");
  if (!waiting) return;
  runJob(waiting);
}

async function loadTemplate(model) {
  const file = NOTEBOOK_KINDS[model].file;
  const url = `${import.meta.env.BASE_URL}notebooks/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`模板 ${file} 读不到（HTTP ${res.status}）`);
  return res.text();
}

/** 推送后核实 kernel 存在：每 30s 双通道查一次，最多 5 分钟。成功返回 true。 */
async function verifyKernel(job, client) {
  if (verifyingJobs.has(job.id)) return false;
  verifyingJobs.add(job.id);
  try {
    const deadline = job.verifyDeadlineAt || Date.now() + VERIFY_WINDOW_MS;
    while (Date.now() < deadline) {
      const chk = await client.confirmKernelExists(job.kaggleRef);
      if (chk.exists) {
        const state = chk.state;
        updateJob(job.id, {
          status: state === "running" ? "running" : state === "complete" ? "running" : "queued",
          stage: state === "running" || state === "complete" ? "running" : "queued",
          stageDetail:
            state === "running"
              ? "云端已开始运行"
              : state === "complete"
                ? "云端已跑完，正在取图"
                : "已确认任务存在，云端排队中",
        });
        await saveJobs();
        return true;
      }
      if (chk.authError) {
        await failJob(job, chk.authError);
        return false;
      }
      updateJob(job.id, {
        stageDetail: `云端已接受推送，正在核实（${chk.detail}）`,
      });
      await saveJobs();
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(VERIFY_INTERVAL_MS, left));
      // 任务可能在等待期间被删
      if (!jobs.some((j) => j.id === job.id)) return false;
    }
    await failJob(
      job,
      `云端推送当时返回了成功（${job.kaggleRef}），但 5 分钟内反复核实都没在云端找到这个任务。推送没有真正在云端建出任务，任务从未进入排队。可以点「重新提交」再试。`,
    );
    return false;
  } finally {
    verifyingJobs.delete(job.id);
  }
}

/** 一单的提交流程：改 notebook ->（MOSS 先验数据集）-> push -> 核实 kernel。 */
async function runJob(job) {
  if (busyJobs.has(job.id)) return;
  busyJobs.add(job.id);
  try {
    requireCreds();
    const client = makeClient();
    updateJob(job.id, { status: "preparing", stage: "preparing", stageDetail: "正在准备 notebook…" });
    await saveJobs();

    const templateText = await loadTemplate(job.model);
    const { text } = patchNotebook(templateText, {
      model: job.model,
      prompt: job.prompt,
      width: job.width,
      height: job.height,
      seed: job.seed,
      jobId: job.id,
    });

    let datasetSources = [];
    if (job.model === "moss") {
      updateJob(job.id, { stageDetail: "正在确认 Moody 模型数据集…" });
      await saveJobs();
      const resolved = await client.resolveMoodyDatasetRef();
      if (!resolved.ref) {
        if (resolved.conclusive) {
          throw new Error(
            "云端找不到 Moody 模型数据集（moody-moss-mix-v33）里的完整模型文件，推送已取消。请先确认数据集已建好、文件大小无误，再重新提交。",
          );
        }
        throw new Error("暂时连不上云端，没法确认模型数据集，请稍后重试。");
      }
      datasetSources = [resolved.ref];
      updateJob(job.id, { stageDetail: `模型数据集已确认（${resolved.ref}），正在推送…` });
      await saveJobs();
    }

    const slug = `${kernelBaseSlug(job.model)}-${job.id}`;
    const push = await client.pushKernel({
      slug,
      title: slug,
      text,
      datasetSources,
    });
    if (datasetSources.length > 0) {
      const bad = push.invalidDatasetSources || [];
      if (bad.some((s) => datasetSources.includes(s))) {
        throw new Error(`云端拒绝挂接模型数据集（${datasetSources.join("、")}）：推送已取消，请检查数据集是否存在且为私有。`);
      }
    }
    const kaggleRef =
      normalizeKaggleRef(push.ref) ||
      normalizeKaggleRef(push.url) ||
      `${settings.kaggleUsername}/${slug}`;
    updateJob(job.id, {
      kaggleRef,
      kaggleSlug: slug,
      pushedAt: Date.now(),
      verifyDeadlineAt: Date.now() + VERIFY_WINDOW_MS,
      stageDetail: "云端已接受推送，正在核实…",
    });
    await saveJobs();

    await verifyKernel(job, client);
  } catch (e) {
    const current = jobs.find((j) => j.id === job.id);
    if (current && !isTerminal(current)) {
      await failJob(job, e instanceof Error ? e.message : String(e));
    }
  } finally {
    busyJobs.delete(job.id);
    pumpQueue();
  }
}

/** 在输出列表里找结果图，找到就进入下载；找不到只更新说明，不判失败。 */
async function probeOutput(job, client, budgetMs = PROBE_BUDGET_MS) {
  const found = await client.findOutputFile(job.kaggleRef, job.imageFileName, {
    budgetMs,
    resumeToken: job.outputResumeToken,
    resumeScanned: job.outputScanned || 0,
  });
  updateJob(job.id, {
    outputResumeToken: found.resumeToken ?? null,
    outputScanned: found.scanned || 0,
  });
  await saveJobs();
  if (found.ok && found.url) return found.url;
  if (found.error) {
    updateJob(job.id, { stageDetail: found.error.slice(0, 200) });
    await saveJobs();
  }
  return null;
}

/** 下载回存 + 保存文件 + 画廊推送。 */
async function finishJob(job, url = null) {
  if (busyJobs.has(job.id)) return;
  busyJobs.add(job.id);
  const client = makeClient();
  try {
    updateJob(job.id, {
      status: "downloading",
      stage: "downloading",
      stageDetail: "正在下载结果图…",
      downloadStartedAt: Date.now(),
    });
    await saveJobs();

    let downloadUrl = url;
    if (!downloadUrl) {
      const found = await client.findOutputFile(job.kaggleRef, job.imageFileName, {
        budgetMs: FIND_BUDGET_MS,
        resumeToken: job.outputResumeToken,
        resumeScanned: job.outputScanned || 0,
      });
      updateJob(job.id, {
        outputResumeToken: found.resumeToken ?? null,
        outputScanned: found.scanned || 0,
      });
      await saveJobs();
      if (!found.ok || !found.url) {
        // 没找到不是失败：回滚到 running，等下一轮轮询再找
        updateJob(job.id, {
          status: "running",
          stage: "running",
          stageDetail: (found.error || "还没在输出列表里找到结果图，等下一轮再找").slice(0, 200),
          downloadStartedAt: null,
        });
        await saveJobs();
        return;
      }
      downloadUrl = found.url;
    }

    const bytes = await client.downloadPng(downloadUrl);
    const base64 = bytesToBase64(bytes);
    await Filesystem.writeFile({
      path: `images/${job.imageFileName}`,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
    const uri = await Filesystem.getUri({ path: `images/${job.imageFileName}`, directory: Directory.Data });
    blobUrls.set(job.id, URL.createObjectURL(new Blob([bytes], { type: "image/png" })));

    // 图库网格用的 WebP 缩略图（失败不影响出图）
    const doneJob = jobs.find((j) => j.id === job.id) || job;
    await buildThumbnail(doneJob, bytes);

    updateJob(job.id, {
      status: "done",
      stage: "done",
      stageDetail: "已完成，图片已保存",
      finishedAt: Date.now(),
      imagePath: uri.uri,
      downloadStartedAt: null,
    });
    await saveJobs();
    notifyJob(job, true);
    endLiveActivity(job, true);

    // 不自动推送画廊：图只保存在本机，用户在图库里手动多选推送。
  } catch (e) {
    const current = jobs.find((j) => j.id === job.id);
    if (!current || isTerminal(current)) return;
    // 下载失败先留在 downloading，下一轮再试；超过 10 分钟才判失败
    const since = current.downloadStartedAt || Date.now();
    if (Date.now() - since > DOWNLOAD_BACKSTOP_MS) {
      await failJob(job, e instanceof KaggleError || e instanceof Error ? e.message : String(e));
    } else {
      updateJob(job.id, {
        status: "downloading",
        stage: "downloading",
        stageDetail: `下载回存遇到问题，下一轮再试：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`,
      });
      await saveJobs();
    }
  } finally {
    busyJobs.delete(job.id);
    pumpQueue();
  }
}

/** 一轮轮询：每个活跃任务各查一次状态。 */
async function tick() {
  const actives = jobs.filter(isActive);
  for (const job of actives) {
    if (!jobs.some((j) => j.id === job.id) || busyJobs.has(job.id)) continue;
    const now = Date.now();
    try {
      if (job.status === "preparing") {
        // 推送前中断的 preparing（应用重启后）：没有 kaggleRef 说明根本没推上去
        if (!job.kaggleRef) {
          await failJob(job, "上次提交在准备阶段中断（应用重启前没来得及推送），请重新提交。");
          continue;
        }
        if (job.verifyDeadlineAt && now > job.verifyDeadlineAt) {
          await failJob(job, "推送后 5 分钟内没在云端核实到任务，任务从未进入排队。可以点「重新提交」再试。");
          continue;
        }
        if (now - (job.pushedAt || job.createdAt) > PREPARE_BACKSTOP_MS) {
          await failJob(job, "准备阶段超过 20 分钟仍没确认到任务，已自动结束。请重新提交。");
          continue;
        }
        if (!verifyingJobs.has(job.id)) verifyKernel(job, makeClient());
        continue;
      }

      if (job.status === "downloading") {
        if (job.downloadStartedAt && now - job.downloadStartedAt > DOWNLOAD_BACKSTOP_MS) {
          await failJob(job, "下载回存重试超过 10 分钟仍没成功，已自动结束。可以点「重新提交」再试。");
          continue;
        }
        finishJob(job);
        continue;
      }

      // queued / running
      if (!job.kaggleRef) continue;
      if (now - job.createdAt > QUEUED_BACKSTOP_MS && job.status === "queued") {
        await failJob(job, "云端排队超过 6 小时仍没开始，已自动结束。可以点「重新提交」再试。");
        continue;
      }
      const client = makeClient();
      const st = await client.kernelStatus(job.kaggleRef);
      if (!jobs.some((j) => j.id === job.id)) continue;
      if (st.error && String(st.error).includes("401")) {
        await failJob(job, st.error);
        continue;
      }
      if (st.state === "complete") {
        await finishJob(job);
        continue;
      }
      if (st.state === "error") {
        await failJob(job, `云端运行失败${st.failure ? `：${st.failure}` : "（云端没给具体原因）"}`);
        continue;
      }
      if (st.state === "queued" || st.state === "running") {
        const nextStatus = st.state;
        const stageAge = now - (job.pushedAt || job.createdAt);
        updateJob(job.id, {
          status: nextStatus,
          stage: nextStatus,
          stageDetail:
            nextStatus === "running"
              ? "云端正在生成"
              : `云端排队中（已等约 ${Math.max(1, Math.round(stageAge / 60000))} 分钟）`,
        });
        await saveJobs();
        // 排队/运行超过 20 分钟：状态接口可能不报完成，探输出列表兜底
        if (stageAge > RECONCILE_AFTER_MS) {
          const url = await probeOutput(job, client);
          if (url) await finishJob(job, url);
        }
        continue;
      }
      // unknown 或状态接口报错：写明原因，并探输出列表（#43 的教训）
      updateJob(job.id, {
        stageDetail: st.error
          ? `状态接口暂时查不到：${String(st.error).slice(0, 120)}，正在翻输出列表找结果图`
          : `云端返回了不认识的状态${st.raw ? `「${st.raw}」` : ""}，正在翻输出列表找结果图`,
      });
      await saveJobs();
      const url = await probeOutput(job, client);
      if (url) await finishJob(job, url);
    } catch (e) {
      // 单个任务的轮询异常不能打断整轮；下一次轮询再试
      const current = jobs.find((j) => j.id === job.id);
      if (current && !isTerminal(current)) {
        updateJob(job.id, {
          stageDetail: `轮询遇到问题，下一轮再试：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`,
        });
        await saveJobs().catch(() => undefined);
      }
    }
  }
  // 每轮顺带同步一次常驻活动的进度（内部 15 秒节流；阶段变化时 updateJob 里已立即同步）
  for (const job of jobs.filter(isActive)) syncLiveActivity(job);
}

export function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    tick().catch(() => undefined);
  }, POLL_MS);
  tick().catch(() => undefined);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 应用打开时恢复：未终态的任务继续轮询；中断在准备阶段的按规则处理。 */
export async function initJobs() {
  if (inited) return;
  inited = true;
  await loadAll();
  // 重启后：preparing 但没推上去的任务直接失败（runJob 已不在）
  for (const job of [...jobs]) {
    if (job.status === "preparing" && !job.kaggleRef) {
      await failJob(job, "上次提交在准备阶段中断（应用重启前没来得及推送），请重新提交。");
    }
  }
  await saveJobs();
  startPolling();
  pumpQueue();
}
