// colab.js — Colab 中转客户端（Cloudflare Worker colab-relay）。
// App 的 Colab 后端走它：POST /job 提交、GET /job/<id> 轮询、
// GET /job/<id>/webp|png 下载结果图。认证是 X-Colab-Key 请求头，
// 与 Kaggle Token 同款做法：设置里填、只存在手机本地，代码里绝不写死。
// 传输层复用 kaggle.js 的 httpRequest（真机走 CapacitorHttp、
// 桌面浏览器走 fetch），并带桌面 Chrome UA——中转域名开了 Cloudflare
// 校验，非浏览器 UA 会被 1010 拦下。
import { MAX_IMAGE_BYTES, httpRequest } from "./kaggle.js";

export const COLAB_RELAY_BASE = "https://colab.tianyagk.dpdns.org";
export const COLAB_MODELS = ["moss", "qwen", "krea2", "zimage"];

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_MARK = [0x57, 0x45, 0x42, 0x50];

export class ColabError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "ColabError";
    this.status = status;
  }
}

function looksLike(bytes, magic) {
  return magic.every((byte, index) => bytes[index] === byte);
}

function isLikelyWebp(bytes) {
  return looksLike(bytes, WEBP_RIFF) && looksLike(bytes.slice(8, 12), WEBP_MARK);
}

function isLikelyPng(bytes) {
  return looksLike(bytes, PNG_MAGIC);
}

function isNetworkErrorText(text) {
  return (
    typeof text === "string" &&
    /fetch failed|network|网络|Failed to fetch|Load failed|NSURLErrorDomain|The Internet connection appears to be offline|offline|AbortError|timed out|timed? ?out|ETIMEDOUT|ECONNREFUSED|ERR_INTERNET_DISCONNECTED/i.test(
      text,
    )
  );
}

// 把中转的错误码翻成人话：401 是密钥不对、503 是 Worker 那边还没配密钥，
// 别让用户对着一串数字猜。
async function colabErrorDetail(status, bodyText) {
  let error = "";
  try {
    error = JSON.parse(bodyText || "{}")?.error || "";
  } catch {
    error = "";
  }
  const msg = error || bodyText || "";
  if (status === 401) {
    return "中转密钥不对（401）。请到设置里确认 Colab 中转密钥：填的应是和 Cloudflare Worker 上 RELAY_KEY 同一串；如果刚换过密钥，两边都要换成同一串。";
  }
  if (status === 503 && /relay key not configured/i.test(msg)) {
    return "中转那边还没配好密钥（Worker 上没有 RELAY_KEY），请检查 Cloudflare Worker 的 secret。";
  }
  if (status === 400) {
    return `中转拒绝了这次提交（400）：${msg || "参数不对"}`;
  }
  return `Colab 中转返回 HTTP ${status}${msg ? `：${msg}` : ""}`;
}

export class ColabClient {
  constructor({ key }) {
    this.key = String(key || "").trim();
  }

  _headers(extra = {}) {
    return {
      "X-Colab-Key": this.key,
      ...extra,
    };
  }

