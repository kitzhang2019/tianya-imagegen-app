// jobs.js — 任务存储（Preferences）+ 轮询引擎 + 2 并发队列。
// 任务从提交、推送、核实、排队、生成、下载回存到画廊推送的完整状态机都在这里。

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Haptics, NotificationType } from "@capacitor/haptics";
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
  upscaleFlagForJob,
} from "./notebook.js";
import { pngDimensions } from "./kaggle.js";
import { ColabClient, ColabError, isNetworkErrorText } from "./colab.js";
import { DEFAULT_GALLERY_URL, attachGalleryOrig, pushToGallery } from "./gallery.js";

const PREF_JOBS = "tianya-imagegen-jobs";
const PREF_SETTINGS = "tianya-imagegen-settings";
const PREF_COUNTER = "tianya-imagegen-counter";
const PREF_ORPHANS = "tianya-imagegen-orphans"; // 已删待取回：任务从列表删了、平台上还在跑的单
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
const VERIFY_WINDOW_MS = 5 * 60 * 1000; // 提交后核实任务号的窗口
const QUEUED_BACKSTOP_MS = 6 * 3600 * 1000; // queued 超过 6 小时 -> 失败
const RUNNING_BACKSTOP_MS = 2 * 3600 * 1000; // running 超过 2 小时 -> 失败（与管理站生成 2 小时失败线对齐）
const DOWNLOAD_BACKSTOP_MS = 10 * 60 * 1000; // downloading 重试超过 10 分钟 -> 失败
const QUEUE_ALLOWANCE_MS = 5 * 60 * 1000; // 预估总时长里的排队留量（与 Live Activities 预计完成时间同一口径）
export const QUEUE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 排队超时后自动核查的刷新间隔：约 10 分钟再查一次
export const QUEUE_CHECK_AFTER_MS = 30 * 60 * 1000; // 排队核查的触发：进排队超过 30 分钟就核查（绝对时长，四模型统一；不再按预估总时长算）

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
  backend: "kaggle", // 生图走哪个后端："kaggle" | "colab"，默认 Kaggle
  kaggleUsername: "",
  kaggleToken: "",
  relayKey: "", // Colab 中转密钥（X-Colab-Key），只存在手机本地，默认空
  galleryKey: "",
  galleryUrl: DEFAULT_GALLERY_URL,
  notifyOnDone: true, // 出图完成提醒（震动+提示音），默认开
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
/** 已删待取回的后台跟踪记录（v1.2.25）：任务从任务列表删了、但平台上已经
 * 开始生成的单。只存平台任务 id 和取图要用的元数据（模型/种子/尺寸/
 * LoRA/超分/文件名），不存图片。跑完取图进本地图库后清理；App 重启后
 * 从 Preferences 恢复，继续跟踪。 */
let orphans = [];
let pollTimer = null;
let inited = false;

const listeners = new Set();
const blobUrls = new Map(); // jobId -> Blob URL（内存里，供立即展示）
const thumbBlobUrls = new Map(); // jobId -> 缩略图 Blob URL（内存里，供图库网格展示）
const THUMB_MAX = 480; // 缩略图最长边
const THUMB_QUALITY = 0.8; // WebP 缩略图质量
const busyJobs = new Set(); // 正在执行某一步的 jobId，避免轮询重入

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

/** 后台跟踪中的已删任务（只读副本，供单测与排障）。 */
export function getOrphans() {
  return [...orphans];
}

async function saveOrphans() {
  await Preferences.set({ key: PREF_ORPHANS, value: JSON.stringify(orphans) });
}

