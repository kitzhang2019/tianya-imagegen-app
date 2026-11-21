// main.js — 界面接线：生图 / 图库 / 设置 三个板块 + 结果查看。
// 底部毛玻璃标签栏切换；生图是完整流程（提示词/模型/比例/提交/任务），
// 图库是本机已出图的网格，设置是独立板块（不再是浮层）。

import "./styles.css";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import {
  DEFAULT_MOSS_LORA_KEYS,
  DEFAULT_ZIMAGE_LORA_KEYS,
  KREA2_LORA,
  MODEL_LABELS,
  MODEL_NAMES,
  MOSS_LORAS,
  RATIO_KEYS,
  RATIO_LABELS,
  ZIMAGE_LORAS,
  outputSizeForJob,
  ratioOptionLabel,
} from "./lib/notebook.js";
import {
  STAGE_LABELS,
  deleteJob,
  ensureThumbnails,
  galleryPushRingState,
  getAdminPassword,
  getImageSrc,
  getJobProgress,
  getJobs,
  getRegenPair,
  getSettings,
  getThumbSrc,
  initJobs,
  isNetworkDown,
  maskSecret,
  onJobsChange,
  onNetworkChange,
  pushJobToGallery,
  refetchJob,
  refreshJobsNow,
  regenerateJob,
  retryJob,
  saveSettings,
  setAdminPassword,
  submitJob,
  switchToColabJob,
} from "./lib/jobs.js";

const MAX_PROMPT = 10000;

const app = document.getElementById("app");

app.innerHTML = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <linearGradient id="ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6366f1" />
      <stop offset="55%" stop-color="#a855f7" />
      <stop offset="100%" stop-color="#ec4899" />
    </linearGradient>
  </defs>
</svg>
<header class="app-header">
  <div class="brand">
    <span class="brand-mark">✦</span>
    <div class="brand-text">
      <h1>天涯视界</h1>
      <p class="brand-sub">云端免费 GPU · 出图保存在本机</p>
    </div>
  </div>
</header>
<div id="net-banner" class="net-banner" hidden>网络暂时断开，正在重连…</div>

<main class="page">
  <!-- 生图 -->
  <section id="tab-generate" class="tab-page active">
    <div class="card glass gen-card">
      <label class="field-label" for="prompt">提示词</label>
      <textarea id="prompt" rows="4" maxlength="${MAX_PROMPT}"
        placeholder="写下你想生成的画面……比例写在提示词里也行，比如“9:16竖屏”，选“自动”时会按它来。"></textarea>
      <div class="row-between">
        <span id="prompt-count" class="muted">0 / ${MAX_PROMPT}</span>
      </div>
      <div class="select-row">
        <div class="backend-pills" role="group" aria-label="平台">
          <button type="button" class="backend-pill" data-backend="kaggle">Kaggle</button>
          <button type="button" class="backend-pill" data-backend="colab">Colab</button>
        </div>
        <div class="select-wrap">
          <select id="model-select" class="glass-select"></select>
          <span class="select-chev">▾</span>
        </div>
      </div>
      <div class="select-row">
        <label class="select-label" for="ratio-select">比例</label>
        <div class="select-wrap">
          <select id="ratio-select" class="glass-select"></select>
          <span class="select-chev">▾</span>
        </div>
      </div>
      <div class="options-grid">
        <div id="lora-box" class="lora-box"></div>
        <div id="upscale-box" class="lora-box"></div>
      </div>
      <button id="btn-submit" class="primary-btn">开始生成</button>
      <p class="hint">优先使用 Kaggle，如果 Kaggle 出故障了，使用 Colab 生成。（Kaggle 队列已满时中转会重新排队，不会自动切换到 Colab；想走 Colab 请手动切换。）</p>
      <p id="form-error" class="error" hidden></p>
    </div>
  </section>

  <!-- 任务 -->
  <section id="tab-tasks" class="tab-page">
    <div class="card glass">
      <div class="row-between">
        <h2>任务</h2>
        <span id="jobs-count" class="muted"></span>
      </div>
      <ul id="job-list" class="job-list"></ul>
      <p id="jobs-empty" class="muted empty">还没有任务，去「生图」写好提示词点「开始生成」。一次最多同时跑 2 个，多余的会在本地排队。</p>
      <div id="history-box" class="history-box" hidden>
        <button type="button" id="btn-history-toggle" class="history-toggle">
          <span id="history-title">已完成（0 条）</span>
          <span id="history-chevron" class="history-chevron">▸</span>
        </button>
        <ul id="history-list" class="job-list" hidden></ul>
      </div>
    </div>
    <p class="footnote muted">生图走云端免费 GPU，出图后自动保存到本机，在图库里手动推送到天涯画廊。</p>
  </section>

  <!-- 图库 -->
  <section id="tab-gallery" class="tab-page">
    <div class="gallery-head">
      <h2>图库</h2>
      <span id="gallery-count" class="muted"></span>
      <div class="gallery-head-actions">
        <button id="btn-select-mode" class="mini-btn" type="button">选择</button>
        <button id="btn-gallery-push" class="mini-btn primary" type="button">推送到画廊</button>
      </div>
    </div>
    <div id="gallery-grid" class="gallery-grid"></div>
    <p id="gallery-empty" class="muted empty">还没有出图。去「生图」写一段提示词，生成的第一张图就会出现在这里。</p>
    <div id="gallery-actions" class="gallery-actions" hidden>
      <span id="gallery-selected-count" class="muted"></span>
      <button id="btn-gallery-share" class="secondary-btn" type="button">分享</button>
    </div>
  </section>

  <!-- 设置（管理员密码锁：未解锁看不到 Kaggle 账号、Token、Colab 中转密钥和画廊设置） -->
  <section id="tab-settings" class="tab-page">
    <div id="settings-lock" class="card glass" hidden>
      <h2>设置已锁定</h2>
      <p class="muted">Kaggle 账号、Token、Colab 中转密钥和画廊设置需要管理员密码才能查看和修改。</p>
      <label class="field-label" for="admin-password">管理员密码</label>
      <input id="admin-password" type="password" inputmode="numeric" autocomplete="off" placeholder="输入管理员密码" />
      <p id="admin-password-error" class="error" hidden>密码不对，请重试。</p>
      <button id="btn-unlock-settings" class="primary-btn">解锁设置</button>
    </div>
    <div id="settings-first" class="card glass" hidden>
      <h2>首次使用：设置管理员密码</h2>
      <p class="muted">以后查看和修改 Kaggle 账号、Token、Colab 中转密钥和画廊设置都要输这个密码。密码只存在本机，不会上传。</p>
      <label class="field-label" for="admin-password-new">管理员密码</label>
      <input id="admin-password-new" type="password" inputmode="numeric" autocomplete="off" placeholder="输入密码" />
      <label class="field-label" for="admin-password-confirm">确认密码</label>
      <input id="admin-password-confirm" type="password" inputmode="numeric" autocomplete="off" placeholder="再输一次" />
      <p id="admin-password-set-error" class="error" hidden></p>
      <button id="btn-set-admin-password" class="primary-btn">设置密码</button>
    </div>
    <div id="settings-form" class="card glass settings-card" hidden>
      <h2>Kaggle</h2>
      <label class="field-label" for="set-username">Kaggle 用户名</label>
      <input id="set-username" type="text" autocomplete="username" placeholder="kitzhang2019" />
      <label class="field-label" for="set-token">Kaggle API Token</label>
      <input id="set-token" type="password" autocomplete="off" placeholder="KGAT 开头的 Token" />
      <p class="hint" id="token-state"></p>
      <p class="hint">Token 约 3 小时过期，过期后去 Kaggle 重新生成再填回来。</p>
      <h2 class="section-h">Colab</h2>
      <label class="field-label" for="set-relay-key">Colab 中转密钥</label>
      <input id="set-relay-key" type="password" autocomplete="off" placeholder="中转 RELAY_KEY（与 Worker 上同一串）" />
      <p class="hint" id="relay-key-state"></p>
      <p class="hint">走 Colab 才用。没有密钥时走 Colab 会直接提示、不提交。密钥只存在本机，不会上传。</p>
      <h2 class="section-h">画廊</h2>
      <label class="field-label" for="set-gallery-key">画廊推送密钥</label>
      <input id="set-gallery-key" type="password" autocomplete="off" placeholder="天涯画廊的推送密钥" />
      <p class="hint" id="gallery-key-state"></p>
      <label class="field-label" for="set-gallery-url">画廊地址</label>
      <input id="set-gallery-url" type="url" inputmode="url" placeholder="https://…/upload.php" />
      <button id="btn-save-settings" class="primary-btn">保存设置</button>
      <p id="settings-saved" class="ok" hidden>已保存。</p>
      <button id="btn-lock-settings" class="secondary-btn">锁定设置</button>
    </div>
    <!-- 关于：不锁，打开设置页直接就能看见 -->
    <div id="settings-about" class="card glass settings-about">
      <div class="about-row"><span class="about-label">版本</span><span id="app-version">–</span></div>
      <div class="about-row"><span class="about-label">GitHub</span><a id="github-link" class="external-link" href="https://github.com/kitzhang2019/tianya-imagegen-app" target="_blank" rel="noopener">https://github.com/kitzhang2019/tianya-imagegen-app</a></div>
    </div>
    <!-- 出图提醒：不锁，打开设置页直接就能看见 -->
    <div id="settings-notify" class="card glass settings-about">
      <label class="notify-row" for="set-notify-on-done">
        <span>出图完成提醒（震动+提示音）</span>
        <input id="set-notify-on-done" type="checkbox" checked />
      </label>
      <p class="hint">需在系统设置里允许通知，否则没有提示音；前台完成时仍会震动。</p>
    </div>
  </section>
