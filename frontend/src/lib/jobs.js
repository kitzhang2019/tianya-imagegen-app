// jobs.js — 任务存储（Preferences）+ 轮询引擎 + 2 并发队列。
// 任务从提交、推送、核实、排队、生成、下载回存到画廊推送的完整状态机都在这里。

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { LiveActivities } from "@ciabosoftwaresolutions/capacitor-live-activities";
import {
  DEFAULT_MOSS_LORA_KEYS,
  DEFAULT_ZIMAGE_LORA_KEYS,
  MODEL_LABELS,
  NOTEBOOK_KINDS,
  appKernelSlug,
  base64ToBytes,
  bytesToBase64,
  collectDatasetSources,
  normalizeLoraKeys,
  normalizeMossLoraKeys,
  normalizeUseUpscale,
  outputFileName,
  patchNotebook,
  randomSeed,
  resolveSize,
} from "./notebook.js";
import { KaggleClient, KaggleError, isNetworkErrorText, normalizeKaggleRef } from "./kaggle.js";
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
const QUEUED_BACKSTOP_MS = 6 * 3600 * 1000; // queued 超过 6 小时 -> 失败
const DOWNLOAD_BACKSTOP_MS = 10 * 60 * 1000; // downloading 重试超过 10 分钟 -> 失败
const RECONCILE_AFTER_MS = 20 * 60 * 1000; // queued/running 超过 20 分钟就探输出列表
const QUEUE_ALLOWANCE_MS = 5 * 60 * 1000; // 预估总时长里的排队留量（与 Live Activities 预计完成时间同一口径）
export const QUEUE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 排队超时后自动核查的刷新间隔：约 10 分钟再查一次
export const QUEUE_CHECK_AFTER_MS = 30 * 60 * 1000; // 排队核查的触发：进排队超过 30 分钟就核查（绝对时长，四模型统一；不再按预估总时长算）
const PROBE_BUDGET_MS = 50000;
const FIND_BUDGET_MS = 150000;

/** 网络是否断开（代理断了 / Kaggle 连不上）。
 * 断开时任何未完成任务都不标失败，只显示“网络暂时断开，正在重连…”并等网络恢复后
 * 按固定 slug 核对云端再决定——这是防重复提交的核心。 */
let networkDown = false;
const networkListeners = new Set();
export function isNetworkDown() {
  return networkDown;
}
/** 订阅网络断开/恢复（main.js 的断网横条用它切换显示）。 */
export function onNetworkChange(fn) {
  networkListeners.add(fn);
  return () => networkListeners.delete(fn);
}
function setNetworkDown(v) {
  if (networkDown === v) return;
  networkDown = v;
  for (const fn of [...networkListeners]) {
    try {
      fn(v);
    } catch {
      /* 订阅方出错不影响主流程 */
    }
  }
}