/** 仅测试用：清空后台跟踪记录。 */
export async function __resetOrphansForTest() {
  orphans = [];
  await saveOrphans();
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

/** 用 canvas 把图片 bytes 转成 WebP 缩略图（最长边 480px），返回 WebP bytes；失败返回 null。 */
async function makeThumbBytes(bytes, contentType = "image/png") {
  try {
    const blob = new Blob([bytes], { type: contentType });
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

/** 给一条已完成任务生成并保存 WebP 缩略图（失败不抛错，只返回 false）。
 * contentType 不传时按 imageFileName 后缀判断（.webp 就是 image/webp），
 * 别把 WebP 字节硬标成 image/png。 */
async function buildThumbnail(job, bytes, contentType) {
  if (!job || !job.imageFileName) return false;
  try {
    if (!bytes) {
      const { data } = await Filesystem.readFile({ path: `images/${job.imageFileName}`, directory: Directory.Data });
      bytes = base64ToBytes(data);
    }
    const type = contentType || (/\.webp$/i.test(job.imageFileName) ? "image/webp" : "image/png");
    const thumb = await makeThumbBytes(bytes, type);
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
  // 截掉超出的旧任务时顺带删文件（只截记录不删文件会在手机上慢慢泄漏存储）。
  const dropped = jobs.length > MAX_JOBS ? jobs.slice(MAX_JOBS) : [];
  jobs = jobs.slice(0, MAX_JOBS);
  await Preferences.set({ key: PREF_JOBS, value: JSON.stringify(jobs) });
  emit();
  for (const old of dropped) await deleteJobFiles(old);
}

/** 后端归一化：只认 "colab"，其余（包括老记录的 undefined）一律走 Kaggle。 */
export function normalizeBackend(value) {
  return value === "colab" ? "colab" : "kaggle";
}

export async function saveSettings(next) {
  // 字段按“没传就保留旧值”合并：开关只传 { notifyOnDone } 时不能把账号 Token 清掉
  settings = {
    backend: normalizeBackend(next.backend ?? settings.backend ?? "kaggle"),
    kaggleUsername: String(next.kaggleUsername ?? settings.kaggleUsername ?? "").trim(),
    kaggleToken: String(next.kaggleToken ?? settings.kaggleToken ?? "").trim(),
    relayKey: String(next.relayKey ?? settings.relayKey ?? "").trim(),
    galleryKey: String(next.galleryKey ?? settings.galleryKey ?? "").trim(),
    galleryUrl: String(next.galleryUrl ?? settings.galleryUrl ?? "").trim() || DEFAULT_GALLERY_URL,
    notifyOnDone: next.notifyOnDone ?? settings.notifyOnDone ?? true,
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
    const so = await Preferences.get({ key: PREF_ORPHANS });
    orphans = so.value ? JSON.parse(so.value) : [];
    if (!Array.isArray(orphans)) orphans = [];
  } catch {
    orphans = [];
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

/** 生成完成/失败后发一条系统通知 + 震动（App 在前台或后台运行时才触发；被系统挂起后等下次打开 App 轮询到结果时再补发）。 */
export async function notifyJob(job, ok) {
  // 设置里关了提醒就不发通知也不震动
  if (!settings.notifyOnDone) return;
  try {
    if (!Capacitor.isNativePlatform()) return;
    const label = MODEL_LABELS[job.model] ?? job.model;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: job.id,
          title: ok ? "出图完成" : "生成失败",
          body: ok ? `${label} 已出图，点开查看` : `${label} 生成失败，点开查看原因`,
          // iOS 不填 sound 就不响铃（类型定义写明：不填则 Android 响默认音、iOS 无声），
          // 这就是之前“完成时没声音”的根因。sound: "default" = 系统默认提示音。
          sound: "default",
        },
      ],
    });
  } catch {
    // 通知发不出去不影响任务本身
  }
  // 前台完成时通知横幅不一定引起注意，再补一次触觉反馈；后台时靠通知本身的震动。
  // 与通知分开 try/catch：通知失败了震动照样试。
  try {
    if (!Capacitor.isNativePlatform()) return;
    // 注意：type 必须用 NotificationType 枚举的大写值（"SUCCESS"/"ERROR"），
    // iOS/Android 原生代码只认大写，小写 "error" 会被当成 success 震。
    await Haptics.notification({ type: ok ? NotificationType.Success : NotificationType.Error });
  } catch {
    try {
      await Haptics.vibrate();
    } catch {
      // 震动也不支持就不震，不影响任务
    }
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

/** 判失败：默认清除 failedAtDownload（只在下载回存这一步失败时才由调用点
 * 置 true）。默认清除是为了防止旧标记残留：失败任务经「重新提交」恢复后
 * 再失败在生成阶段，不能还挂着「重新下载」按钮。extra 只用来传这种
 * 明确的失败阶段标记。 */
async function failJob(job, message, extra = {}) {
  updateJob(job.id, {
    status: "failed",
    stage: "failed",
    stageDetail: String(message).slice(0, 200),
    error: String(message).slice(0, 1000),
    finishedAt: Date.now(),
    downloadStuck: null,
    failedAtDownload: false,
    ...extra,
  });
  await saveJobs();
  notifyJob(job, false);
  endLiveActivity(job, false);
  pumpQueue();
}

// v3.0：Kaggle 与 Colab 都走中转代劳，手机上不再需要 Kaggle Token；
// 两边都只要求 Colab 中转密钥（relayKey），缺失时文案与 Colab 同款，
// 不再提 Kaggle Token。设置页的 Kaggle 用户名/Token 输入框保留不动，
// 但提交不再读它们。
function requireCreds(backend = "kaggle") {
  if (!settings.relayKey) {
    throw new Error("请先在设置里填好 Colab 中转密钥，再提交生图。");
  }
}

function makeColabClient() {
  return new ColabClient({ key: settings.relayKey });
}

/** 提交一单：只建记录进本地队列，由 pumpQueue 按 2 并发启动。
 * useLora：Krea2 的 LoRA 开关（默认带）；loraKeys：MOSS 的 LoRA 选择（默认只带
 * 观澜，空数组 = 不挂）/ Z-Image 的 LoRA 选择（默认全带）。useUpscale：Kaggle
 * 的 7B 超分开关（默认开，false = 底图直接当成品、不挂 SeedVR 数据集）。
 * useColabUpscale：Colab 的 3B 超分开关（默认开，false = 底图直接出、不挂
 * 放大；没传时跟 7B 开关走）。两个开关各管各的后端，互不影响。 */
export async function submitJob({ model, prompt, ratioKey = "auto", useLora, loraKeys, useUpscale, useColabUpscale, kaggleSlug, backend }) {
  const normalizedBackend = normalizeBackend(backend ?? settings.backend);
  requireCreds(normalizedBackend);
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
    // 重提/重新生成按原选择重放。7B 开关只管 Kaggle，3B 开关只管 Colab。
    useUpscale: normalizeUseUpscale(useUpscale),
    useColabUpscale: normalizeUseUpscale(useColabUpscale ?? useUpscale),
    width: size.width,
    height: size.height,
    seed: randomSeed(),
    status: "queued-local",
    stage: "queued-local",
    stageDetail: "本地排队，等空闲的云端会话",
    kaggleRef: null, // v3.0：不再产生，恒为 null（旧任务迁移见 initJobs）
    // 后端随任务持久化：重提/重新生成按原后端重放，任务列表显示每单走的后端。
    backend: normalizedBackend,
    colabJobId: null, // 中转任务号（cb-…）：Kaggle 与 Colab 单都走中转，都存这里
    colabProgress: null, // 中转上报的生成进度（0–100），两后端通用
    // 固定 slug：提交时就按任务 id 定死、存进任务，重推复用同一个 slug，
    // 绝不每次尝试现算新 slug。带 app- 前缀，与管理站的同名 kernel 区分开
    // （两边任务号各自计数，撞车会互相覆盖对方的 kernel）。
    // Colab 单没有 slug，记 null。
    kaggleSlug: normalizedBackend === "colab" ? null : kaggleSlug || appKernelSlug(model, id),
    createdAt: Date.now(),
    pushedAt: null,
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: null, // 开始生成的时间（第一次进入 running 阶段才记，只记一次）；用于算“开始生成到出图”的用时
    finishedAt: null,
    error: null,
    imagePath: null,
    imageFileName: outputFileName(model, id),
    webpFileName: null, // 下载回存时顺带下的同名 WebP（画廊推送用，PNG 超 10MB 推不动时推它）
    galleryPushed: null,
    galleryError: null,
    // 补 PNG 原图的结果（推图成功后后台跑 attach-orig）：true=已补上，
    // false=补不上（原因在 galleryOrigError），null=还没跑。
    // 只记进任务记录，不影响任务状态、不重试、不弹窗。
    galleryOrigPushed: null,
    galleryOrigError: null,
    regeneratedFrom: null, // 重新生成时，指向原图任务 id
    regeneratedBy: null, // 被重新生成时，指向新图任务 id
    liveActivityId: null, // 锁屏 / 灵动岛常驻活动的 id（仅本机，不进画廊）
    downloadStartedAt: null,
  };
  jobs.unshift(job);
  await saveJobs();
  startLiveActivity(job);
  pumpQueue();
  return job;
}

/** 失败任务重提：先按 colabJobId 查中转——
 *  - 中转那边还在跑/排队：直接恢复旧任务轮询，不建新任务、不再提交
 *    （防重复提交）；
 *  - 中转那边已跑完：恢复旧任务，下一轮轮询直接取图；
 *  - 中转那边失败了 / 没这单了：新开一单（新任务号、新种子），按原后端走；
 *  - 网络还没恢复、查不到：不建新任务，直接报错，等网络恢复后再点。
 * 没有 colabJobId（提交时回包丢了、核对不了，或旧版直接提交的单）：
 * 直接新开一单。Kaggle 单重提复用同一个 kaggleSlug（固定 slug 不变）。
 * LoRA 选择与超分开关原样带上。 */
export async function retryJob(id) {
  const old = jobs.find((j) => j.id === id);
  if (!old) throw new Error("找不到这条任务");
  return retryRelayJob(old);
}

async function retryRelayJob(old) {
  requireCreds(normalizeBackend(old.backend));
  const slug = old.kaggleSlug || appKernelSlug(old.model, old.id);
  const resubmit = () =>
    submitJob({
      model: old.model,
      prompt: old.prompt,
      ratioKey: old.ratioKey || "auto",
      useLora: old.useLora,
      loraKeys: old.loraKeys,
      useUpscale: old.useUpscale,
      useColabUpscale: old.useColabUpscale,
      backend: normalizeBackend(old.backend),
      kaggleSlug: slug,
    });
  if (!old.colabJobId) return resubmit();
  const client = makeColabClient();
  let remote;
  try {
    remote = await client.getJob(old.colabJobId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ColabError && e.status === 401) throw new Error(msg);
    if (e instanceof ColabError && e.status === 404) return resubmit();
    if (isNetworkErrorText(msg)) {
      setNetworkDown(true);
      throw new Error("网络还没恢复，无法确认中转那边这单的状态，稍后再点重新提交。");
    }
    throw new Error(msg);
  }
  if (remote.status === "queued" || remote.status === "running") {
    setNetworkDown(false);
    const relayLabel = normalizeBackend(old.backend) === "colab" ? "Colab" : "Kaggle";
    updateJob(old.id, {
      status: remote.status,
      stage: remote.status,
      stageDetail: `${relayLabel}：${remote.stage || (remote.status === "running" ? "生成中" : "排队中")}`,
      error: null,
      finishedAt: null,
      downloadStartedAt: null,
      failedAtDownload: false,
    });
    await saveJobs();
    return old;
  }
  if (remote.status === "done") {
    setNetworkDown(false);
    updateJob(old.id, {
      status: "running",
      stage: "running",
      stageDetail: "中转已跑完，正在取图",
      error: null,
      finishedAt: null,
      downloadStartedAt: null,
      failedAtDownload: false,
    });
    await saveJobs();
    return old;
  }
  return resubmit();
}

/** 手动重新取回 / 重新下载：只重试“下载回存”这一步，不重新提交、不重新
 * 生成、不换种子。
 *  - downloading / running：老路（下载卡住时点一下，立刻再试一次下载）。
 *  - failed 且 failedAtDownload：图已在中转生成完、只是 10 分钟内没下回来
 *    （或密钥问题），先核对中转成品还在不在——在就只重试下载；中转已没
 *    这单，就如实说取不回来了，并把「重新下载」按钮撤掉（标记清掉，
 *    卡片只剩「重新提交」），不假装能重试。
 *  - failed 且不是下载失败（生成失败、排队超时等）：拒绝，仍请点「重新提交」。
 * 再失败也不判丢：下载失败时 finishRelayJob 仍留在 downloading，
 * 10 分钟上限到了才再判失败、标记仍在，按钮保留可反复点。 */
export async function refetchJob(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error("找不到这条任务");
  if (job.status === "done") throw new Error("这张图已经下好了，不用重新取回");
  if (job.status === "failed") {
    if (!job.failedAtDownload) throw new Error("这单已经失败了，请点「重新提交」再试");
    // 失败在下载：先核对中转成品还在不在，免得对着已清掉的单空重试。
    if (!job.colabJobId) throw new Error("中转那边已经没有这单了，取不回来，请点「重新提交」再试");
    let remote;
    try {
      remote = await makeColabClient().getJob(job.colabJobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ColabError && e.status === 404) {
        // 中转已清掉这单：成品取不回来了，如实说，按钮撤掉。
        updateJob(job.id, {
          failedAtDownload: false,
          stageDetail: "中转那边已经没有这单了，成品取不回来。请点「重新提交」重新生成。",
          error: "中转那边已经没有这单了，成品取不回来。请点「重新提交」重新生成。",
        });
        await saveJobs();
        throw new Error("中转那边已经没有这单了，成品取不回来。请点「重新提交」重新生成。");
      }
      throw new Error(`现在查不到中转那边这单还在不在（${msg.slice(0, 80)}），请稍后再点「重新下载」`);
    }
    if (remote.status === "failed") {
      throw new Error("中转那边这单已失败，成品取不回来，请点「重新提交」再试");
    }
    if (remote.status !== "done") {
      throw new Error("中转那边这单还没跑完，稍后再点「重新下载」");
    }
    // done：成品在中转，往下走重取那条路。
  }
  if (job.status !== "downloading" && job.status !== "running" && job.status !== "failed") throw new Error("这单还没到下载这一步，稍后再试");
  if (!job.colabJobId) throw new Error("中转还没有这单，暂时取不回来");
  if (busyJobs.has(job.id)) throw new Error("正在下载，稍等一下");
  requireCreds(normalizeBackend(job.backend));
  updateJob(job.id, {
    status: "downloading",
    stage: "downloading",
    stageDetail: "正在重新取回结果图…",
    downloadStartedAt: null,
    error: null,
    downloadStuck: null,
    failedAtDownload: false,
  });
  await saveJobs();
  await finishRelayJob(job);
  return jobs.find((j) => j.id === job.id) || job;
}

/** 重新生成：同提示词/模型/比例新开一个任务（新种子），旧图保留，两图互相关联，方便对比。 */
export async function regenerateJob(id) {
  const old = jobs.find((j) => j.id === id);
  if (!old) throw new Error("找不到这张图");
  if (old.status !== "done") throw new Error("这张图还没完成，不能重新生成");
  const job = await submitJob({ model: old.model, prompt: old.prompt, ratioKey: old.ratioKey || "auto", useLora: old.useLora, loraKeys: old.loraKeys, useUpscale: old.useUpscale, useColabUpscale: old.useColabUpscale, backend: normalizeBackend(old.backend) });
  job.regeneratedFrom = old.id;
  old.regeneratedBy = job.id;
  await saveJobs();
  return job;
}

/** 切换到 Colab：失败任务用原设置新开一单走 Colab（新任务号、新种子）。\n * 只允许失败的任务切——成功/进行中的任务请走正常流程；UI 层也会把按钮\n * 置灰，这里再拦一道。Colab 单没有 kaggleSlug，submitJob 里 backend=colab\n * 时自动记 null。LoRA 选择与超分开关原样带上。 */
export async function switchToColabJob(id) {
  const old = jobs.find((j) => j.id === id);
  if (!old) throw new Error("找不到这条任务");
  if (old.status !== "failed") throw new Error("只有失败的任务才能切换到 Colab");
  return submitJob({
    model: old.model,
    prompt: old.prompt,
    ratioKey: old.ratioKey || "auto",
    useLora: old.useLora,
    loraKeys: old.loraKeys,
    useUpscale: old.useUpscale,
    useColabUpscale: old.useColabUpscale,
    backend: "colab",
  });
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
  // 2026-11-15 站里实测生成段（2048×3072 即 6.0MP）：Qwen 约 16 分钟、Krea2 约 13 分钟、Z-Image 约 21 分钟。
  // 旧值（75/120/60 秒每 1MP）只有实测的约 1/3 到 1/2，预估严重偏短。
  qwen: { ms: 16 * 60 * 1000, px: 2048 * 3072 },
  krea2: { ms: 13 * 60 * 1000, px: 2048 * 3072 },
  zimage: { ms: 21 * 60 * 1000, px: 2048 * 3072 },
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

/** 排队超时自动核查（v3.0）：中转直接报状态，不用再查 kernel 状态接口或
 * 输出列表。knownState 是 tick 本轮刚从中转拿到的状态；done = 已有成品
 * （主流程下一轮会取图），failed / 不认识返回 null，调用方不记时间、
 * 不写备注，下轮再试。 */
export function performQueueCheck(job, knownState) {
  if (knownState === "queued") return "queued";
  if (knownState === "running") return "running";
  if (knownState === "done") return "has-output"; // 已跑完必有成品；主流程下一轮会取图
  return null; // failed 由主流程判失败，不写核查备注；不认识也不写
}

/** 该核查就核查一次：只在排队阶段、进排队超 30 分钟、距上次核查 ≥ 约 10 分钟时
 * 跑；核查完把时间（queueCheckAt）和备注（queueCheckNote）存进任务
 * （随任务持久化，不只放内存），返回备注文案；不该查或问不到返回 null。
 * 离开排队阶段后不再调用，旧备注留在任务记录里不再更新。 */
export async function maybeQueueOverdueCheck(job, knownState) {
  if (!job || job.stage !== "queued" || job.status !== "queued") return null;
  const now = Date.now();
  if (!isQueueOverdue(job, now)) return null;
  if (job.queueCheckAt && now - job.queueCheckAt < QUEUE_CHECK_INTERVAL_MS) return null;
  const conclusion = performQueueCheck(job, knownState);
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
      // 中转直接上报生成进度（0–100）时进度环按它走（Kaggle 与 Colab 单通用）；
      // 没上报时按耗时估算。
      if (typeof job.colabProgress === "number") {
        const p = Math.max(0, Math.min(100, job.colabProgress));
        return { pct: Math.round(30 + (p / 100) * 58), label };
      }
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

/** 推图成功后，后台把 PNG 原图补到画廊（attach-orig）。
 * v3.0：Kaggle 与 Colab 单都走中转，PNG 要么已在本地（下载回存时后台已下好），
 * 要么从中转 GET /job/<id>/png 再下一次；不再翻 Kaggle 内核输出列表。
 * 全程与主流程脱钩：推图成功即算成功；这里任何一步失败都只把原因记进
 * 任务记录（galleryOrigPushed=false + galleryOrigError），不标任务失败、
 * 不重试、不弹窗。任务已被删时不再写回。调用方 fire-and-forget，不等它。
 * PNG 尺寸须与任务最终尺寸对上，对不上就不贴。 */
async function attachOrigInBackground(job, galleryId) {
  // 调用时就快照关键字段：后台跑起来之后任务对象可能被别的步骤改动。
  const jobId = job.id;
  const colabJobId = job.colabJobId;
  const width = job.width;
  const height = job.height;
  const imageFileName = job.imageFileName;
  const fail = async (reason) => {
    const current = jobs.find((j) => j.id === jobId);
    if (!current) return;
    updateJob(jobId, { galleryOrigPushed: false, galleryOrigError: String(reason).slice(0, 200) });
    await saveJobs().catch(() => {});
  };
  try {
    if (!galleryId) {
      await fail("画廊回包里没有图 id，补不了原图");
      return;
    }
    if (!colabJobId) {
      await fail("这单没有中转任务号，找不到结果图");
      return;
    }
    if (!settings.galleryKey) {
      await fail("画廊推送密钥未配置");
      return;
    }
    // 贴到画廊时的本地文件名（WebP 先行时 imageFileName 是 .webp，
    // 换回 .png 就是成品名；老路本身就是 .png 名）。
    const pngName = String(imageFileName || "").replace(/\.webp$/i, ".png");
    if (!pngName || !/\.png$/i.test(pngName)) {
      await fail("任务没有 PNG 文件名，补不了原图");
      return;
    }
    let bytes = null;
    // 本地已有 PNG 原图（下载回存的后台补 PNG 已写好）就直接用，不再下载。
    try {
      const { data } = await Filesystem.readFile({ path: `images/${pngName}`, directory: Directory.Data });
      bytes = base64ToBytes(data);
    } catch {
      bytes = null;
    }
    if (!bytes) {
      const client = makeColabClient();
      try {
        bytes = await client.downloadImage(colabJobId, "png");
      } catch (e) {
        if (e instanceof ColabError && e.status === 404) {
          await fail("中转那边没找到这单的 PNG 原图");
          return;
        }
        throw e;
      }
    }
    const dims = pngDimensions(bytes);
    if (!dims) {
      await fail("下载到的 PNG 读不到尺寸，没贴");
      return;
    }
    if (dims.width !== width || dims.height !== height) {
      await fail(`PNG 尺寸 ${dims.width}×${dims.height} 与任务最终尺寸 ${width}×${height} 对不上，没贴`);
      return;
    }
    const res = await attachGalleryOrig({
      key: settings.galleryKey,
      galleryId,
      imageBytes: bytes,
      fileName: pngName,
    });
    if (!res.ok) {
      await fail(res.error || "补原图被画廊拒绝");
      return;
    }
    const current = jobs.find((j) => j.id === jobId);
    if (!current) return;
    updateJob(jobId, { galleryOrigPushed: true, galleryOrigError: null });
    await saveJobs();
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
  }
}

/** 画廊推送进度圈状态（纯函数，main.js 的图库渲染用；推送本身不改逻辑、
 * 不自动推，这里只读状态）：
 *  - "pushing"：推送进行中——调用方在推送循环里把任务 id 放进 pushing 集合，
 *    推送完（无论成败）再拿出来；
 *  - "ok"：已推送成功（任务记录 galleryPushed === true，pushJobToGallery 写回）；
 *  - "error"：推送失败（galleryPushed === false；推送函数只在真正发过请求
 *    且画廊回了不通过时才记 false，预检报错（没配密钥、图没完成）不记，
 *    因为根本没推）；
 *  - null：没推过 / 与推送无关。
 * 叉号状态下重新推送入口不变：推送入口是图库选择模式的「推送到画廊」按
 * 钮，与这个状态显示无关，出错了用户照常多选再推。 */
export function galleryPushRingState(job, pushingJobIds) {
  if (!job) return null;
  if (pushingJobIds && pushingJobIds.has(job.id)) return "pushing";
  if (job.galleryPushed === true) return "ok";
  if (job.galleryPushed === false) return "error";
  return null;
}

/** 手动推送到画廊（图库多选推送用）：读本机图片文件，按画廊设置推送，更新任务状态。
 * 优先推 WebP：2560×3840 的 PNG 约 12MB 超过画廊 10MB 上传上限（实测回 502），
 * 同名 WebP 只有约 1.25MB；没 WebP（老任务）才回退推 PNG。
 * 推成功后在后台补 PNG 原图（attach-orig，Kaggle 单才跑）：fire-and-forget，
 * 补不上只记进任务记录，不影响这次推送的成功结果。 */
export async function pushJobToGallery(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error("找不到这条任务");
  if (job.status !== "done" || !job.imageFileName) throw new Error("这张图还没完成，推不了");
  if (!settings.galleryKey) throw new Error("请先在设置里填好画廊推送密钥");
  // 优先用下载回存时顺带下的 WebP，没有就用 PNG。
  let fileName = job.imageFileName;
  let contentType = "image/png";
  if (job.webpFileName) {
    try {
      const { data } = await Filesystem.readFile({ path: `images/${job.webpFileName}`, directory: Directory.Data });
      const bytes = base64ToBytes(data);
      const push = await pushToGallery({
        url: settings.galleryUrl,
        key: settings.galleryKey,
        job,
        imageBytes: bytes,
        fileName: job.webpFileName,
        contentType: "image/webp",
      });
      updateJob(job.id, {
        galleryPushed: push.ok,
        galleryError: push.ok ? null : push.error,
      });
      await saveJobs();
      // 推成功了才在后台补 PNG 原图：fire-and-forget，补不上只记进任务记录，
      // 不影响这次推送的成功结果。
      if (push.ok) attachOrigInBackground(job, push.galleryId).catch(() => {});
      return push;
    } catch {
      // WebP 读不到就回退推 PNG。
    }
  }
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
    imageBytes: bytes,
    fileName,
    contentType,
  });
  updateJob(job.id, {
    galleryPushed: push.ok,
    galleryError: push.ok ? null : push.error,
  });
  await saveJobs();
  // 推成功了才在后台补 PNG 原图：fire-and-forget，补不上只记进任务记录，
  // 不影响这次推送的成功结果。
  if (push.ok) attachOrigInBackground(job, push.galleryId).catch(() => {});
  return push;
}

/** 删一条任务对应的本机文件（主图 + WebP + 缩略图），删不掉不抛错。 */
async function deleteJobFiles(job) {
  if (!job) return;
  for (const name of [job.imageFileName, job.webpFileName, job.thumbFileName]) {
    if (!name) continue;
    try {
      await Filesystem.deleteFile({ path: `images/${name}`, directory: Directory.Data });
    } catch {
      // 文件删不掉不影响
    }
  }
}

/** 删任务前先去中转取消对应的那一单（v1.2.25，用户原话：App 里删除任务，
 * 平台就取消相应任务）。只对还没跑完的任务发取消；done / failed 的不发。
 * Kaggle 与 Colab 单一律调中转 POST /job/<id>/fail，不再调 Kaggle
 * DeleteKernel。
 * @returns {{ok:true, alreadyGone?:boolean, skipped?:string}|{ok:false, error:string}}
 * ok=true：已取消 / 中转上已没了（alreadyGone）/ 没到中转不用取消
 * （skipped: "terminal" 已完结，"no-handle" 还没建出中转任务）；
 * ok=false：取消失败，调用方不要删本地记录。 */
export async function cancelRemoteJob(job) {
  if (!job || isTerminal(job)) return { ok: true, skipped: "terminal" };
  try {
    if (!job.colabJobId) return { ok: true, skipped: "no-handle" };
    requireCreds(normalizeBackend(job.backend));
    const client = makeColabClient();
    const r = await client.failJob(job.colabJobId, "已在 App 里删除");
    return { ok: true, alreadyGone: r.alreadyGone };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 只删本地记录和本机文件（平台上没有活要干时用）。返回 { ok:true }。 */
async function removeLocalJob(job) {
  jobs = jobs.filter((j) => j.id !== job.id);
  await saveJobs();
  await deleteJobFiles(job);
  const url = blobUrls.get(job.id);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrls.delete(job.id);
  }
  const thumbUrl = thumbBlobUrls.get(job.id);
  if (thumbUrl) {
    URL.revokeObjectURL(thumbUrl);
    thumbBlobUrls.delete(job.id);
  }
  pumpQueue();
  return { ok: true };
}

/** 取消失败时任务留着：记一条看得见的提示，等联网/配好凭据后重试删除。 */
async function markCancelFailed(job, error) {
  updateJob(job.id, {
    cancelError: String(error).slice(0, 200),
    stageDetail: "平台取消失败，请重试删除",
  });
  await saveJobs();
}

/** 任务从列表删了、平台上已开始生成：留一条轻量后台跟踪记录（只存平台
 * 任务 id 和取图要用的元数据），继续轮询它跑完，跑完取图进本地图库。
 * 不自动推公开画廊——用户在图库里看到图、自己决定传不传。 */
function orphanFromJob(job) {
  return {
    id: job.id,
    backend: normalizeBackend(job.backend),
    model: job.model,
    prompt: job.prompt,
    ratioKey: job.ratioKey,
    width: job.width,
    height: job.height,
    seed: job.seed,
    useLora: job.useLora,
    loraKeys: job.loraKeys,
    useUpscale: job.useUpscale,
    useColabUpscale: job.useColabUpscale,
    kaggleRef: job.kaggleRef,
    kaggleSlug: job.kaggleSlug,
    colabJobId: job.colabJobId,
    imageFileName: job.imageFileName,
    createdAt: job.createdAt,
    deletedAt: Date.now(),
    lastError: null,
    lastCheckedAt: null,
  };
}

async function detachJob(job) {
  orphans = orphans.filter((o) => o.id !== job.id);
  orphans.push(orphanFromJob(job));
  await saveOrphans();
}

async function removeOrphan(id) {
  orphans = orphans.filter((o) => o.id !== id);
  await saveOrphans();
}

/** 后台跟踪跑完/失败后，把记录插回任务列表（跑完 = done，进本地图库；
 * 失败 = failed，进任务列表当一条看得见的失败记录，不静默丢掉）。 */
function jobFromOrphan(orphan, status, stage) {
  return {
    id: orphan.id,
    model: orphan.model,
    prompt: orphan.prompt,
    ratioKey: orphan.ratioKey,
    useLora: orphan.useLora,
    loraKeys: orphan.loraKeys,
    useUpscale: orphan.useUpscale,
    useColabUpscale: orphan.useColabUpscale,
    width: orphan.width,
    height: orphan.height,
    seed: orphan.seed,
    status,
    stage,
    stageDetail: "后台继续取图…",
    kaggleRef: orphan.kaggleRef,
    backend: orphan.backend,
    colabJobId: orphan.colabJobId,
    colabProgress: null,
    kaggleSlug: orphan.kaggleSlug,
    createdAt: orphan.createdAt,
    pushedAt: null,
    verifyDeadlineAt: null,
    stageStartedAt: Date.now(),
    runningStartedAt: null,
    finishedAt: null,
    error: null,
    imagePath: null,
    imageFileName: orphan.imageFileName,
    webpFileName: null,
    galleryPushed: null,
    galleryError: null,
    galleryOrigPushed: null,
    galleryOrigError: null,
    regeneratedFrom: null,
    regeneratedBy: null,
    liveActivityId: null,
    downloadStartedAt: null,
    detachedFromDelete: true, // 这条 done 记录是删过的任务后台取回来的
  };
}

/** 后台跟踪的单跑完了：插回任务列表走现有下载回存流程（finishRelayJob：
 * WebP 先行、PNG 后台补、缩略图、进本地图库），不自动推画廊。插回后
 * 跟踪记录就清掉——下载本身由任务记录接手，断网重试走正常 downloading 流程。 */
async function reinsertOrphanForDownload(orphan, discovered = null) {
  const job = jobFromOrphan(orphan, "downloading", "downloading");
  jobs.unshift(job);
  await saveJobs();
  await removeOrphan(orphan.id);
  await finishRelayJob(job);
}

/** 后台跟踪的单在平台上失败/找不到了：插回一条失败任务进任务列表，
 * 让用户看得到（不静默丢掉），可以点「重新提交」再试。 */
async function reinsertOrphanAsFailed(orphan, message, failedAtDownload = false) {
  const job = jobFromOrphan(orphan, "failed", "failed");
  job.stageDetail = String(message).slice(0, 200);
  job.error = String(message).slice(0, 1000);
  job.finishedAt = Date.now();
  // 后台取图超过 6 小时：失败在下载回存这一步，云端 kernel 还在（删任务时
  // 没停 kernel），插回的失败任务同样可点「重新下载」只取回成品。
  job.failedAtDownload = failedAtDownload;
  jobs.unshift(job);
  await saveJobs();
  await removeOrphan(orphan.id);
  notifyJob(job, false);
}

/** 一轮后台跟踪：每个已删待取回的单各查一次中转状态。
 * done -> 插回下载进本地图库；中转已失败/找不到 -> 插回失败任务进列表；
 * 还在跑/排队/断网 -> 继续等（6 小时硬上限到了也插回失败任务，不无限等）。
 * 没有 colabJobId 的旧版直接提交的单：中转那边对不上，直接插回失败任务。 */
async function tickOrphans() {
  for (const orphan of [...orphans]) {
    if (!orphans.some((o) => o.id === orphan.id) || busyJobs.has(orphan.id)) continue;
    try {
      if (Date.now() - orphan.createdAt > QUEUED_BACKSTOP_MS) {
        await reinsertOrphanAsFailed(orphan, "后台取图超过 6 小时仍没拿到结果图，已自动结束。图库里没有这张图。", true);
        continue;
      }
      if (!orphan.colabJobId) {
        await reinsertOrphanAsFailed(orphan, "v3.0 改走中转代劳，这单是旧版直接提交的，取不回来了，请重新提交");
        continue;
      }
      await tickRelayOrphan(orphan);
    } catch (e) {
      // 单个后台跟踪失败不打断整轮；记下来，下轮再试
      orphan.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      orphan.lastCheckedAt = Date.now();
      await saveOrphans().catch(() => undefined);
    }
  }
}

async function tickRelayOrphan(orphan) {
  const client = makeColabClient();
  let remote;
  try {
    remote = await client.getJob(orphan.colabJobId);
  } catch (e) {
    if (e instanceof ColabError && e.status === 404) {
      await reinsertOrphanAsFailed(orphan, "中转那边找不到这单任务（404），后台取图结束。");
      return;
    }
    orphan.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    orphan.lastCheckedAt = Date.now();
    await saveOrphans();
    return;
  }
  setNetworkDown(false);
  orphan.lastCheckedAt = Date.now();
  if (remote.status === "done") {
    await reinsertOrphanForDownload(orphan, null);
    return;
  }
  if (remote.status === "failed") {
    await reinsertOrphanAsFailed(
      orphan,
      `${honestColabFailureMessage(remote.error)}（任务已从列表删除，后台取图时发现它失败了）`,
    );
    return;
  }
  // queued / running / 不认识的状态：继续等
  await saveOrphans();
}

export async function deleteJob(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return { ok: true, skipped: "not-found" };
  // 已完结的任务：平台上没有活要干，也不要自动推画廊——只删本地记录和文件。
  if (isTerminal(job)) return removeLocalJob(job);
  // 还没拿到中转任务号：中转那边没有这单，删本地即可。
  if (!job.colabJobId) return removeLocalJob(job);
  let remote;
  try {
    requireCreds(normalizeBackend(job.backend));
    remote = await makeColabClient().getJob(job.colabJobId);
  } catch (e) {
    // 404 = 中转那边已没这单：没什么可取消/可取的，直接删本地
    if (e instanceof ColabError && e.status === 404) return removeLocalJob(job);
    // 查不到状态按“已开始”处理：不断言它还在排队、不取消，留后台跟踪等它跑完取图
    await detachJob(job);
    const removed = await removeLocalJob(job);
    return { ...removed, detached: true };
  }
  if (remote.status === "queued") {
    // 还在排队（没开始生成）：取消中转任务，再删本地记录
    const cancel = await cancelRemoteJob(job);
    if (!cancel.ok) {
      await markCancelFailed(job, cancel.error);
      return { ok: false, error: cancel.error };
    }
    return removeLocalJob(job);
  }
  if (remote.status === "failed") return removeLocalJob(job);
  // running / done / 不认识的状态：已经开始生成，GPU 的活已经花了，不取消；
  // 任务记录从列表删掉，后台继续跟踪跑完，成品图取回进本地图库
  await detachJob(job);
  const removed = await removeLocalJob(job);
  return { ...removed, detached: true };
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

/** Colab 单的提交流程：直接 POST /job 到中转，拿到 job id 后进排队轮询。
 * 提交回包丢了（网络断开）时：中转那边可能已建出任务，但 App 没有任务号、
 * 对不上——不标失败、不盲目重推，进“待确认”，5 分钟后仍未确认就判失败
 * （中转没有“按 slug 查云端”这条路，所以确认不了、只能等用户重新提交）。
 * 密钥不对（401）是明确拒绝，直接判失败并告诉用户去设置里核对密钥。 */
async function runColabJob(job) {
  if (busyJobs.has(job.id)) return;
  busyJobs.add(job.id);
  try {
    requireCreds("colab");
    const client = makeColabClient();
    updateJob(job.id, {
      status: "preparing",
      stage: "preparing",
      stageDetail: "正在提交到 Colab 中转…",
    });
    await saveJobs();
    let submitted;
    try {
      submitted = await client.submitJob({
        model: job.model,
        prompt: job.prompt,
        ratioKey: job.ratioKey || "auto",
        seed: job.seed,
        loraKeys: job.loraKeys,
        useLora: job.useLora,
        // Colab 只走 3B 开关（useColabUpscale）；老任务没有该字段时按旧字段回退。
        useUpscale: upscaleFlagForJob(job),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isNetworkErrorText(msg)) {
        setNetworkDown(true);
        updateJob(job.id, {
          status: "preparing",
          stage: "confirming",
          verifyDeadlineAt: Date.now() + VERIFY_WINDOW_MS,
          stageDetail: `网络暂时断开，正在重连…（提交结果未确认，中转那边可能已建出任务，App 没有任务号、对不上；${msg.slice(0, 120)}）`,
        });
        await saveJobs();
        return;
      }
      throw e;
    }
    updateJob(job.id, {
      colabJobId: submitted.jobId,
      status: "queued",
      stage: "queued",
      stageDetail: "已提交到 Colab 中转，排队中",
      pushedAt: Date.now(),
    });
    await saveJobs();
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

/** Kaggle 单的提交流程（v3.0）：建 notebook 文本 + 收 datasetSources，
 * POST /job 到中转（backend=kaggle），守护进程代劳提交到 Kaggle；
 * 拿到 job id 后进排队轮询。MOSS 的 Moody 数据集核实改由守护进程做，
 * App 不再调 resolveMoodyDatasetRef（moodyRef 传 null，守护进程按
 * Kaggle 账号自己核实补上）。
 * 提交回包丢了（网络断开）时与 Colab 单同款处理：进待确认，5 分钟后
 * 仍未确认就判失败。密钥不对（401）是明确拒绝，直接判失败。 */
async function runKaggleJob(job) {
  if (busyJobs.has(job.id)) return;
  busyJobs.add(job.id);
  try {
    requireCreds("kaggle");
    const client = makeColabClient();
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

    // 主模型 + LoRA + 超分数据集（纯函数 collectDatasetSources 组装）：
    // MOSS 的 Moody 模型数据集核实改由守护进程做，这里传 null、不挂，
    // 守护进程按 Kaggle 账号核实后自己补上；Krea2 的 Ray、Z-Image 的
    // PornMaster 与三个 LoRA、SeedVR 7B 都走私有数据集，按原逻辑挂。
    const datasetSources = collectDatasetSources({
      model: job.model,
      loraKeys: job.loraKeys,
      useLora: job.useLora,
      useUpscale: job.useUpscale,
      moodyRef: null,
    });

    const slug = job.kaggleSlug || appKernelSlug(job.model, job.id);
    if (!job.kaggleSlug) updateJob(job.id, { kaggleSlug: slug });
    updateJob(job.id, { stageDetail: "正在提交到中转（Kaggle）…" });
    await saveJobs();
    let submitted;
    try {
      submitted = await client.submitJob({
        model: job.model,
        prompt: job.prompt,
        ratioKey: job.ratioKey || "auto",
        seed: job.seed,
        loraKeys: job.loraKeys,
        useLora: job.useLora,
        // Kaggle 走 7B 开关（useUpscale）；老任务没有该字段时按旧字段回退。
        useUpscale: upscaleFlagForJob(job),
        backend: "kaggle",
        notebookText: text,
        kaggleSlug: slug,
        datasetSources,
        title: slug,
        appJobId: job.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isNetworkErrorText(msg)) {
        setNetworkDown(true);
        updateJob(job.id, {
          status: "preparing",
          stage: "confirming",
          verifyDeadlineAt: Date.now() + VERIFY_WINDOW_MS,
          stageDetail: `网络暂时断开，正在重连…（提交结果未确认，中转那边可能已建出任务，App 没有任务号、对不上；${msg.slice(0, 120)}）`,
        });
        await saveJobs();
        return;
      }
      throw e;
    }
    updateJob(job.id, {
      colabJobId: submitted.jobId,
      status: "queued",
      stage: "queued",
      stageDetail: "已提交到中转（Kaggle），排队中",
      pushedAt: Date.now(),
    });
    await saveJobs();
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

/** 一单的提交流程：Kaggle 与 Colab 都走中转提交（见 runKaggleJob /
 * runColabJob），只差提交的请求体；轮询与取图也都走同一条中转路。 */
async function runJob(job) {
  if (normalizeBackend(job.backend) === "colab") return runColabJob(job);
  return runKaggleJob(job);
}

async function downloadRelayPngInBackground(job, pngName) {
  try {
    const client = makeColabClient();
    const bytes = await client.downloadImage(job.colabJobId, "png");
    await Filesystem.writeFile({
      path: `images/${pngName}`,
      data: bytesToBase64(bytes),
      directory: Directory.Data,
      recursive: true,
    });
    const uri = await Filesystem.getUri({ path: `images/${pngName}`, directory: Directory.Data });
    blobUrls.set(job.id, URL.createObjectURL(new Blob([bytes], { type: "image/png" })));
    const current = jobs.find((j) => j.id === job.id);
    if (!current || current.status !== "done") return;
    updateJob(job.id, { imageFileName: pngName, imagePath: uri.uri });
    await saveJobs();
  } catch {
    // PNG 下不到：留着 WebP 当主图，不报错
  }
}

/** 中转单的下载回存：中转已跑完，GET /job/<id>/webp|png 直下结果图。
 * WebP 优先：先下 WebP 存好就先完成任务，PNG 放后台慢慢下。 */
async function finishRelayJob(job) {
  if (busyJobs.has(job.id)) return;
  busyJobs.add(job.id);
  const client = makeColabClient();
  try {
    // downloadStartedAt 只在第一次进下载时记，之后重试不再重置——10 分钟上限
    // 算的是总重试时长。
    const started = jobs.find((j) => j.id === job.id) || job;
    updateJob(job.id, {
      status: "downloading",
      stage: "downloading",
      stageDetail: "正在从中转下载结果图…",
      downloadStartedAt: started.downloadStartedAt || Date.now(),
    });
    await saveJobs();

    const pngName = job.imageFileName;
    const webpName = String(pngName).replace(/\.png$/i, ".webp");
    // WebP 优先：先下 WebP，存好就先完成任务、让图显示
    // 出来；PNG 放后台慢慢下，存好后再把主图换成 PNG（原图）。
    try {
      const webpBytes = await client.downloadImage(job.colabJobId, "webp");
      await Filesystem.writeFile({
        path: `images/${webpName}`,
        data: bytesToBase64(webpBytes),
        directory: Directory.Data,
        recursive: true,
      });
      const webpUri = await Filesystem.getUri({ path: `images/${webpName}`, directory: Directory.Data });
      blobUrls.set(job.id, URL.createObjectURL(new Blob([webpBytes], { type: "image/webp" })));
      const doneJob = jobs.find((j) => j.id === job.id) || job;
      await buildThumbnail(doneJob, webpBytes, "image/webp");
      updateJob(job.id, {
        status: "done",
        stage: "done",
        stageDetail: "已完成，图片已保存",
        finishedAt: Date.now(),
        imageFileName: webpName,
        imagePath: webpUri.uri,
        webpFileName: webpName,
        downloadStartedAt: null,
      });
      await saveJobs();
      notifyJob(job, true);
      endLiveActivity(job, true);
      // PNG 放后台下，存好后把主图换成 PNG 原图；下不到就留着 WebP 当主图。
      downloadRelayPngInBackground(job, pngName).catch(() => {});
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 网络断开：图已在中转，只等重连下载——不判失败，等下一轮
      if (isNetworkErrorText(msg)) {
        setNetworkDown(true);
        updateJob(job.id, {
          status: "downloading",
          stage: "downloading",
          stageDetail: "网络暂时断开，正在重连…（图已在中转，恢复后继续下载）",
        });
        await saveJobs();
        return;
      }
      // 密钥不对是明确拒绝，不用等 10 分钟上限；记成下载失败（修好密钥后
      // 点「重新下载」能接着取，成品还在中转）。
      if (e instanceof ColabError && e.status === 401) {
        await failJob(job, msg, { failedAtDownload: true });
        return;
      }
      // 404（结果还没准备好）或魔数不对：走老路下 PNG；PNG 也 404 就留在
      // downloading 等下一轮，10 分钟上限到了再判失败。
      if (!(e instanceof ColabError && e.status === 404)) {
        updateJob(job.id, { stageDetail: `WebP 下不到（${msg.slice(0, 80)}），改下 PNG…` });
        await saveJobs();
      }
    }

    // 老路：下 PNG。
    let bytes;
    try {
      bytes = await client.downloadImage(job.colabJobId, "png");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isNetworkErrorText(msg)) {
        setNetworkDown(true);
        updateJob(job.id, {
          status: "downloading",
          stage: "downloading",
          stageDetail: "网络暂时断开，正在重连…（图已在中转，恢复后继续下载）",
        });
        await saveJobs();
        return;
      }
      if (e instanceof ColabError && e.status === 401) {
        // 同 WebP 那条：密钥问题是下载失败，修好后可重新下载。
        await failJob(job, msg, { failedAtDownload: true });
        return;
      }
      if (e instanceof ColabError && e.status === 404) {
        updateJob(job.id, {
          status: "downloading",
          stage: "downloading",
          stageDetail: "中转说结果还没准备好，等下一轮再试",
        });
        await saveJobs();
        return;
      }
      throw e;
    }
    const base64 = bytesToBase64(bytes);
    await Filesystem.writeFile({
      path: `images/${pngName}`,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
    const uri = await Filesystem.getUri({ path: `images/${pngName}`, directory: Directory.Data });
    blobUrls.set(job.id, URL.createObjectURL(new Blob([bytes], { type: "image/png" })));

    // 图库网格用的 WebP 缩略图（失败不影响出图）
    const doneJob = jobs.find((j) => j.id === job.id) || job;
    await buildThumbnail(doneJob, bytes, "image/png");

    updateJob(job.id, {
      status: "done",
      stage: "done",
      stageDetail: "已完成，图片已保存",
      finishedAt: Date.now(),
      imageFileName: pngName,
      imagePath: uri.uri,
      webpFileName: null,
      downloadStartedAt: null,
    });
    await saveJobs();
    notifyJob(job, true);
    endLiveActivity(job, true);

    // 不自动推送画廊：图只保存在本机，用户在图库里手动多选推送。
  } catch (e) {
    const current = jobs.find((j) => j.id === job.id);
    if (!current || isTerminal(current)) return;
    const msg = e instanceof Error ? e.message : String(e);
    // 网络断开：图已在中转，只等重连下载——不判失败（也不受 10 分钟上限），
    // 等网络恢复后下一轮继续下载
    if (isNetworkErrorText(msg)) {
      setNetworkDown(true);
      updateJob(job.id, {
        status: "downloading",
        stage: "downloading",
        stageDetail: "网络暂时断开，正在重连…（图已在中转，恢复后继续下载）",
      });
      await saveJobs();
      return;
    }
    // 下载失败先留在 downloading，下一轮再试；超过 10 分钟才判失败
    const since = current.downloadStartedAt || Date.now();
    if (Date.now() - since > DOWNLOAD_BACKSTOP_MS) {
      await failJob(job, msg, { failedAtDownload: true });
    } else {
      updateJob(job.id, {
        status: "downloading",
        stage: "downloading",
        stageDetail: `下载回存遇到问题，下一轮再试：${msg.slice(0, 120)}`,
      });
      await saveJobs();
    }
  } finally {
    busyJobs.delete(job.id);
    pumpQueue();
  }
}

/** 中转失败文案翻成诚实的 App 文案（v1.2.27）。
 * 中转 release 接口的 note 是固定文案（“已重新排队”）：守护进程两次
 * 分配不到 T4 就会调 release，文案写“已重新排队”，但第二次 release 后
 * 任务其实是 failed——并没有真的重排。原样展示会让用户以为单子还在排队、
 * 干等着。映射规则：原因（T4 503/容量不足）原样保留，结论改成“已失败、
 * 请点重新提交”，绝不出现“已重新排队”。 */
export function honestColabFailureMessage(remoteError) {
  const raw = String(remoteError || "").trim();
  if (!raw) return "Colab 中转返回失败（没给具体原因）。";
  if (/released too many times/i.test(raw)) {
    return "Colab 中转：多次未能分配 T4，任务已失败。可以点「重新提交」再试。";
  }
  if (raw.includes("已重新排队")) {
    const cause = raw.replace(/[，,、]?\s*已重新排队\s*[。]?/g, "").trim();
    if (!cause) return "Colab 中转：任务已失败（没有重新排队）。可以点「重新提交」再试。";
    return `Colab 中转：${cause}。任务已失败，可以点「重新提交」再试。`;
  }
  return `Colab 中转：${raw}`;
}

/** 超时前的最后一次中转核对（v1.2.27，KV 上限事故的教训；v3.0 起两后端通用）。
 * 排队 6 小时 / 生成 2 小时到了，直接判失败会把中转刚好跑完的图丢掉
 * （cb-mwnioez0-4ac4 就是这么丢的：App 判失败停轮询后，中转 08:03 领走、
 * 08:20 跑完，图却再也没下来）。所以判失败前先 GET /job/<id> 核对一次：
 *  - done -> 直接取图、标完成，不判失败；
 *  - failed -> 按中转的失败原因判失败（文案走 honestColabFailureMessage）；
 *  - queued/running -> 中转也确认没跑完，才判失败；
 *  - 联系不上中转（网络断开 / 500 等）-> 这轮先不判失败，写一句备注、
 *    下一轮再核对；401/404 是明确拒绝，直接判失败。
 * 返回 true = 已处理（取图或已判失败），false = 核对不上、这轮先不判失败。 */
async function failRelayJobOnTimeout(job, timeoutMessage) {
  if (!job.colabJobId) {
    await failJob(job, timeoutMessage);
    return true;
  }
  const client = makeColabClient();
  let remote;
  try {
    remote = await client.getJob(job.colabJobId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ColabError && (e.status === 401 || e.status === 404)) {
      await failJob(job, msg);
      return true;
    }
    setNetworkDown(true);
    updateJob(job.id, {
      stageDetail: "已超时，正在向中转做最后确认…（网络暂时断开，恢复后继续确认）",
    });
    await saveJobs();
    return false;
  }
  setNetworkDown(false);
  if (remote.status === "done") {
    await finishRelayJob(job);
    return true;
  }
  if (remote.status === "failed") {
    await failJob(job, honestColabFailureMessage(remote.error));
    return true;
  }
  await failJob(job, timeoutMessage);
  return true;
}

/** 已超时判失败的单的恢复核查（v1.2.27；v3.0 起 Kaggle 与 Colab 单通用）。
 * 超时判失败只代表“App 当时没等到”，中转可能随后跑完；用户打开 App 或
 * 刷新时，对每单失败的任务最多每 10 分钟向中转核对一次：
 *  - done -> 取图回来、标完成，不重提、不重新提交；
 *  - 还没跑完（queued/running/failed）或中转明确说没这单了（401/404）
 *    -> 只记一次核查时间，等下次再核对，不改失败状态；
 *  - 联系不上中转 -> 不记时间，下一轮再试。
 * 不自动重提、不重新提交：恢复旧单取图是唯一动作。 */
async function recoverFailedRelayJobs() {
  if (!settings.relayKey) return;
  const now = Date.now();
  const candidates = jobs.filter(
    (j) =>
      j.status === "failed" &&
      j.colabJobId &&
      !busyJobs.has(j.id) &&
      (!j.colabRecoveryCheckedAt || now - j.colabRecoveryCheckedAt > QUEUE_CHECK_INTERVAL_MS),
  );
  for (const job of candidates) {
    let remote;
    try {
      remote = await makeColabClient().getJob(job.colabJobId);
    } catch (e) {
      if (e instanceof ColabError && (e.status === 401 || e.status === 404)) {
        updateJob(job.id, { colabRecoveryCheckedAt: now });
        await saveJobs();
        continue;
      }
      setNetworkDown(true);
      continue;
    }
    const current = jobs.find((j) => j.id === job.id);
    if (!current || current.status !== "failed") continue;
    if (remote.status === "done") {
      setNetworkDown(false);
      updateJob(job.id, { stageDetail: "中转已跑完，正在取回结果图…", error: null, failedAtDownload: false });
      await saveJobs();
      await finishRelayJob(job);
      continue;
    }
    updateJob(job.id, { colabRecoveryCheckedAt: now });
    await saveJobs();
  }
}

/** 一单的一次轮询：GET /job/<id> 查中转的状态（Kaggle 与 Colab 单通用）。
 * done -> 取图；failed -> 判失败；queued/running -> 更新进度
 * （中转上报的 progress 直接进进度环，见 getJobProgress）；
 * 401/404 是明确拒绝（密钥不对 / 中转那边没这单了），判失败；
 * 网络断开只写备注、不判失败，等下一轮。
 * 排队已超时时顺带自动核查一次真实状态，备注写进进度里。 */
async function tickRelayJob(job) {
  const client = makeColabClient();
  let remote;
  try {
    remote = await client.getJob(job.colabJobId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ColabError && e.status === 401) {
      await failJob(job, msg);
      return;
    }
    if (e instanceof ColabError && e.status === 404) {
      await failJob(job, msg);
      return;
    }
    setNetworkDown(true);
    updateJob(job.id, { stageDetail: `网络暂时断开，正在重连…（${msg.slice(0, 120)}）` });
    await saveJobs();
    return;
  }
  setNetworkDown(false);
  const status = remote.status;
  const progress = typeof remote.progress === "number" ? Math.max(0, Math.min(100, remote.progress)) : null;
  if (status === "done") {
    await finishRelayJob(job);
    return;
  }
  if (status === "failed") {
    await failJob(job, honestColabFailureMessage(remote.error));
    return;
  }
  if (status === "queued" || status === "running") {
    const stageText = String(remote.stage || (status === "running" ? "生成中" : "排队中"));
    const relayLabel = normalizeBackend(job.backend) === "colab" ? "Colab" : "Kaggle";
    let detail = progress !== null && progress > 0 ? `${relayLabel}：${stageText} · ${progress}%` : `${relayLabel}：${stageText}`;
    if (status === "queued") {
      // 排队已超时：自动核查一次真实状态，备注写进进度里（只保留最新一条）；
      // 没到核查时间时，把上次的备注继续带上，别让它闪一下就没了
      const note = await maybeQueueOverdueCheck(job, status);
      const stored = note || job.queueCheckNote;
      if (stored) detail = `${detail} ${stored}`;
    }
    updateJob(job.id, {
      status,
      stage: status,
      stageDetail: detail,
      colabProgress: progress,
    });
    await saveJobs();
    return;
  }
  updateJob(job.id, { stageDetail: `中转返回了不认识的状态「${status}」，下一轮再试` });
  await saveJobs();
}

/** 一轮轮询：每个活跃任务各查一次中转状态（Kaggle 与 Colab 单通用，
 * 都按 colabJobId 走 tickRelayJob；backend 只用于展示，不再分流）。 */
async function tick() {
  const actives = jobs.filter(isActive);
  for (const job of actives) {
    if (!jobs.some((j) => j.id === job.id) || busyJobs.has(job.id)) continue;
    const now = Date.now();
    try {
      if (job.status === "preparing") {
        // 提交回包丢了就核对不了，只能等 5 分钟核实窗口过后判失败、
        // 让用户重新提交；有任务号但还在 preparing（提交成功后直接进
        // queued，这里只是兜底）就当 queued 继续轮询。
        if (!job.colabJobId) {
          if (!job.verifyDeadlineAt) {
            updateJob(job.id, { verifyDeadlineAt: Date.now() + VERIFY_WINDOW_MS });
            await saveJobs();
            continue;
          }
          if (now > job.verifyDeadlineAt) {
            await failJob(
              job,
              "提交时网络断开，没收到中转的回包，无法确认任务是否已建出（中转那边可能已在跑，App 没有任务号、对不上）。请重新提交。",
            );
          }
          continue;
        }
        updateJob(job.id, { status: "queued", stage: "queued", stageDetail: "已提交到中转，排队中" });
        await saveJobs();
        continue;
      }

      if (job.status === "downloading") {
        // 下载卡住了（404/内容不对）：等用户点「重新取回」，轮询不再自动重试，
        // 10 分钟上限也不判它（用户可能几小时后才点）。
        if (job.downloadStuck) continue;
        if (job.downloadStartedAt && now - job.downloadStartedAt > DOWNLOAD_BACKSTOP_MS) {
          // 失败在下载回存：图已在中转生成完，成品还能取回——记 failedAtDownload，
          // 卡片上给「重新下载」按钮，只重试下载、不重新生成。不要再只给「重新提交」。
          await failJob(
            job,
            "下载回存重试超过 10 分钟仍没成功，已自动结束。图已在中转生成完，点「重新下载」只取回成品，不用重新生成；也可以点「重新提交」再试。",
            { failedAtDownload: true },
          );
          continue;
        }
        finishRelayJob(job);
        continue;
      }

      // queued / running：没有中转任务号就没法查，等提交流程补上。
      if (!job.colabJobId) continue;
      if (now - job.createdAt > QUEUED_BACKSTOP_MS && job.status === "queued") {
        // 超时前先向中转做一次最后核对（v1.2.27）：中转可能刚好跑完，
        // 跑完就取图、别判失败；核对不上就这轮先不判失败。
        await failRelayJobOnTimeout(job, "云端排队超过 6 小时仍没开始，已自动结束。可以点「重新提交」再试。");
        continue;
      }
      // 生成中超过 2 小时：一直回 running 也不能无限等（与管理站生成
      // 2 小时失败线对齐）。stageStartedAt 是进入 running 阶段的时间。
      if (job.status === "running" && now - (job.stageStartedAt || job.createdAt) > RUNNING_BACKSTOP_MS) {
        await failRelayJobOnTimeout(job, "生成超过 2 小时未完成，已自动结束。可以点「重新提交」再试。");
        continue;
      }
      await tickRelayJob(job);
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
  // 已超时判失败的单恢复核查（v1.2.27）：用户打开 App 或刷新时，
  // 对失败的任务向中转核对一次，跑完了就取图回来、不重提。
  await recoverFailedRelayJobs();
  // 后台跟踪：已删待取回的单各查一次中转状态，跑完取图进本地图库
  await tickOrphans();
  // 每轮顺带同步一次常驻活动的进度（内部 15 秒节流；阶段变化时 updateJob 里已立即同步）
  for (const job of jobs.filter(isActive)) syncLiveActivity(job);
}

let tickPromise = null;

/** 立刻跑一轮轮询（切回前台时调用）。已有轮询在跑时，两次调用共用同一轮，
 * 不重复发请求；调用方等这一轮跑完再继续，状态一定是新的。 */
export function refreshJobsNow() {
  if (tickPromise) return tickPromise;
  tickPromise = tick()
    .catch(() => undefined)
    .finally(() => {
      tickPromise = null;
    });
  return tickPromise;
}

export function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    refreshJobsNow();
  }, POLL_MS);
  refreshJobsNow();
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

/** 测试专用：直接调 saveJobs（触发 50 条截断 + 删文件）。 */
export function __saveJobsForTest() {
  return saveJobs();
}

/** 应用打开时恢复：未终态的任务继续轮询；中断在准备阶段的按规则处理。 */
export async function initJobs() {
  if (inited) return;
  inited = true;
  await loadAll();
  // v3.0 旧任务迁移：Kaggle 单改走中转代劳，旧版直接提交的单（没有
  // colabJobId）中转那边对不上、取不回来了——未终态的标失败，文案说清
  // 原因、请用户重新提交。（用户装新版前会先删旧版，正常情况下不会撞上，
  // 这是兜底。queued-local 的单还没提交过，不标失败，留给 pumpQueue 重提。）
  for (const job of [...jobs]) {
    if (normalizeBackend(job.backend) === "kaggle" && !job.colabJobId && !isTerminal(job) && job.status !== "queued-local") {
      updateJob(job.id, {
        status: "failed",
        stage: "failed",
        stageDetail: "v3.0 改走中转代劳，这单是旧版直接提交的，取不回来了，请重新提交",
        error: "v3.0 改走中转代劳，这单是旧版直接提交的，取不回来了，请重新提交",
        finishedAt: Date.now(),
      });
    }
  }
  // 重启后：preparing 但还没拿到中转任务号的任务不直接失败——提交回包
  // 可能丢了，中转那边可能已建出任务；先标成待确认，轮询到 5 分钟窗口
  // 后判失败、让用户重新提交（见 tick 的 preparing 分支）。
  for (const job of [...jobs]) {
    if (job.status === "preparing" && !job.colabJobId) {
      updateJob(job.id, { stage: "confirming", stageDetail: "应用重启，提交结果未确认（中转那边可能已建出任务，App 没有任务号、对不上）…" });
    }
  }
  await saveJobs();
  startPolling();
  pumpQueue();
}