</main>

<nav class="tabbar" aria-label="主导航">
  <button type="button" class="tab-btn active" data-tab="generate"><span class="tab-ico">✦</span><span class="tab-txt">生图</span></button>
  <button type="button" class="tab-btn" data-tab="tasks"><span class="tab-ico">☰</span><span class="tab-txt">任务</span></button>
  <button type="button" class="tab-btn" data-tab="gallery"><span class="tab-ico">▦</span><span class="tab-txt">图库</span></button>
  <button type="button" class="tab-btn" data-tab="settings"><span class="tab-ico">⚙</span><span class="tab-txt">设置</span></button>
</nav>

<div id="result-view" class="overlay" hidden>
  <div class="overlay-bar">
    <button id="result-close" class="icon-btn" aria-label="关闭">✕</button>
    <span id="result-title" class="overlay-title"></span>
    <span class="spacer"></span>
  </div>
  <div class="result-body">
    <img id="result-img" alt="生成结果" />
    <p id="result-meta" class="muted"></p>
    <p id="result-gallery" class="gallery-line"></p>
    <div class="result-actions">
      <button id="btn-regen" class="secondary-btn">↻ 重新生成</button>
      <button id="btn-compare" class="secondary-btn" hidden>对比</button>
      <button id="btn-save" class="primary-btn">保存到相册</button>
      <button id="btn-share" class="secondary-btn">分享</button>
    </div>
  </div>
</div>

<div id="compare-view" class="overlay" hidden>
  <div class="overlay-bar">
    <button id="compare-close" class="icon-btn" aria-label="关闭">✕</button>
    <span class="overlay-title">对比</span>
    <span class="spacer"></span>
  </div>
  <div class="compare-body">
    <figure class="compare-item">
      <img id="compare-img-a" alt="原图" />
      <figcaption id="compare-label-a" class="muted"></figcaption>
    </figure>
    <figure class="compare-item">
      <img id="compare-img-b" alt="重新生成的图" />
      <figcaption id="compare-label-b" class="muted"></figcaption>
    </figure>
  </div>
</div>

<div id="share-sheet" class="overlay" hidden>
  <div class="sheet">
    <h3>分享</h3>
    <p id="share-sheet-count" class="muted"></p>
    <button id="btn-share-sheet-share" class="primary-btn">分享</button>
    <button id="btn-share-sheet-save" class="secondary-btn">保存到相册</button>
    <button id="btn-share-sheet-cancel" class="ghost-btn">取消</button>
  </div>
</div>