  // 提交一单。返回 { jobId }。seed 为空时中转会自己随机一个
  // （见 CONNECTOR.md：submitted job echoes back a seed）。
  // Kaggle 后端（v3.0）额外传 backend="kaggle" + notebookText +
  // kaggleSlug + datasetSources + title + appJobId，守护进程代劳提交；
  // Colab 提交不传这些字段（backend 不传或传 "colab"）。
  async submitJob({
    model,
    prompt,
    ratioKey = "auto",
    seed = null,
    loraKeys,
    useLora,
    useUpscale = true,
    backend,
    notebookText,
    kaggleSlug,
    datasetSources,
    title,
    appJobId,
  }) {
    const body = {
      model,
      prompt,
      ratioKey,
      seed,
      loraKeys,
      useLora,
      useUpscale,
      source: "app",
    };
    if (backend) body.backend = backend;
    if (notebookText != null) body.notebookText = notebookText;
    if (kaggleSlug) body.kaggleSlug = kaggleSlug;
    if (datasetSources) body.datasetSources = datasetSources;
    if (title) body.title = title;
    if (appJobId != null) body.appJobId = appJobId;
    let res;
    try {
      res = await httpRequest({
        url: `${COLAB_RELAY_BASE}/job`,
        method: "POST",
        headers: this._headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
        timeoutMs: 60000,
        responseType: "json",
      });
    } catch (e) {
      throw new ColabError(
        `连不上 Colab 中转（提交任务）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ColabError(await colabErrorDetail(res.status, res.text), res.status);
    }
    const data = res.data ?? {};
    if (!data?.ok || !data?.job_id) {
      throw new ColabError(`中转提交被拒：${data?.error || "未知原因"}`);
    }
    return { jobId: data.job_id };
  }

  // 查一单的状态。返回 Worker job 行原样：
  // { id, status: "queued"|"running"|"done"|"failed", progress, stage, error, ... }
  async getJob(jobId) {
    let res;
    try {
      res = await httpRequest({
        url: `${COLAB_RELAY_BASE}/job/${encodeURIComponent(jobId)}`,
        method: "GET",
        headers: this._headers(),
        timeoutMs: 30000,
        responseType: "json",
      });
    } catch (e) {
      throw new ColabError(
        `连不上 Colab 中转（查询状态）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (res.status === 404) {
      throw new ColabError("中转那边找不到这单任务（404），它可能已被清掉。", 404);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ColabError(await colabErrorDetail(res.status, res.text), res.status);
    }
    const job = res.data?.job;
    if (!res.data?.ok || !job) {
      throw new ColabError("中转返回的状态读不懂（没有 job 字段）。");
    }
    return job;
  }

  // 取消一单：POST /job/<id>/fail，把中转里的任务标失败，守护进程不再领走
  // 执行。404 = 中转那边已经没了这单，当已取消处理。
  // error 文案会写进中转 job 行的 error 字段，供守护进程/排障时看。
  async failJob(jobId, error = "已在 App 里删除") {
    let res;
    try {
      res = await httpRequest({
        url: `${COLAB_RELAY_BASE}/job/${encodeURIComponent(jobId)}/fail`,
        method: "POST",
        headers: this._headers({ "content-type": "application/json" }),
        body: JSON.stringify({ error }),
        timeoutMs: 30000,
        responseType: "json",
      });
    } catch (e) {
      throw new ColabError(
        `连不上 Colab 中转（取消任务）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (res.status === 404) return { alreadyGone: true };
    if (res.status < 200 || res.status >= 300) {
      throw new ColabError(await colabErrorDetail(res.status, res.text), res.status);
    }
    return { alreadyGone: false };
  }

  // 下载结果图。format: "webp" | "png"。下载不重试（404 只会是
  // 结果还没准备好，重下也没用；网络问题由调用方留在下载状态等下一轮）。
  async downloadImage(jobId, format) {
    const wantWebp = format === "webp";
    const res = await httpRequest({
      url: `${COLAB_RELAY_BASE}/job/${encodeURIComponent(jobId)}/${format}`,
      method: "GET",
      headers: this._headers(),
      timeoutMs: 120000,
      responseType: "arraybuffer",
    });
    if (res.status === 404) {
      throw new ColabError("中转说结果还没准备好（404）。", 404);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ColabError(await colabErrorDetail(res.status, res.text), res.status);
    }
    const bytes = res.bytes;
    if (!bytes || bytes.length === 0) {
      throw new ColabError("中转返回的图片是空的。");
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ColabError(
        `图片太大（${(bytes.length / 1024 / 1024).toFixed(1)} MB），已跳过这张。`,
      );
    }
    if (wantWebp && !isLikelyWebp(bytes)) {
      throw new ColabError("下载的文件不是 WebP（内容不对）。");
    }
    if (!wantWebp && !isLikelyPng(bytes)) {
      throw new ColabError("下载的文件不是 PNG（内容不对）。");
    }
    return bytes;
  }
}

// 供单测：Colab 轮询把“网络断了”和“中转明确拒绝”分开。
export { isNetworkErrorText };