export const STAGE_LABELS = {
  "queued-local": "本地排队",
  preparing: "准备",
  confirming: "待确认",
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
  const estTotalMs = estimateTotalMs(job);
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

/** 提交一单：只建记录进本地队列，由 pumpQueue 按 2 并发启动。
 * useLora：Krea2 的 LoRA 开关（默认带）；loraKeys：MOSS 的 LoRA 选择（默认只带
 * 观澜，空数组 = 不挂）/ Z-Image 的 LoRA 选择（默认全带）。useUpscale：超分
 * 开关（默认开，false = 底图直接当成品、不挂 SeedVR 数据集）。 */
export async function submitJob({ model, prompt, ratioKey = "auto", useLora, loraKeys, useUpscale, kaggleSlug }) {
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
    // LoRA 选择随任务持久化：MOSS 存 key 列表（默认只带观澜；旧任务只有 useLora
    // 开关时，false = 不挂，否则默认只带观澜），Krea2 存开关（默认带），
    // Z-Image 存 key 列表（默认全带）。重提/重新生成按原选择重放。
    useLora: model === "krea2" ? useLora !== false : undefined,
    loraKeys:
      model === "moss"
        ? normalizeMossLoraKeys(loraKeys ?? (useLora === false ? [] : DEFAULT_MOSS_LORA_KEYS))
        : model === "zimage"
          ? normalizeLoraKeys(loraKeys ?? DEFAULT_ZIMAGE_LORA_KEYS)
          : undefined,
    // 超分开关随任务持久化（默认开；老任务没有该字段时按开处理，见 normalizeUseUpscale）。
    // 重提/重新生成按原选择重放。
    useUpscale: normalizeUseUpscale(useUpscale),
    width: size.width,
    height: size.height,
    seed: randomSeed(),
    status: "queued-local",
    stage: "queued-local",
    stageDetail: "本地排队，等空闲的云端会话",
    kaggleRef: null,
    // 固定 slug：提交时就按任务 id 定死、存进任务，重推复用同一个 slug，
    // 绝不每次尝试现算新 slug。带 app- 前缀，与管理站的同名 kernel 区分开
    // （两边任务号各自计数，撞车会互相覆盖对方的 kernel）。
    kaggleSlug: kaggleSlug || appKernelSlug(model, id),
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

/** 失败任务重提：先按固定 slug 查云端——
 *  - 云端已有这单在跑/排队：直接恢复旧任务轮询，不建新任务、不再 push（防重复提交）；
 *  - 确认云端没有：新开任务（新任务号、新种子），但复用同一个 slug；
 *  - 网络还没恢复、查不到：不建新任务，直接报错，等网络恢复后再点。
 * LoRA 选择与超分开关原样带上。 */
export async function retryJob(id) {
  const old = jobs.find((j) => j.id === id);
  if (!old) throw new Error("找不到这条任务");
  requireCreds();
  const slug = old.kaggleSlug || appKernelSlug(old.model, old.id);
  const ref = `${settings.kaggleUsername}/${slug}`;
  const chk = await makeClient().confirmKernelExists(ref);
  if (chk.exists) {
    // 云端这单还在：恢复旧任务，继续轮询它，不再 push
    setNetworkDown(false);
    updateJob(old.id, {
      status: "preparing",
      stage: "preparing",
      kaggleRef: ref,
      kaggleSlug: slug,
      pushedAt: old.pushedAt || Date.now(),
      verifyDeadlineAt: Date.now() + VERIFY_WINDOW_MS,
      stageDetail: "云端已找到这单任务，恢复轮询…",
      error: null,
      finishedAt: null,
    });
    await saveJobs();
    verifyKernel(old, makeClient());
    return old;
  }
  if (chk.authError) throw new Error(chk.authError);
  if (chk.inconclusive) {
    setNetworkDown(true);
    throw new Error("网络还没恢复，无法确认云端这单的状态，稍后再点重新提交。");
  }
  return submitJob({ model: old.model, prompt: old.prompt, ratioKey: old.ratioKey || "auto", useLora: old.useLora, loraKeys: old.loraKeys, useUpscale: old.useUpscale, kaggleSlug: slug });
}

/** 重新生成：同提示词/模型/比例新开一个任务（新种子），旧图保留，两图互相关联，方便对比。 */
export async function regenerateJob(id) {
  const old = jobs.find((j) => j.id === id);
  if (!old) throw new Error("找不到这张图");
  if (old.status !== "done") throw new Error("这张图还没完成，不能重新生成");
  const job = await submitJob({ model: old.model, prompt: old.prompt, ratioKey: old.ratioKey || "auto", useLora: old.useLora, loraKeys: old.loraKeys, useUpscale: old.useUpscale });
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
  moss: { ms: 46 * 60 * 1000, px: 2560 * 3840 }, // 2026-11-16：底图改 1280 后，2:3 实测约 46 分钟（测试单 moss-test2-1280base-20261116b，推送到完成）
  qwen: { ms: 75 * 1000, px: 1024 * 1024 },
  krea2: { ms: 120 * 1000, px: 1024 * 1024 },
  zimage: { ms: 60 * 1000, px: 1024 * 1024 },
};

function estimateGenerateMs(model, width, height) {
  const base = GEN_BASE_MS[model] || GEN_BASE_MS.moss;
  const px = Math.max(1, (width || 1) * (height || 1));
  return Math.max(30 * 1000, base.ms * (px / base.px));
}

/** 预估总时长（毫秒）：生成估算 + 5 分钟排队留量。Live Activities 的
 * 预计完成时间（timerEnd = createdAt + 预估总时长）用这个口径，预估算法
 * 本身不动；排队自动核查的触发不再用它（见 QUEUE_CHECK_AFTER_MS）。 */
export function estimateTotalMs(job) {
  return estimateGenerateMs(job.model, job.width, job.height) + QUEUE_ALLOWANCE_MS;
}

/** 是不是“排队已超时”：处在排队阶段，且从进排队起已超过 30 分钟。
 * 绝对时长，四模型统一；不再按预估总时长算（MOSS 一单预估约 80 分钟，
 * 排队 50 分钟也触发不了）。进排队时间以 stageStartedAt 为准（切 stage
 * 时更新），没有就退回 createdAt。6 小时排队硬上限另算。 */
export function isQueueOverdue(job, now = Date.now()) {
  if (!job || job.stage !== "queued") return false;
  const since = job.stageStartedAt || job.createdAt || now;
  return now - since > QUEUE_CHECK_AFTER_MS;
}

/** 核查结论 -> 括号备注文案（北京时间 HH:MM）。结论只有四种：
 * queued=仍在排队，running=已在生成，has-output=已有输出文件，
 * queued-no-output=仍在排队，暂无输出文件。 */
export function formatQueueCheckNote(conclusion, atMs) {
  const time = new Date(atMs).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
  const text = {
    queued: "仍在排队",
    running: "已在生成",
    "has-output": "已有输出文件",
    "queued-no-output": "仍在排队，暂无输出文件",
  }[conclusion];
  return `（${time} 自动核查：${text ?? "仍在排队"}）`;
}

/** 排队超时自动核查：先查 kernel 状态，状态接口认出的直接定论；
 * 不认识/查不到时改查输出文件列表，有文件 = 已有输出文件，没文件 =
 * 仍在排队暂无输出文件。问不到（网络断开等）返回 null，调用方不记
 * 时间、不写备注，下轮再试。knownState 是 tick 本轮刚查到的状态，
 * 传进来就不用再查一次；传 "unknown"/空时这里自己查。 */
export async function performQueueCheck(job, client, knownState) {
  let state = knownState;
  if (!state || state === "unknown") {
    const st = await client.kernelStatus(job.kaggleRef);
    if (!st.error && st.state !== "unknown") state = st.state;
    else state = "unknown";
  }
  if (state === "queued") return "queued";
  if (state === "running") return "running";
  if (state === "complete") return "has-output"; // 已跑完必有输出；主流程下一轮会取图
  if (state === "error") return null; // 云端已失败由主流程判失败，不写核查备注
  const has = await client.hasAnyOutputFile(job.kaggleRef);
  if (has === true) return "has-output";
  if (has === false) return "queued-no-output";
  return null;
}

/** 该核查就核查一次：只在排队阶段、进排队超 30 分钟、距上次核查 ≥ 约 10 分钟时
 * 跑；核查完把时间（queueCheckAt）和备注（queueCheckNote）存进任务
 * （随任务持久化，不只放内存），返回备注文案；不该查或问不到返回 null。
 * 离开排队阶段后不再调用，旧备注留在任务记录里不再更新。 */
export async function maybeQueueOverdueCheck(job, client, knownState) {
  if (!job || job.stage !== "queued" || job.status !== "queued") return null;
  const now = Date.now();
  if (!isQueueOverdue(job, now)) return null;
  if (job.queueCheckAt && now - job.queueCheckAt < QUEUE_CHECK_INTERVAL_MS) return null;
  const conclusion = await performQueueCheck(job, client, knownState);
  if (!conclusion) return null;
  const note = formatQueueCheckNote(conclusion, now);
  updateJob(job.id, { queueCheckAt: now, queueCheckNote: note });
  await saveJobs();
  return note;
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
    case "confirming":
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
  // 纯 Node 测试环境里 import.meta.env 不存在，用 "/" 兜底（测试桩会接管 fetch）。
  const url = `${import.meta.env?.BASE_URL ?? "/"}notebooks/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`模板 ${file} 读不到（HTTP ${res.status}）`);
  return res.text();
}

/** 推送后核实 kernel 存在：每 30s 双通道查一次，最多 5 分钟。成功返回 true。
 * 全程都没拿到“确认不存在”的答复（一直在断网）时，窗口到期也不判失败——
 * 进待确认，等网络恢复后继续核实。 */
async function verifyKernel(job, client) {
  if (verifyingJobs.has(job.id)) return false;
  verifyingJobs.add(job.id);
  try {
    const deadline = job.verifyDeadlineAt || Date.now() + VERIFY_WINDOW_MS;
    let sawConclusiveAbsent = false;
    while (Date.now() < deadline) {
      const chk = await client.confirmKernelExists(job.kaggleRef);
      if (chk.exists) {
        setNetworkDown(false);
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
      if (chk.inconclusive) {
        // 网络断开、没拿到确定答复：不判失败，进待确认；窗口往后延一轮，
        // 下次轮询（或这次循环的下一次）继续核实
        setNetworkDown(true);
        updateJob(job.id, {
          status: "preparing",
          stage: "confirming",
          verifyDeadlineAt: Date.now() + VERIFY_WINDOW_MS,
          stageDetail: "网络暂时断开，正在重连…（云端任务已在，恢复后继续核实）",
        });
      } else {
        sawConclusiveAbsent = true;
        updateJob(job.id, {
          stageDetail: `云端已接受推送，正在核实（${chk.detail}）`,
        });
      }
      await saveJobs();
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(VERIFY_INTERVAL_MS, left));
      // 任务可能在等待期间被删
      if (!jobs.some((j) => j.id === job.id)) return false;
    }
    if (!sawConclusiveAbsent) {
      // 全程断网、一次都没确认到“不在”：不判失败，进待确认，等网络恢复后继续核实
      setNetworkDown(true);
      updateJob(job.id, {
        status: "preparing",
        stage: "confirming",
        verifyDeadlineAt: Date.now() + VERIFY_WINDOW_MS,
        stageDetail: "网络暂时断开，正在重连…（云端任务已在，恢复后继续核实）",
      });
      await saveJobs();
      return false;
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
      useLora: job.useLora,
      loraKeys: job.loraKeys,
      useUpscale: job.useUpscale,
    });

    // 主模型 + LoRA + 超分数据集（纯函数 collectDatasetSources 组装，老任务没有
    // useUpscale 字段时按开处理、照常挂 SeedVR 数据集）：
    // MOSS 的 Moody 模型数据集须先核实存在（找不到就直接报错取消推送）；Krea2
    // 的 Ray 主模型走私有数据集（模板从 /kaggle/input 里递归找 Ray 文件，找不
    // 到就直接报错，所以 Krea2 单必挂），HerRAW 也走私有数据集（模板本身也从
    // HF 镜像下载同一文件，数据集挂上是双保险，只在带 LoRA 时挂）；Z-Image 的
    // PornMaster 主模型也走私有数据集（模板从 /kaggle/input 里递归找
    // PornMaster 文件，找不到就直接报错，所以 Z-Image 单必挂），三个 LoRA 只能
    // 走数据集，模板里没有 HF 兜底；MOSS 的观澜走 HF 镜像下载，没有 Kaggle
    // 数据集，不挂，Blender3D 只能走私有数据集，只在选中 Blender3D 时挂。
    // SeedVR 7B 放大模型走私有数据集（四模板的下载格都会从 /kaggle/input 软
    // 链它进 ComfyUI/models/SEEDVR2/，没挂就直接报错），只在开超分时挂；
    // 被云端拒绝时下面统一取消推送并报数据集名。
    let moodyRef = null;
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
      moodyRef = resolved.ref;
      updateJob(job.id, { stageDetail: `模型数据集已确认（${resolved.ref}），正在推送…` });
      await saveJobs();
    }
    const datasetSources = collectDatasetSources({
      model: job.model,
      loraKeys: job.loraKeys,
      useLora: job.useLora,
      useUpscale: job.useUpscale,
      moodyRef,
    });

    // 提交幂等：push 之前先按固定 slug 查云端——之前某次 push 的回包可能
    // 丢了（代理断开），kernel 其实已在云端排队/生成，再推就是重复提交。
    const slug = job.kaggleSlug || appKernelSlug(job.model, job.id);
    if (!job.kaggleSlug) updateJob(job.id, { kaggleSlug: slug });
    const preChk = await client.confirmKernelExists(`${settings.kaggleUsername}/${slug}`);
    if (preChk.exists) {
      // 云端已有这单：不再 push，直接恢复轮询
      setNetworkDown(false);
      updateJob(job.id, {
        kaggleRef: `${settings.kaggleUsername}/${slug}`,
        pushedAt: job.pushedAt || Date.now(),
        verifyDeadlineAt: Date.now() + VERIFY_WINDOW_MS,
        stageDetail: "云端已找到这单任务，恢复轮询…",
      });
      await saveJobs();
      await verifyKernel(job, client);
      return;
    }
    if (preChk.authError) {
      throw new Error(preChk.authError);
    }
    if (preChk.inconclusive) {
      // 网络断开、查不到：不 push、不失败，进待确认，等网络恢复后轮询再查
      setNetworkDown(true);
      updateJob(job.id, {
        status: "preparing",
        stage: "confirming",
        stageDetail: `网络暂时断开，正在重连…（已提交的任务不会重复推；${String(preChk.detail ?? "").slice(0, 120)}）`,
      });
      await saveJobs();
      return;
    }
    let push;
    try {
      push = await client.pushKernel({
        slug,
        title: slug,
        text,
        datasetSources,
      });
    } catch (e) {
      // push 请求本身因网络断开拿不到回包：请求可能已到云端建出 kernel，
      // 绝不能标失败——进待确认，等网络恢复后按 slug 查状态再决定
      const pushMsg = e instanceof Error ? e.message : String(e);
      if (isNetworkErrorText(pushMsg)) {
        setNetworkDown(true);
        updateJob(job.id, {
          status: "preparing",
          stage: "confirming",
          stageDetail: `网络暂时断开，正在重连…（已提交的任务不会重复推；${pushMsg.slice(0, 120)}）`,
        });
        await saveJobs();
        return;
      }
      throw e;
    }
    if (datasetSources.length > 0) {
      const bad = (push.invalidDatasetSources || []).filter((s) => datasetSources.includes(s));
      if (bad.length > 0) {
        throw new Error(`云端拒绝挂接数据集（${bad.join("、")}）：推送已取消，请检查数据集是否存在且为私有。`);
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
      const msg = e instanceof Error ? e.message : String(e);
      // 网络断开类错误（模板读不到 / Moody 数据集核实连不上等）：push 可能
      // 已发出、也可能没发出，两种情况都不能标失败——进待确认，等网络恢复后
      // 按 slug 查云端再决定（在就恢复轮询，不在就重新推）。
      if (isNetworkErrorText(msg)) {
        setNetworkDown(true);
        updateJob(job.id, {
          status: "preparing",
          stage: "confirming",
          stageDetail: `网络暂时断开，正在重连…（已提交的任务不会重复推；${msg.slice(0, 120)}）`,
        });
        await saveJobs();
      } else {
        await failJob(job, msg);
      }
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
    // 排队中的任务：探输出的报错别把自动核查的备注盖掉
    const note = job.stage === "queued" && job.queueCheckNote ? ` ${job.queueCheckNote}` : "";
    updateJob(job.id, { stageDetail: `${found.error.slice(0, 200)}${note}` });
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
    const msg = e instanceof KaggleError || e instanceof Error ? e.message : String(e);
    // 网络断开：图已在云端，只等重连下载——不判失败（也不受 10 分钟上限），
    // 等网络恢复后下一轮继续下载
    if (isNetworkErrorText(msg)) {
      setNetworkDown(true);
      updateJob(job.id, {
        status: "downloading",
        stage: "downloading",
        stageDetail: "网络暂时断开，正在重连…（图已在云端，恢复后继续下载）",
      });
      await saveJobs();
      return;
    }
    // 下载失败先留在 downloading，下一轮再试；超过 10 分钟才判失败
    const since = current.downloadStartedAt || Date.now();
    if (Date.now() - since > DOWNLOAD_BACKSTOP_MS) {
      await failJob(job, msg);
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
        // 没有 kaggleRef：可能只是 push 回包丢了（代理断开）或重启中断，kernel
        // 可能已在云端——先按固定 slug 查云端，绝不直接判失败、绝不直接重推。
        if (!job.kaggleRef) {
          const slug = job.kaggleSlug || appKernelSlug(job.model, job.id);
          if (!job.kaggleSlug) updateJob(job.id, { kaggleSlug: slug });
          const chk = await makeClient().confirmKernelExists(`${settings.kaggleUsername}/${slug}`);
          if (chk.exists) {
            setNetworkDown(false);
            updateJob(job.id, {
              kaggleRef: `${settings.kaggleUsername}/${slug}`,
              pushedAt: job.pushedAt || Date.now(),
              verifyDeadlineAt: Date.now() + VERIFY_WINDOW_MS,
              stageDetail: "云端已找到这单任务，恢复轮询…",
            });
            await saveJobs();
            if (!verifyingJobs.has(job.id)) verifyKernel(job, makeClient());
          } else if (chk.authError) {
            await failJob(job, chk.authError);
          } else if (chk.inconclusive) {
            // 网络断开、查不到：进待确认，等网络恢复后继续查，不重推
            setNetworkDown(true);
            updateJob(job.id, {
              stage: "confirming",
              stageDetail: `网络暂时断开，正在重连…（已提交的任务不会重复推；${String(chk.detail ?? "").slice(0, 120)}）`,
            });
            await saveJobs();
          } else {
            // 确认云端没有这单：重新走提交流程（runJob 开头会再查一次，查到就不再推）
            if (!busyJobs.has(job.id)) runJob(job);
          }
          continue;
        }
        // 有 kaggleRef：5 分钟核实窗口由 verifyKernel 自己管（断网时不判失败，
        // 窗口会往后延）；这里不再另设 20 分钟硬上限。
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
      // 拿到确定状态 = 网络通了，断网横条可以消失
      if (!st.error && st.state !== "unknown") setNetworkDown(false);
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
        const baseDetail =
          nextStatus === "running"
            ? "云端正在生成"
            : `云端排队中（已等约 ${Math.max(1, Math.round(stageAge / 60000))} 分钟）`;
        let detail = baseDetail;
        if (nextStatus === "queued") {
          // 排队已超时：自动核查一次真实状态，备注写进进度里（只保留最新一条）；
          // 没到核查时间时，把上次的备注继续带上，别让它闪一下就没了
          const note = await maybeQueueOverdueCheck(job, client, st.state);
          const stored = note || job.queueCheckNote;
          if (stored) detail = `${baseDetail} ${stored}`;
        }
        updateJob(job.id, {
          status: nextStatus,
          stage: nextStatus,
          stageDetail: detail,
        });
        await saveJobs();
        // 排队/运行超过 20 分钟：状态接口可能不报完成，探输出列表兜底
        if (stageAge > RECONCILE_AFTER_MS) {
          const url = await probeOutput(job, client);
          if (url) await finishJob(job, url);
        }
        continue;
      }
      // unknown 或状态接口报错：排队已超时先自动核查一次（只在排队阶段），
      // 再写明原因，并探输出列表（#43 的教训）
      let checkNote = null;
      if (job.stage === "queued") {
        checkNote = await maybeQueueOverdueCheck(job, client, "unknown");
      }
      const unknownText = st.error
        ? `状态接口暂时查不到：${String(st.error).slice(0, 120)}，正在翻输出列表找结果图`
        : `云端返回了不认识的状态${st.raw ? `「${st.raw}」` : ""}，正在翻输出列表找结果图`;
      const storedNote = checkNote || job.queueCheckNote;
      updateJob(job.id, {
        stageDetail: storedNote ? `${unknownText} ${storedNote}` : unknownText,
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

/** 仅测试用：手动跑一轮轮询（真机上由 startPolling 的定时器驱动）。 */
export function __tickForTest() {
  return tick();
}

/** 应用打开时恢复：未终态的任务继续轮询；中断在准备阶段的按规则处理。 */
export async function initJobs() {
  if (inited) return;
  inited = true;
  await loadAll();
  // 重启后：preparing 但还没 kaggleRef 的任务不直接失败——push 回包可能丢了，
  // kernel 可能已在云端；先标成待确认，轮询时会按固定 slug 查云端再决定。
  for (const job of [...jobs]) {
    if (job.status === "preparing" && !job.kaggleRef) {
      updateJob(job.id, { stage: "confirming", stageDetail: "应用重启，正在确认云端是否已建出任务…" });
    }
  }
  await saveJobs();
  startPolling();
  pumpQueue();
}