<div id="toast" class="toast" hidden></div>
`;

const $ = (id) => document.getElementById(id);
const promptEl = $("prompt");
const submitBtn = $("btn-submit");
const formError = $("form-error");
const jobListEl = $("job-list");
const jobsEmptyEl = $("jobs-empty");
const jobsCountEl = $("jobs-count");
const galleryGridEl = $("gallery-grid");
const galleryEmptyEl = $("gallery-empty");
const galleryCountEl = $("gallery-count");
const toastEl = $("toast");

let selectedModel = "moss";
let selectedRatio = "auto";
let selectedBackend = "kaggle"; // 生图走哪个后端：kaggle | colab，默认 Kaggle；存设置里
// LoRA 选择（按模型记，切换模型回来还留着上次的选择）：
// MOSS 是两个复选（默认只带观澜，Blender3D 默认不勾），Krea2 一个开关（默认带），
// Z-Image 是三个复选（默认全带）。
const loraState = {
  moss: [...DEFAULT_MOSS_LORA_KEYS],
  krea2: true,
  zimage: [...DEFAULT_ZIMAGE_LORA_KEYS],
};

// 超分开关（2026-11-15，用户定：默认开）：开 = 底图 + SeedVR 7B → 最终尺寸；
// 关 = 底图直接当成品，不挂 SeedVR 数据集。四个模型共用一个开关（不按模型记）。
// 只管 Kaggle；选 Colab 时它灰掉点不了（值留着，切回 Kaggle 还在）。
let useUpscale = true;

// Colab 3B 超分开关（2026-11-19，用户定：默认开）：开 = 底图 + SeedVR 3B 放大，
// 关 = 底图直接出、不挂放大。只管 Colab；选 Kaggle 时它灰掉点不了（值留着，
// 切回 Colab 还在）。两个开关各管各的后端，互不影响。
let useColabUpscale = true;

/** 渲染超分开关：两个开关各管一个后端，另一个灰掉点不了。
 * 7B 开关只在 Kaggle 下可点，3B 开关只在 Colab 下可点；灰掉只是不让点，
 * 绝不改另一边的行为（Kaggle 的 7B、Colab 的 3B 默认都是开）。 */
function renderUpscaleBox() {
  const box = $("upscale-box");
  if (!box) return;
  const kaggleSelected = selectedBackend === "kaggle";
  box.innerHTML =
    `<label class="lora-row${kaggleSelected ? "" : " disabled"}"><input type="checkbox" data-upscale ${useUpscale ? "checked" : ""}${kaggleSelected ? "" : " disabled"} /> 超分 SeedVR 7B</label>` +
    `<label class="lora-row${kaggleSelected ? " disabled" : ""}"><input type="checkbox" data-colab-upscale ${useColabUpscale ? "checked" : ""}${kaggleSelected ? " disabled" : ""} /> 超分 SeedVR 3B</label>`;
  box.querySelector("input[data-upscale]").addEventListener("change", (e) => {
    useUpscale = e.target.checked;
  });
  box.querySelector("input[data-colab-upscale]").addEventListener("change", (e) => {
    useColabUpscale = e.target.checked;
  });
}

/** 按当前模型渲染 LoRA 选择区：MOSS 两个复选，Krea2 一个开关，Z-Image 三个复选，Qwen 不显示。 */
function renderLoraBox() {
  const box = $("lora-box");
  if (!box) return;
  if (selectedModel === "moss") {
    box.innerHTML =
      `<span class="lora-title">LoRA（可多选，全不选就是不挂）</span>` +
      MOSS_LORAS.map(
        (l) =>
          `<label class="lora-row"><input type="checkbox" data-lora-key="${l.key}" ${loraState.moss.includes(l.key) ? "checked" : ""} /> ${l.switchLabel}</label>`,
      ).join("");
  } else if (selectedModel === "krea2") {
    box.innerHTML = `<label class="lora-row"><input type="checkbox" data-lora="krea2" ${loraState.krea2 ? "checked" : ""} /> ${KREA2_LORA.switchLabel}</label>`;
  } else if (selectedModel === "zimage") {
    box.innerHTML =
      `<span class="lora-title">LoRA（可多选，全不选就是不挂）</span>` +
      ZIMAGE_LORAS.map(
        (l) =>
          `<label class="lora-row"><input type="checkbox" data-lora-key="${l.key}" ${loraState.zimage.includes(l.key) ? "checked" : ""} /> ${l.switchLabel}</label>`,
      ).join("");
  } else {
    box.innerHTML = "";
  }
  box.querySelectorAll("input[data-lora]").forEach((input) => {
    input.addEventListener("change", () => {
      loraState[input.dataset.lora] = input.checked;
    });
  });
  box.querySelectorAll("input[data-lora-key]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.loraKey;
      const listKey = selectedModel === "moss" ? "moss" : "zimage";
      loraState[listKey] = input.checked
        ? [...new Set([...loraState[listKey], key])]
        : loraState[listKey].filter((k) => k !== key);
    });
  });
}
let currentResultJobId = null;
let currentTab = "generate";
let gallerySelectMode = false;
const selectedGalleryIds = new Set();
// 画廊推送进度圈：正在推送的任务 id 集合（推送循环里逐张加、逐张删；
// 成功/失败的持久状态读任务记录的 galleryPushed，见 galleryPushRingState）。
const pushingGalleryIds = new Set();

/** 画廊推送进度圈 HTML：推送中转圈、成功圈里 ✓、失败圈里 ✗；没推过返回空。
 * inline=true 时是详情页行内小圈（跟在状态文字前面），否则是图库瓦片右上角
 * 的浮圈（删除按钮下方，与左侧用时角标对称，不挡重新生成/删除按钮）。 */
function pushRingHtml(job, inline = false) {
  const state = galleryPushRingState(job, pushingGalleryIds);
  if (!state) return "";
  const label = state === "pushing" ? "正在推送到画廊" : state === "ok" ? "已推送到画廊" : "画廊推送失败";
  const mark = state === "ok" ? "✓" : state === "error" ? "✗" : "";
  return `<span class="g-push-ring ${state}${inline ? " inline" : ""}" aria-label="${label}">${mark}</span>`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toastEl.hidden = true;
  }, ms);
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function populateSelects() {
  $("model-select").innerHTML = MODEL_NAMES.map(
    (m) =>
      `<option value="${m}"${m === selectedModel ? " selected" : ""}>${MODEL_LABELS[m]}</option>`,
  ).join("");
  $("ratio-select").innerHTML =
    `<option value="auto"${selectedRatio === "auto" ? " selected" : ""}>自动</option>` +
    RATIO_KEYS.map(
      (k) =>
        `<option value="${k}"${k === selectedRatio ? " selected" : ""}>${ratioOptionLabel(selectedModel, k)}</option>`,
    ).join("");
}

function timeAgo(ts) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function renderAll() {
  renderJobs();
  renderGallery();
}

let historyExpanded = false;
// 任务卡片默认只显示进度头（圆环+模型+尺寸+时间），点卡片展开才看提示词和详情
const expandedJobs = new Set();

function jobItemHtml(job) {
  const label = STAGE_LABELS[job.stage] || job.stage;
  const done = job.status === "done";
  const failed = job.status === "failed";
  const src = done ? getThumbSrc(job) : null;
  const prog = getJobProgress(job);
  const ringC = 2 * Math.PI * 26; // r=26 的圆周长
  const ringOff = (ringC * (100 - prog.pct)) / 100;
  const ringCls = done ? "ring-done" : failed ? "ring-failed" : "ring-run";
  const ringCenter = done ? "✓" : failed ? "✕" : `${prog.pct}%`;
  const snippet = esc(job.prompt.length > 60 ? job.prompt.slice(0, 60) + "…" : job.prompt);
  const expanded = expandedJobs.has(job.id);
  const galleryLine =
    done && job.galleryPushed === true
      ? `<span class="ok">已推送到画廊</span>`
      : done && job.galleryPushed === false
        ? `<span class="warn">画廊推送失败：${esc(job.galleryError || "未知原因")}</span>`
        : "";
  return `<li class="job${expanded ? " expanded" : ""}" data-id="${job.id}">
    <div class="job-main">
      <div class="job-progress">
        <div class="ring-wrap ${ringCls}">
          <svg class="ring" width="64" height="64" viewBox="0 0 64 64">
            <circle class="ring-track" cx="32" cy="32" r="26" />
            <circle class="ring-fill" cx="32" cy="32" r="26" stroke-dasharray="${ringC.toFixed(2)}" stroke-dashoffset="${ringOff.toFixed(2)}" transform="rotate(-90 32 32)" />
          </svg>
          <span class="ring-pct">${ringCenter}</span>
        </div>
        <span class="ring-label">${prog.label}</span>
      </div>
      <div class="job-info">
        <div class="job-top">
          <span class="badge">${MODEL_LABELS[job.model] ?? job.model}</span>
          <span class="badge${job.backend === "colab" ? " backend-badge-colab" : ""}">${job.backend === "colab" ? "Colab" : "Kaggle"}</span>
          <span class="job-size">${outputSizeForJob(job).width}×${outputSizeForJob(job).height} · ${RATIO_LABELS[job.ratioKey] ?? ""}${job.ratioKey === "auto" ? "自动" : ""}</span>
          <span class="job-time muted">${timeAgo(job.createdAt)}</span>
          <span class="job-chevron" aria-hidden="true">${expanded ? "▾" : "▸"}</span>
        </div>
        <div class="job-detail" ${expanded ? "" : "hidden"}>
        <p class="job-prompt">${snippet}</p>
        <p class="job-stage ${failed ? "error" : ""}">${label}${job.stageDetail ? `：${esc(job.stageDetail)}` : ""}</p>
        ${failed && job.error && job.error !== job.stageDetail ? `<p class="job-error">${esc(job.error)}</p>` : ""}
        ${job.cancelError ? `<p class="job-error">平台取消失败：${esc(job.cancelError)}，请重试删除</p>` : ""}
        ${galleryLine ? `<p class="job-gallery">${galleryLine}</p>` : ""}
        <div class="job-actions">
          ${done && src ? `<button type="button" class="thumb-btn" data-view="${job.id}"><img src="${esc(src)}" alt="结果图" loading="lazy" /></button>` : ""}
          ${failed ? `<button type="button" class="mini-btn" data-retry="${job.id}">重新提交</button>` : ""}
          <button type="button" class="mini-btn" data-switch-colab="${job.id}"${failed ? "" : " disabled"}>切换到 Colab</button>
          ${failed && job.failedAtDownload ? `<button type="button" class="mini-btn primary" data-redownload="${job.id}">重新下载</button>` : ""}
          ${job.status === "downloading" ? `<button type="button" class="mini-btn" data-refetch="${job.id}">重新取回</button>` : ""}
          <button type="button" class="mini-btn danger" data-delete="${job.id}">删除</button>
        </div>
        </div>
      </div>
    </div>
  </li>`;
}

function renderJobs() {
  const jobs = getJobs();
  // 上面只留没完的：进行中 + 失败的（失败要一眼看到、能重提）；完成了的自动收到下面仓库盒子里
  const active = jobs.filter((j) => j.status !== "done");
  const history = jobs.filter((j) => j.status === "done");
  jobsCountEl.textContent = jobs.length ? `${jobs.length} 条` : "";
  jobsEmptyEl.hidden = jobs.length > 0;
  jobListEl.innerHTML = active.map(jobItemHtml).join("");
  // 已完成的任务自动收到下面的小仓库，默认收起，点开看记录
  const box = $("history-box");
  const list = $("history-list");
  box.hidden = history.length === 0;
  $("history-title").textContent = `已完成（${history.length} 条）`;
  $("history-chevron").textContent = historyExpanded ? "▾" : "▸";
  list.hidden = !historyExpanded;
  list.innerHTML = history.map(jobItemHtml).join("");
}

/** 每 2 秒只刷新进度环（弧长 + 百分比 + 阶段字），不整列表重绘，生成中的环会慢慢往前走。 */
function refreshProgressRings() {
  const jobs = getJobs();
  for (const job of jobs) {
    if (job.status === "done" || job.status === "failed") continue;
    const el = document.querySelector(`.job[data-id="${job.id}"] .ring-fill`);
    const pctEl = document.querySelector(`.job[data-id="${job.id}"] .ring-pct`);
    const labelEl = document.querySelector(`.job[data-id="${job.id}"] .ring-label`);
    if (!el || !pctEl || !labelEl) continue;
    const prog = getJobProgress(job);
    const ringC = 2 * Math.PI * 26;
    el.setAttribute("stroke-dashoffset", ((ringC * (100 - prog.pct)) / 100).toFixed(2));
    pctEl.textContent = `${prog.pct}%`;
    labelEl.textContent = prog.label;
  }
}

setInterval(refreshProgressRings, 2000);

/** 生成用时格式化：开始生成（runningStartedAt）到出图（finishedAt）的毫秒数 -> "45秒" / "46分钟" / "1小时26分钟"。 */
function formatDuration(ms) {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}小时${rest}分钟` : `${h}小时`;
}

