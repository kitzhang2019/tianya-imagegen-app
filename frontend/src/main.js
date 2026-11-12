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
  getImageSrc,
  getJobs,
  getSettings,
  initJobs,
  maskSecret,
  onJobsChange,
  retryJob,
  saveSettings,
  submitJob,
} from "./lib/jobs.js";

const MAX_PROMPT = 10000;

const app = document.getElementById("app");

app.innerHTML = `
<header class="app-header">
  <div class="brand">
    <span class="brand-mark">✦</span>
    <div class="brand-text">
      <h1>天涯生图</h1>
      <p class="brand-sub">Kaggle 免费 GPU · 出图自动进画廊</p>
    </div>
  </div>
  <span id="creds-chip" class="creds-chip"></span>
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
        <span id="creds-hint" class="muted"></span>
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
      <p id="jobs-empty" class="muted empty">还没有任务，去「生图」写好提示词点「开始生成」。Kaggle 上一次最多同时跑 2 个，多余的会在本地排队。</p>
    </div>
    <p class="footnote muted">生图走你自己的 Kaggle 账号（T4 免费 GPU），出图后自动保存到本机并推送到天涯画廊。Token 只存在本机设置里，不会发给任何第三方。</p>
  </section>

  <!-- 图库 -->
  <section id="tab-gallery" class="tab-page">
    <div class="gallery-head">
      <h2>图库</h2>
      <span id="gallery-count" class="muted"></span>
    </div>
    <div id="gallery-grid" class="gallery-grid"></div>
    <p id="gallery-empty" class="muted empty">还没有出图。去「生图」写一段提示词，生成的第一张图就会出现在这里。</p>
  </section>

  <!-- 设置 -->
  <section id="tab-settings" class="tab-page">
    <div class="card glass settings-card">
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
      <button id="btn-save" class="primary-btn">保存到相册</button>
      <button id="btn-share" class="secondary-btn">分享</button>
    </div>
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

function renderCredsHint() {
  const s = getSettings();
  const ok = s.kaggleUsername && s.kaggleToken;
  $("creds-hint").textContent = ok
    ? `Kaggle：${s.kaggleUsername}（已配置）`
    : "Kaggle 未配置，去「设置」里填";
  $("creds-chip").textContent = ok ? "● 已配置" : "○ 未配置";
  $("creds-chip").classList.toggle("ok-chip", !!ok);
}

function timeAgo(ts) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function renderJobs() {
  const jobs = getJobs();
  jobsCountEl.textContent = jobs.length ? `${jobs.length} 条` : "";
  jobsEmptyEl.hidden = jobs.length > 0;
  jobListEl.innerHTML = jobs
    .map((job) => {
      const label = STAGE_LABELS[job.stage] || job.stage;
      const done = job.status === "done";
      const failed = job.status === "failed";
      const src = done ? getImageSrc(job) : null;
      const snippet = esc(job.prompt.length > 60 ? job.prompt.slice(0, 60) + "…" : job.prompt);
      const galleryLine =
        done && job.galleryPushed === true
          ? `<span class="ok">已推送到画廊</span>`
          : done && job.galleryPushed === false
            ? `<span class="warn">画廊推送失败：${esc(job.galleryError || "未知原因")}</span>`
            : "";
      return `<li class="job" data-id="${job.id}">
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
      </li>`;
    })
    .join("");
}

function renderGallery() {
  const done = getJobs().filter((j) => j.status === "done" && getImageSrc(j));
  galleryCountEl.textContent = done.length ? `共 ${done.length} 张` : "";
  galleryEmptyEl.hidden = done.length > 0;
  galleryGridEl.innerHTML = done
    .map((job) => {
      const src = getImageSrc(job);
      const pushed = job.galleryPushed === true;
      return `<figure class="g-tile" data-id="${job.id}">
        <img src="${esc(src)}" alt="${esc(MODEL_LABELS[job.model] ?? job.model)} 生成图" loading="lazy" data-view="${job.id}" />
        <figcaption class="g-meta" data-view="${job.id}">
          <span class="g-model">${MODEL_LABELS[job.model] ?? job.model}</span>
          <span class="g-size">${job.width}×${job.height}</span>
          ${pushed ? `<span class="g-pushed">✓ 已进画廊</span>` : ""}
        </figcaption>
        <button type="button" class="g-del" data-delete="${job.id}" aria-label="删除">✕</button>
      </figure>`;
    })
    .join("");
}

function renderAll() {
  renderCredsHint();
  renderJobs();
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
  currentTab = name;
  document.querySelectorAll(".tab-page").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  if (name === "gallery") renderGallery();
  if (name === "settings") fillSettings();
  window.scrollTo({ top: 0 });
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
  $("result-img").src = src;
  $("result-title").textContent = `${MODEL_LABELS[job.model] ?? job.model} · ${job.width}×${job.height}`;
  $("result-meta").textContent = `种子 ${job.seed} · ${new Date(job.finishedAt || job.createdAt).toLocaleString()}`;
  const g = $("result-gallery");
  if (job.galleryPushed === true) {
    g.innerHTML = `<span class="ok">✓ 已推送到天涯画廊</span>`;
  } else if (job.galleryPushed === false) {
    g.innerHTML = `<span class="warn">画廊推送失败：${esc(job.galleryError || "未知原因")}（图已保存在本机）</span>`;
  } else {
    g.textContent = "未配置画廊推送密钥，图只保存在本机。";
  }
  $("result-view").hidden = false;
}

function closeResult() {
  $("result-view").hidden = true;
  currentResultJobId = null;
}

async function shareCurrentFile(action) {
  const job = getJobs().find((j) => j.id === currentResultJobId);
  if (!job || !job.imagePath) {
    toast("图片还没读到");
    return;
  }
  try {
    // Share 插件要的是本机文件路径：把 Data 目录里的图拷一份到 Cache 再分享，
    // iOS 分享单里就会出现「存储图像」（保存到相册）。
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
    await Share.share({
      title: "天涯生图",
      dialogTitle: action === "save" ? "保存到相册" : "分享图片",
      files: [cacheUri.uri],
    });
    if (action === "save") toast("已打开分享单，选「存储图像」即可保存到相册");
  } catch (e) {
    if (String(e?.message || e).includes("cancel")) return;
    toast(`分享失败：${e instanceof Error ? e.message : String(e)}`);
  }
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
    showFormError("请先去「设置」里填好 Kaggle 用户名和 API Token。");
    switchTab("settings");
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = "提交中…";
  try {
    await submitJob({ model: selectedModel, prompt, ratioKey: selectedRatio });
    promptEl.value = "";
    $("prompt-count").textContent = `0 / ${MAX_PROMPT}`;
    toast("已提交，Kaggle 排队中（一次最多同时跑 2 个）");
    switchTab("tasks");
  } catch (e) {
    showFormError(e instanceof Error ? e.message : String(e));
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "开始生成";
  }
});

jobListEl.addEventListener("click", async (e) => {
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
});

galleryGridEl.addEventListener("click", async (e) => {
  const delBtn = e.target.closest("[data-delete]");
  if (delBtn) {
    if (!window.confirm("确定删除这张图吗？本机文件和任务记录都会一起删掉，画廊里的那份不受影响。")) return;
    await deleteJob(Number(delBtn.dataset.delete));
    return;
  }
  const viewEl = e.target.closest("[data-view]");
  if (viewEl) openResult(Number(viewEl.dataset.view));
});

$("result-close").addEventListener("click", closeResult);
$("result-img").addEventListener("click", closeResult);
$("btn-save").addEventListener("click", () => shareCurrentFile("save"));
$("btn-share").addEventListener("click", () => shareCurrentFile("share"));

document.querySelector(".tabbar").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  switchTab(btn.dataset.tab);
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
    renderCredsHint();
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
fillSettings();

initJobs().catch((e) => {
  toast(`初始化失败：${e instanceof Error ? e.message : String(e)}`);
});
