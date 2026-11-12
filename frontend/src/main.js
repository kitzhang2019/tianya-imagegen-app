// main.js — 界面接线：生图 / 图库 / 设置 三个板块 + 结果查看。
// 底部毛玻璃标签栏切换；生图是完整流程（提示词/模型/比例/提交/任务），
// 图库是本机已出图的网格，设置是独立板块（不再是浮层）。

import "./styles.css";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  MODEL_LABELS,
  MODEL_NAMES,
  RATIO_KEYS,
  RATIO_LABELS,
} from "./lib/notebook.js";
import {
  STAGE_LABELS,
  deleteJob,
  ensureThumbnails,
  getAdminPassword,
  getImageSrc,
  getJobProgress,
  getJobs,
  getRegenPair,
  getSettings,
  getThumbSrc,
  initJobs,
  maskSecret,
  onJobsChange,
  pushJobToGallery,
  regenerateJob,
  retryJob,
  saveSettings,
  setAdminPassword,
  submitJob,
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
        <label class="select-label" for="model-select">模型</label>
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
      <button id="btn-submit" class="primary-btn">开始生成</button>
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
      <button id="btn-select-mode" class="mini-btn" type="button">选择</button>
    </div>
    <div id="gallery-grid" class="gallery-grid"></div>
    <p id="gallery-empty" class="muted empty">还没有出图。去「生图」写一段提示词，生成的第一张图就会出现在这里。</p>
    <div id="gallery-actions" class="gallery-actions" hidden>
      <span id="gallery-selected-count" class="muted"></span>
      <button id="btn-gallery-share" class="secondary-btn" type="button">分享</button>
      <button id="btn-gallery-push" class="primary-btn" type="button">推送到画廊</button>
    </div>
  </section>

  <!-- 设置（管理员密码锁：未解锁看不到 Kaggle 账号、Token 和画廊设置） -->
  <section id="tab-settings" class="tab-page">
    <div id="settings-lock" class="card glass" hidden>
      <h2>设置已锁定</h2>
      <p class="muted">Kaggle 账号、Token 和画廊设置需要管理员密码才能查看和修改。</p>
      <label class="field-label" for="admin-password">管理员密码</label>
      <input id="admin-password" type="password" inputmode="numeric" autocomplete="off" placeholder="输入管理员密码" />
      <p id="admin-password-error" class="error" hidden>密码不对，请重试。</p>
      <button id="btn-unlock-settings" class="primary-btn">解锁设置</button>
    </div>
    <div id="settings-first" class="card glass" hidden>
      <h2>首次使用：设置管理员密码</h2>
      <p class="muted">以后查看和修改 Kaggle 账号、Token 和画廊设置都要输这个密码。密码只存在本机，不会上传。</p>
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
let currentResultJobId = null;
let currentTab = "generate";
let gallerySelectMode = false;
const selectedGalleryIds = new Set();

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
        `<option value="${k}"${k === selectedRatio ? " selected" : ""}>${RATIO_LABELS[k]}</option>`,
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
  const galleryLine =
    done && job.galleryPushed === true
      ? `<span class="ok">已推送到画廊</span>`
      : done && job.galleryPushed === false
        ? `<span class="warn">画廊推送失败：${esc(job.galleryError || "未知原因")}</span>`
        : "";
  return `<li class="job" data-id="${job.id}">
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
          <span class="job-size">${job.width}×${job.height} · ${RATIO_LABELS[job.ratioKey] ?? ""}${job.ratioKey === "auto" ? "自动" : ""}</span>
          <span class="job-time muted">${timeAgo(job.createdAt)}</span>
        </div>
        <p class="job-prompt">${snippet}</p>
        <p class="job-stage ${failed ? "error" : ""}">${label}${job.stageDetail ? `：${esc(job.stageDetail)}` : ""}</p>
        ${failed && job.error ? `<p class="job-error">${esc(job.error)}</p>` : ""}
        ${galleryLine ? `<p class="job-gallery">${galleryLine}</p>` : ""}
        <div class="job-actions">
          ${done && src ? `<button type="button" class="thumb-btn" data-view="${job.id}"><img src="${esc(src)}" alt="结果图" loading="lazy" /></button>` : ""}
          ${failed ? `<button type="button" class="mini-btn" data-retry="${job.id}">重新提交</button>` : ""}
          <button type="button" class="mini-btn danger" data-delete="${job.id}">删除</button>
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
      return `<figure class="g-tile${gallerySelectMode ? " select-mode" : ""}${selected ? " selected" : ""}" data-id="${job.id}">
        <img src="${esc(src)}" alt="${esc(MODEL_LABELS[job.model] ?? job.model)} 生成图" loading="lazy" data-view="${job.id}" />
        <figcaption class="g-meta" data-view="${job.id}">
          <span class="g-model">${MODEL_LABELS[job.model] ?? job.model}</span>
          <span class="g-size">${job.width}×${job.height}</span>
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
  $("btn-gallery-push").disabled = selectedGalleryIds.size === 0;
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
  $("set-gallery-key").value = s.galleryKey;
  $("set-gallery-url").value = s.galleryUrl;
  $("token-state").textContent = s.kaggleToken
    ? `当前已配置：${maskSecret(s.kaggleToken)}（只显示头尾，完整 Token 不会在界面上出现）`
    : "当前未配置。";
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
  ["set-username", "set-token", "set-gallery-key", "set-gallery-url", "admin-password", "admin-password-new", "admin-password-confirm"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
  const err = $("admin-password-error");
  if (err) err.hidden = true;
}

async function renderSettings() {
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
  $("result-title").textContent = `${MODEL_LABELS[job.model] ?? job.model} · ${job.width}×${job.height}`;
  $("result-meta").textContent = `种子 ${job.seed} · ${new Date(job.finishedAt || job.createdAt).toLocaleString()}`;
  const g = $("result-gallery");
  if (job.galleryPushed === true) {
    g.innerHTML = `<span class="ok">✓ 已推送到天涯画廊</span>`;
  } else if (job.galleryPushed === false) {
    g.innerHTML = `<span class="warn">画廊推送失败：${esc(job.galleryError || "未知原因")}（图已保存在本机）</span>`;
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
      const cacheUri = await Filesystem.getUri({ path: job.imageFileName, directory: Directory.Cache });
      try {
        await Filesystem.copy({
          from: job.imageFileName,
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
  if (!s.kaggleUsername || !s.kaggleToken) {
    showFormError("请先在「设置」里完成配置。");
    switchTab("settings");
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = "提交中…";
  try {
    await submitJob({ model: selectedModel, prompt, ratioKey: selectedRatio });
    promptEl.value = "";
    $("prompt-count").textContent = `0 / ${MAX_PROMPT}`;
    toast("已提交，云端排队中（一次最多同时跑 2 个）");
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
      await retryJob(Number(retryBtn.dataset.retry));
      toast("已用新种子重新提交");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  const delBtn = e.target.closest("[data-delete]");
  if (delBtn) {
    if (!window.confirm("确定删除这条任务吗？已保存的图片文件也会一起删掉。")) return;
    await deleteJob(Number(delBtn.dataset.delete));
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
    await deleteJob(Number(delBtn.dataset.delete));
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
    toast("先选几张图");
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
    }
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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeResult();
});

onJobsChange(renderAll);

populateSelects();
renderAll();

initJobs().catch((e) => {
  toast(`初始化失败：${e instanceof Error ? e.message : String(e)}`);
});