/** 一张已完成图的生成用时（开始生成 -> 出图）；没记到开始时间（改动前的旧图）返回 ""，不显示也不估算。 */
function jobDurationLabel(job) {
  if (!job || !job.runningStartedAt || !job.finishedAt) return "";
  return formatDuration(job.finishedAt - job.runningStartedAt);
}

function renderGallery() {
  const done = getJobs().filter((j) => j.status === "done" && getImageSrc(j));
  galleryCountEl.textContent = done.length ? `共 ${done.length} 张` : "";
  galleryEmptyEl.hidden = done.length > 0;
  galleryGridEl.innerHTML = done
    .map((job) => {
      const src = getThumbSrc(job);
      const pushed = job.galleryPushed === true;
      const selected = selectedGalleryIds.has(job.id);
      const isRegen = !!job.regeneratedFrom;
      const dur = jobDurationLabel(job);
      return `<figure class="g-tile${gallerySelectMode ? " select-mode" : ""}${selected ? " selected" : ""}" data-id="${job.id}">
        <img src="${esc(src)}" alt="${esc(MODEL_LABELS[job.model] ?? job.model)} 生成图" loading="lazy" data-view="${job.id}" />
        ${dur ? `<span class="g-duration">${esc(dur)}</span>` : ""}
        ${pushRingHtml(job)}
        <figcaption class="g-meta" data-view="${job.id}">
          <span class="g-model">${MODEL_LABELS[job.model] ?? job.model}</span>
          <span class="g-size">${outputSizeForJob(job).width}×${outputSizeForJob(job).height}</span>
          <span class="g-size">${job.backend === "colab" ? "Colab" : "Kaggle"}</span>
          ${isRegen ? `<span class="g-pushed">↻ 重新生成</span>` : ""}
          ${pushed ? `<span class="g-pushed">✓ 已进画廊</span>` : ""}
        </figcaption>
        ${gallerySelectMode ? `<span class="g-check">${selected ? "✓" : ""}</span>` : `<button type="button" class="g-regen" data-regen="${job.id}" aria-label="重新生成">↻</button><button type="button" class="g-del" data-delete="${job.id}" aria-label="删除">✕</button>`}
      </figure>`;
    })
    .join("");
  updateGalleryActions();
}

function updateGalleryActions() {
  $("gallery-actions").hidden = !gallerySelectMode;
  $("gallery-selected-count").textContent = selectedGalleryIds.size ? `已选 ${selectedGalleryIds.size} 张` : "未选图片";
  $("btn-gallery-share").disabled = selectedGalleryIds.size === 0;
}

function enterSelectMode() {
  gallerySelectMode = true;
  $("btn-select-mode").textContent = "取消";
  renderGallery();
}

function exitSelectMode() {
  gallerySelectMode = false;
  selectedGalleryIds.clear();
  $("btn-select-mode").textContent = "选择";
  renderGallery();
}

function fillSettings() {
  const s = getSettings();
  $("set-username").value = s.kaggleUsername;
  $("set-token").value = s.kaggleToken;
  $("set-relay-key").value = s.relayKey;
  $("set-gallery-key").value = s.galleryKey;
  $("set-gallery-url").value = s.galleryUrl;
  $("token-state").textContent = s.kaggleToken
    ? `当前已配置：${maskSecret(s.kaggleToken)}（只显示头尾，完整 Token 不会在界面上出现）`
    : "当前未配置。";
  $("relay-key-state").textContent = s.relayKey
    ? `当前已配置：${maskSecret(s.relayKey)}（只显示头尾，完整密钥不会在界面上出现）`
    : "当前未配置（不填就不能走 Colab）。";
  $("gallery-key-state").textContent = s.galleryKey
    ? `当前已配置：${maskSecret(s.galleryKey)}`
    : "当前未配置（不填就不推送画廊，图只保存在本机）。";
  $("settings-saved").hidden = true;
}

function switchTab(name) {
  const prev = currentTab;
  currentTab = name;
  document.querySelectorAll(".tab-page").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  if (prev === "settings" && name !== "settings") lockSettings();
  if (name === "gallery") {
    renderGallery();
    // 老图补 WebP 缩略图（后台跑，补完自动刷新网格）
    ensureThumbnails().then(renderGallery).catch(() => {});
  }
  if (name === "settings") renderSettings();
  window.scrollTo({ top: 0 });
}

// ---------- 设置页的管理员密码锁 ----------
// 密码只存在本机 Preferences，永不写进代码/仓库；切出设置页自动重新上锁。
let settingsUnlocked = false;

function lockSettings() {
  settingsUnlocked = false;
  ["set-username", "set-token", "set-relay-key", "set-gallery-key", "set-gallery-url", "admin-password", "admin-password-new", "admin-password-confirm"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
  const err = $("admin-password-error");
  if (err) err.hidden = true;
}

async function renderSettings() {
  // 出图提醒开关在不锁的卡片里，锁不锁都要按当前设置显示
  $("set-notify-on-done").checked = getSettings().notifyOnDone !== false;
  const pw = await getAdminPassword();
  const lockEl = $("settings-lock");
  const firstEl = $("settings-first");
  const formEl = $("settings-form");
  if (!pw) {
    lockEl.hidden = true;
    formEl.hidden = true;
    firstEl.hidden = false;
    return;
  }
  if (settingsUnlocked) {
    lockEl.hidden = true;
    firstEl.hidden = true;
    formEl.hidden = false;
    fillSettings();
  } else {
    formEl.hidden = true;
    firstEl.hidden = true;
    lockEl.hidden = false;
    $("admin-password").value = "";
    $("admin-password-error").hidden = true;
  }
}

function openResult(jobId) {
  const job = getJobs().find((j) => j.id === jobId);
  if (!job) return;
  const src = getImageSrc(job);
  if (!src) {
    toast("图片还没读到，请稍后再点");
    return;
  }
  currentResultJobId = jobId;
  resetZoom();
  $("result-img").src = src;
  $("result-title").textContent = `${MODEL_LABELS[job.model] ?? job.model} · ${outputSizeForJob(job).width}×${outputSizeForJob(job).height}`;
  $("result-meta").textContent = `种子 ${job.seed} · ${new Date(job.finishedAt || job.createdAt).toLocaleString()}`;
  const g = $("result-gallery");
  const ring = pushRingHtml(job, true);
  if (job.galleryPushed === true) {
    g.innerHTML = `${ring}<span class="ok">✓ 已推送到天涯画廊</span>`;
  } else if (job.galleryPushed === false) {
    g.innerHTML = `${ring}<span class="warn">画廊推送失败：${esc(job.galleryError || "未知原因")}（图已保存在本机）</span>`;
  } else if (pushingGalleryIds.has(job.id)) {
    g.innerHTML = `${ring}<span>正在推送到画廊…</span>`;
  } else {
    g.textContent = "图已保存在本机。";
  }
  // 有重新生成关联且对方图已出来时，才显示对比按钮
  $("btn-compare").hidden = !getRegenPair(job);
  $("result-view").hidden = false;
}

function closeResult() {
  $("result-view").hidden = true;
  currentResultJobId = null;
  resetZoom();
}

/** 重新生成当前这张图：旧图保留，新任务进任务页；正在生成时对方图还没出来，对比按钮先不显示。 */
async function regenerateCurrent() {
  if (!currentResultJobId) return;
  try {
    const job = await regenerateJob(currentResultJobId);
    toast("已重新生成，新任务在任务页排队");
    closeResult();
    switchTab("tasks");
    renderJobs();
  } catch (e) {
    toast(e.message || "重新生成失败");
  }
}

/** 打开对比视图：原图和重新生成的图上下并排，点任意一张切回大图看。 */
function openCompare() {
  const job = getJobs().find((j) => j.id === currentResultJobId);
  const pair = getRegenPair(job);
  if (!job || !pair) return;
  const orig = job.regeneratedFrom ? pair : job;
  const regen = job.regeneratedFrom ? job : pair;
  $("compare-img-a").src = getImageSrc(orig);
  $("compare-label-a").textContent = `原图 · ${MODEL_LABELS[orig.model] ?? orig.model} · 种子 ${orig.seed}`;
  $("compare-img-b").src = getImageSrc(regen);
  $("compare-label-b").textContent = `重新生成 · ${MODEL_LABELS[regen.model] ?? regen.model} · 种子 ${regen.seed}`;
  $("compare-img-a").dataset.view = orig.id;
  $("compare-img-b").dataset.view = regen.id;
  $("compare-view").hidden = false;
}

function closeCompare() {
  $("compare-view").hidden = true;
}

// ---------- 大图捏合缩放（双指缩放 1x-4x、放大后单指拖动、双击切换 1x/2.5x） ----------
const resultImg = $("result-img");
let zoomScale = 1;
let zoomX = 0;
let zoomY = 0;
const zoomPointers = new Map();
let zoomStartDist = 0;
let zoomStartScale = 1;
let zoomMoved = false;
let zoomSuppressClick = false;
let resultClickTimer = null;

function applyZoom() {
  resultImg.style.transform = `translate(${zoomX}px, ${zoomY}px) scale(${zoomScale})`;
}

function resetZoom() {
  zoomScale = 1;
  zoomX = 0;
  zoomY = 0;
  zoomPointers.clear();
  zoomMoved = false;
  zoomSuppressClick = false;
  if (resultClickTimer) {
    clearTimeout(resultClickTimer);
    resultClickTimer = null;
  }
  resultImg.style.transform = "";
}

resultImg.addEventListener("pointerdown", (e) => {
  resultImg.setPointerCapture(e.pointerId);
  zoomPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (zoomPointers.size === 2) {
    const [a, b] = [...zoomPointers.values()];
    zoomStartDist = Math.hypot(a.x - b.x, a.y - b.y);
    zoomStartScale = zoomScale;
  }
});

resultImg.addEventListener("pointermove", (e) => {
  if (!zoomPointers.has(e.pointerId)) return;
  const prev = zoomPointers.get(e.pointerId);
  zoomPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) > 2) zoomMoved = true;
  if (zoomPointers.size === 2) {
    const [a, b] = [...zoomPointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (zoomStartDist > 0) {
      zoomScale = Math.min(4, Math.max(1, zoomStartScale * (dist / zoomStartDist)));
      if (zoomScale === 1) {
        zoomX = 0;
        zoomY = 0;
      }
      applyZoom();
    }
    zoomSuppressClick = true;
  } else if (zoomPointers.size === 1 && zoomScale > 1) {
    zoomX += e.clientX - prev.x;
    zoomY += e.clientY - prev.y;
    applyZoom();
    zoomSuppressClick = true;
  }
});

function zoomEndPointer(e) {
  zoomPointers.delete(e.pointerId);
  if (zoomPointers.size === 0) {
    if (zoomMoved) {
      zoomSuppressClick = true;
      setTimeout(() => {
        zoomSuppressClick = false;
      }, 300);
    }
    zoomMoved = false;
    zoomStartDist = 0;
  }
}

resultImg.addEventListener("pointerup", zoomEndPointer);
resultImg.addEventListener("pointercancel", zoomEndPointer);

resultImg.addEventListener("dblclick", () => {
  if (resultClickTimer) {
    clearTimeout(resultClickTimer);
    resultClickTimer = null;
  }
  if (zoomScale > 1) {
    resetZoom();
  } else {
    zoomScale = 2.5;
    zoomX = 0;
    zoomY = 0;
    applyZoom();
  }
  zoomSuppressClick = true;
  setTimeout(() => {
    zoomSuppressClick = false;
  }, 300);
});

/** 分享/保存到相册（单张或多张）：把本机图片拷到 Cache，再用系统分享单发出去。 */
async function shareJobs(jobIds, action) {
  const jobs = jobIds
    .map((id) => getJobs().find((j) => j.id === id))
    .filter((j) => j && j.imageFileName);
  if (!jobs.length) {
    toast("没有可分享的图片");
    return;
  }
  try {
    const uris = [];
    for (const job of jobs) {
      const srcPath = `images/${job.imageFileName}`;
      const cacheUri = await Filesystem.getUri({ path: job.imageFileName, directory: Directory.Cache });
      try {
        await Filesystem.copy({
          from: srcPath,
          to: job.imageFileName,
          directory: Directory.Data,
          toDirectory: Directory.Cache,
        });
      } catch {
        // 已有同名缓存文件时直接用
      }
      uris.push(cacheUri.uri);
    }
    await Share.share({
      title: "天涯视界",
      dialogTitle: action === "save" ? "保存到相册" : "分享图片",
      files: uris,
    });
    if (action === "save") toast("已打开分享单，选「存储图像」即可保存到相册");
  } catch (e) {
    if (String(e?.message || e).includes("cancel")) return;
    toast(`分享失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

async function shareCurrentFile(action) {
  if (!currentResultJobId) {
    toast("图片还没读到");
    return;
  }
  await shareJobs([currentResultJobId], action);
}

promptEl.addEventListener("input", () => {
  $("prompt-count").textContent = `${promptEl.value.length} / ${MAX_PROMPT}`;
});

$("model-select").addEventListener("change", (e) => {
  selectedModel = e.target.value;
  renderLoraBox();
  populateSelects(); // 换模型后比例选项的尺寸也要跟着换表重算
});

// 平台选择（Kaggle / Colab 两颗椭圆形药丸按钮）：点亮哪颗就走哪个平台，
// 选择立刻存进设置；下次打开 App 还是上次选的那个。
function syncBackendPills() {
  document.querySelectorAll(".backend-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.backend === selectedBackend);
  });
}

document.querySelectorAll(".backend-pill").forEach((btn) => {
  btn.addEventListener("click", async () => {
    selectedBackend = btn.dataset.backend;
    syncBackendPills();
    // 换后端立刻刷新超分开关的可用状态：7B 只在 Kaggle 下可点，3B 只在 Colab 下可点。
    renderUpscaleBox();
    try {
      await saveSettings({ backend: selectedBackend });
    } catch {
      // 设置保存失败不影响本次选择（下次打开会回到存好的那个）
    }
  });
});

$("ratio-select").addEventListener("change", (e) => {
  selectedRatio = e.target.value;
});

submitBtn.addEventListener("click", async () => {
  formError.hidden = true;
  const prompt = promptEl.value.trim();
  if (!prompt) {
    showFormError("提示词不能为空。");
    promptEl.focus();
    return;
  }
  const s = getSettings();
  if (selectedBackend === "colab") {
    if (!s.relayKey) {
      showFormError("请先在「设置」里填好 Colab 中转密钥。");
      switchTab("settings");
      return;
    }
    // 中转目前没有 Blender3D LoRA 的模型文件（只接了观澜），选了它提交
    // 会在中转那边失败；提前拦住、别让用户等半天才看到报错。
    if (selectedModel === "moss" && loraState.moss.includes("blender3d")) {
      showFormError("Blender3D LoRA 暂不支持 Colab 路线：换 Kaggle，或取消勾选 Blender3D 再提交。");
      return;
    }
  } else if (!s.relayKey) {
    // v3.0：Kaggle 也走中转代劳，提交只要求 Colab 中转密钥，不再要求
    // Kaggle 用户名/Token（设置页那两个输入框保留不动）。
    showFormError("请先在「设置」里填好 Colab 中转密钥。");
    switchTab("settings");
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = "提交中…";
  try {
    await submitJob({
      model: selectedModel,
      prompt,
      ratioKey: selectedRatio,
      backend: selectedBackend,
      useLora: selectedModel === "krea2" ? loraState.krea2 : undefined,
      loraKeys: selectedModel === "zimage" ? [...loraState.zimage] : selectedModel === "moss" ? [...loraState.moss] : undefined,
      useUpscale,
      useColabUpscale,
    });
    promptEl.value = "";
    $("prompt-count").textContent = `0 / ${MAX_PROMPT}`;
    toast(selectedBackend === "colab" ? "已提交到 Colab 中转，排队中（中转一次只跑一单）" : "已提交，云端排队中（一次最多同时跑 2 个）");
    switchTab("tasks");
  } catch (e) {
    showFormError(e instanceof Error ? e.message : String(e));
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "开始生成";
  }
});

async function handleJobListClick(e) {
  const viewBtn = e.target.closest("[data-view]");
  if (viewBtn) {
    openResult(Number(viewBtn.dataset.view));
    return;
  }
  const retryBtn = e.target.closest("[data-retry]");
  if (retryBtn) {
    retryBtn.disabled = true;
    try {
      const retriedId = Number(retryBtn.dataset.retry);
      const retried = await retryJob(retriedId);
      // retryJob 可能恢复云端还在跑的旧单（同 id），也可能新开一单（新 id）
      toast(retried.id === retriedId ? "云端这单还在，正在继续轮询" : "已用新种子重新提交");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  // 「切换到 Colab」：失败任务用原设置新开一单走 Colab；成功/进行中的任务
  // 按钮是灰的（disabled，本身点不到），这里只是兜底。
  const switchBtn = e.target.closest("[data-switch-colab]");
  if (switchBtn) {
    if (switchBtn.disabled) return;
    switchBtn.disabled = true;
    try {
      await switchToColabJob(Number(switchBtn.dataset.switchColab));
      toast("已切换到 Colab 重新提交");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  const refetchBtn = e.target.closest("[data-refetch]");
  if (refetchBtn) {
    refetchBtn.disabled = true;
    try {
      const refetchedId = Number(refetchBtn.dataset.refetch);
      await refetchJob(refetchedId);
      const after = getJobs().find((j) => j.id === refetchedId);
      toast(after?.status === "done" ? "已取回，图片已保存" : "已重新尝试取回，网络恢复后继续下载");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  // 「重新下载」：失败在下载回存的任务点它，只重试下载同一份云端成品，
  // 不重新提交、不重新生成；点完任务回到下载中，进度环显示 95%「下载回存」。
  const redownloadBtn = e.target.closest("[data-redownload]");
  if (redownloadBtn) {
    redownloadBtn.disabled = true;
    try {
      const redownloadedId = Number(redownloadBtn.dataset.redownload);
      await refetchJob(redownloadedId);
      const after = getJobs().find((j) => j.id === redownloadedId);
      toast(after?.status === "done" ? "已下载回存，图片已保存" : "已重新尝试下载，网络恢复后继续下载");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  const delBtn = e.target.closest("[data-delete]");
  if (delBtn) {
    if (!window.confirm("确定删除这条任务吗？已保存的图片文件也会一起删掉。")) return;
    const id = Number(delBtn.dataset.delete);
    expandedJobs.delete(id);
    const res = await deleteJob(id);
    if (res && res.ok === false) toast("平台取消失败，任务还留着：请联网后重试删除");
    else if (res && res.detached) toast("任务已从列表删除，后台继续取图，跑完会进图库");
    return;
  }
  // 点卡片其他地方：展开 / 收起提示词和详情（按钮已在上面处理，不会走到这里）
  const card = e.target.closest(".job");
  if (card) {
    const id = Number(card.dataset.id);
    if (expandedJobs.has(id)) expandedJobs.delete(id);
    else expandedJobs.add(id);
    renderJobs();
  }
}

jobListEl.addEventListener("click", handleJobListClick);
$("history-list").addEventListener("click", handleJobListClick);
$("btn-history-toggle").addEventListener("click", () => {
  historyExpanded = !historyExpanded;
  renderJobs();
});

galleryGridEl.addEventListener("click", async (e) => {
  if (gallerySelectMode) {
    const tile = e.target.closest(".g-tile");
    if (!tile) return;
    const id = Number(tile.dataset.id);
    if (selectedGalleryIds.has(id)) selectedGalleryIds.delete(id);
    else selectedGalleryIds.add(id);
    renderGallery();
    return;
  }
  const delBtn = e.target.closest("[data-delete]");
  if (delBtn) {
    if (!window.confirm("确定删除这张图吗？本机文件和任务记录都会一起删掉，画廊里的那份不受影响。")) return;
    const res = await deleteJob(Number(delBtn.dataset.delete));
    if (res && res.ok === false) toast("平台取消失败，任务还留着：请联网后重试删除");
    else if (res && res.detached) toast("任务已从列表删除，后台继续取图，跑完会进图库");
    return;
  }
  const regenBtn = e.target.closest("[data-regen]");
  if (regenBtn) {
    try {
      await regenerateJob(Number(regenBtn.dataset.regen));
      toast("已重新生成，旧图保留，新任务在任务页排队");
      switchTab("tasks");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  const viewEl = e.target.closest("[data-view]");
  if (viewEl) openResult(Number(viewEl.dataset.view));
});

$("btn-select-mode").addEventListener("click", () => {
  if (gallerySelectMode) exitSelectMode();
  else enterSelectMode();
});

$("btn-gallery-share").addEventListener("click", () => {
  if (!selectedGalleryIds.size) {
    toast("先选几张图");
    return;
  }
  $("share-sheet-count").textContent = `已选 ${selectedGalleryIds.size} 张`;
  $("share-sheet").hidden = false;
});

$("btn-share-sheet-share").addEventListener("click", async () => {
  $("share-sheet").hidden = true;
  await shareJobs([...selectedGalleryIds], "share");
});

$("btn-share-sheet-save").addEventListener("click", async () => {
  $("share-sheet").hidden = true;
  await shareJobs([...selectedGalleryIds], "save");
});

$("btn-share-sheet-cancel").addEventListener("click", () => {
  $("share-sheet").hidden = true;
});

$("btn-gallery-push").addEventListener("click", async () => {
  const ids = [...selectedGalleryIds];
  if (!ids.length) {
    toast("请选择图片推送到画廊");
    return;
  }
  if (!getSettings().galleryKey) {
    toast("请先在「设置」里填好画廊推送密钥");
    switchTab("settings");
    return;
  }
  const btn = $("btn-gallery-push");
  btn.disabled = true;
  btn.textContent = "推送中…";
  let ok = 0;
  let fail = 0;
  let lastError = "";
  for (const id of ids) {
    // 进度圈：这张正在推（转圈），推完（成败都）再拿出来，环按任务记录显示 ✓/✗；
    // 每步重绘图库，环逐张转起来；出错不中断后面几张。
    pushingGalleryIds.add(id);
    renderGallery();
    try {
      const res = await pushJobToGallery(id);
      if (res.ok) ok++;
      else {
        fail++;
        lastError = res.error || "";
      }
    } catch (err) {
      fail++;
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      pushingGalleryIds.delete(id);
    }
    renderGallery();
  }
  btn.disabled = false;
  btn.textContent = "推送到画廊";
  renderGallery();
  renderJobs();
  if (fail === 0) {
    toast(`已推送 ${ok} 张到画廊`);
  } else if (ok === 0) {
    toast(`推送失败：${lastError}`);
  } else {
    toast(`已推送 ${ok} 张，${fail} 张失败：${lastError}`);
  }
  exitSelectMode();
});

$("result-close").addEventListener("click", closeResult);
$("btn-regen").addEventListener("click", regenerateCurrent);
$("btn-compare").addEventListener("click", openCompare);
$("compare-close").addEventListener("click", closeCompare);
// 对比视图里点任意一张图，关掉对比、切回大图看那一张
$("compare-view").addEventListener("click", (e) => {
  const viewEl = e.target.closest("[data-view]");
  if (viewEl) {
    closeCompare();
    openResult(Number(viewEl.dataset.view));
  }
});
// 点一下图关闭；双击是缩放，所以单击要等 260ms 确认不是双击
resultImg.addEventListener("click", () => {
  if (zoomSuppressClick) return;
  if (resultClickTimer) return;
  resultClickTimer = setTimeout(() => {
    resultClickTimer = null;
    if (!zoomSuppressClick) closeResult();
  }, 260);
});
$("btn-save").addEventListener("click", () => shareCurrentFile("save"));
$("btn-share").addEventListener("click", () => shareCurrentFile("share"));

document.querySelector(".tabbar").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

$("btn-unlock-settings").addEventListener("click", async () => {
  const pw = await getAdminPassword();
  const entered = $("admin-password").value;
  if (pw && entered === pw) {
    settingsUnlocked = true;
    renderSettings();
  } else {
    $("admin-password-error").hidden = false;
  }
});

$("admin-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-unlock-settings").click();
});

$("btn-set-admin-password").addEventListener("click", async () => {
  const pw = $("admin-password-new").value;
  const confirm = $("admin-password-confirm").value;
  const err = $("admin-password-set-error");
  if (!pw || pw.length < 4) {
    err.textContent = "密码至少 4 位。";
    err.hidden = false;
    return;
  }
  if (pw !== confirm) {
    err.textContent = "两次输入的密码不一致。";
    err.hidden = false;
    return;
  }
  await setAdminPassword(pw);
  settingsUnlocked = true;
  renderSettings();
  toast("管理员密码已设置");
});

$("btn-lock-settings").addEventListener("click", () => {
  lockSettings();
  renderSettings();
});

$("btn-save-settings").addEventListener("click", async () => {
  try {
    await saveSettings({
      kaggleUsername: $("set-username").value,
      kaggleToken: $("set-token").value,
      relayKey: $("set-relay-key").value,
      galleryKey: $("set-gallery-key").value,
      galleryUrl: $("set-gallery-url").value,
    });
    fillSettings();
    $("settings-saved").hidden = false;
    toast("设置已保存");
  } catch (e) {
    toast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
  }
});

// 出图提醒开关：一点就保存，不用等“保存设置”按钮；打开时重新要一次通知权限
// （用户之前拒绝过的话，开关开了也不会响，得先在系统里允许）。
$("set-notify-on-done").addEventListener("change", async (e) => {
  const on = e.target.checked;
  try {
    await saveSettings({ notifyOnDone: on });
    if (on && Capacitor.isNativePlatform()) {
      LocalNotifications.requestPermissions().catch(() => {});
    }
    toast(on ? "出图完成提醒已开启" : "出图完成提醒已关闭");
  } catch (err) {
    toast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    e.target.checked = !on;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeResult();
});

onJobsChange(renderAll);

// 设置页“关于”里的版本号：构建时由 vite 从 package.json 注入
// （__APP_VERSION__，见 vite.config.js），不用手写，发版自动跟着变。
const appVersionEl = document.getElementById("app-version");
if (appVersionEl && typeof __APP_VERSION__ !== "undefined") {
  appVersionEl.textContent = __APP_VERSION__;
}

populateSelects();
renderLoraBox();
renderUpscaleBox();
renderAll();

// 生成完成/失败的系统通知：首次打开时请求一次通知权限（用户拒绝也不影响生图本身）
if (Capacitor.isNativePlatform()) {
  LocalNotifications.requestPermissions().catch(() => {});
}

initJobs()
  .then(() => {
    // 恢复上次选的平台（存设置里），药丸按钮跟着点亮，超分开关的可用状态也跟着变
    selectedBackend = getSettings().backend === "colab" ? "colab" : "kaggle";
    syncBackendPills();
    renderUpscaleBox();
  })
  .catch((e) => {
    toast(`初始化失败：${e instanceof Error ? e.message : String(e)}`);
  });

// 切回前台立刻刷新一次任务状态：iOS 切到后台会挂起定时器，轮询停掉，
// 回来只靠 20 秒定时器要等下一轮；切回来马上跑一轮，状态立刻跟上。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshJobsNow();
});
window.addEventListener("focus", () => {
  refreshJobsNow();
});

// 断网横条：网络断开时显示“网络暂时断开，正在重连…”，重连成功后消失。
// 任务本身不标失败，横条只是提示。
const netBanner = document.getElementById("net-banner");
if (netBanner) {
  onNetworkChange((down) => {
    netBanner.hidden = !down;
  });
  netBanner.hidden = !isNetworkDown();
}
