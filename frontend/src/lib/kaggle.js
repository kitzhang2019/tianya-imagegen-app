// kaggle.js — Kaggle API 客户端（Kaggle 直连，与管理站 actions.ts 的
// kagglePushKernel / kaggleKernelStatus / kaggleFindOutputFile /
// kaggleAuthHeader / kaggleErrorDetail / runKaggleDirectSubmission 同款逻辑）。
// 传输层：在真机上用 CapacitorHttp（原生 HTTP，绕过 CORS）；在桌面浏览器
// 里回退到 fetch。下载的结果 PNG 走同一条路。

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { base64ToBytes, bytesToBase64, utf8ToBase64 } from "./notebook.js";

export const KAGGLE_API_BASE = "https://www.kaggle.com/api/v1";
export const MOODY_DATASET_SLUG = "moody-moss-mix-v33";
export const MOODY_MODEL_FILE =
  "Moody-Moss-Mix-V3.3_00001__clean-int8_convrot.safetensors";
export const MOODY_MODEL_BYTES = 5088901904;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const MAX_PNG_BYTES = 8 * 1024 * 1024;

export class KaggleError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "KaggleError";
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** KGAT Token -> Bearer；其他 key -> Basic base64(username:key) */
export function kaggleAuthHeader(creds) {
  return creds.key.startsWith("KGAT")
    ? `Bearer ${creds.key}`
    : `Basic ${utf8ToBase64(`${creds.username}:${creds.key}`)}`;
}

/** 把 push 响应里的 ref/url 归一化成 "user/slug"，不合规返回 null。 */
export function normalizeKaggleRef(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const codeAt = s.indexOf("/code/");
  if (codeAt >= 0) {
    s = s.slice(codeAt + "/code/".length);
  } else if (s.startsWith("code/")) {
    s = s.slice("code/".length);
  }
  s = s.replace(/^\/+/, "").replace(/\/+$/, "").split(/[?#]/)[0] ?? "";
  const m = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(s);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

export function splitKaggleRef(ref) {
  const parts = String(ref).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { userName: parts[0], kernelSlug: parts[1] };
}

/** 状态归一化：小写、去非字母、去 kernelworkerstatus 前缀后映射。 */
export function normalizeKernelStatus(rawStatus) {
  const rawText = rawStatus ?? "";
  let raw = String(rawText).toLowerCase().replace(/[^a-z]/g, "");
  if (raw.startsWith("kernelworkerstatus")) {
    raw = raw.slice("kernelworkerstatus".length);
  }
  if (raw === "queued" || raw === "new" || raw === "newscript") return "queued";
  if (raw === "running") return "running";
  if (raw === "complete") return "complete";
  if (raw === "error" || raw.startsWith("cancel")) return "error";
  return "unknown";
}

// REST 风格错误的中文说明（401 Token 过期/错型、403 需手机验证、404 用户名对不上）
async function kaggleErrorDetail(status, bodyText) {
  let msg = "";
  try {
    const parsed = JSON.parse(bodyText || "");
    msg = parsed?.message ?? parsed?.error ?? "";
  } catch {
    msg = "";
  }
  if (status === 401) {
    return `Kaggle API 拒绝了凭据（401${msg ? `：${msg}` : ""}）。多半是凭据类型与认证方式不匹配，或这串 Token 已过期 / 已被撤销。请到设置里确认：填的应是 Kaggle 设置页 API Tokens 栏点「Generate New Token」生成的那串以 KGAT 开头的 Token；若已过期或被撤销，在 Kaggle 那边重新生成一串新的再填回来即可（不用下 kaggle.json）。`;
  }
  if (status === 403) {
    return `Kaggle API 返回 403${msg ? `：${msg}` : ""}。常见原因是 Kaggle 账号还没做手机号验证（在 Kaggle Settings 里验证手机号后，API 才能提交 kernel），或这个 Token 没有提交权限。`;
  }
  if (status === 404) {
    return `Kaggle API 返回 404${msg ? `：${msg}` : ""}。多半是设置里填的 Kaggle 用户名和这个 Token 实际所属的账号对不上。`;
  }
  return `Kaggle API 返回 HTTP ${status}${msg ? `：${msg}` : ""}`;
}

// RPC（KernelsApiService）错误的中文说明，信封是 {"error":{"message":...}}
async function kaggleRpcErrorDetail(status, bodyText) {
  let msg = "";
  try {
    const parsed = JSON.parse(bodyText || "");
    msg = parsed?.error?.message ?? "";
  } catch {
    msg = "";
  }
  if (status === 401) {
    return `Kaggle API 拒绝了凭据（401${msg ? `：${msg}` : ""}）。多半是这串 Token 已过期 / 已被撤销——到设置里换一串 Kaggle 设置页 API Tokens 栏点「Generate New Token」新生成的 KGAT Token 再试。`;
  }
  if (status === 404) {
    return `Kaggle 查不到这个 Kernel（404${msg ? `：${msg}` : ""}）——它还没在 Kaggle 上建出来，或已经被删掉。`;
  }
  if (status === 403) {
    return `Kaggle API 返回 403${msg ? `：${msg}` : ""}。常见原因是 Kaggle 账号还没做手机号验证（在 Kaggle Settings 里验证手机号后，API 才能提交 kernel）。`;
  }
  return `Kaggle API 返回 HTTP ${status}${msg ? `：${msg}` : bodyText ? `：${String(bodyText).slice(0, 120)}` : ""}`;
}

/**
 * 统一 HTTP 请求。
 * @returns {{status:number, data:any, text:string, bytes:Uint8Array|null}}
 * data：JSON 响应时为解析后的对象；text 为原始文本；bytes 仅 responseType
 * 为 arraybuffer 时有值。CapacitorHttp 在真机与浏览器里都会把 arraybuffer
 * 响应以 base64 字符串放在 data 里，这里统一解回 Uint8Array。
 */
async function httpRequest({ url, method = "GET", headers = {}, body = null, timeoutMs = 30000, responseType = "text" }) {
  const isNative = Capacitor.isNativePlatform();
  if (isNative) {
    const res = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: body ?? undefined,
      connectTimeout: Math.min(timeoutMs, 15000),
      readTimeout: timeoutMs,
      responseType,
    });
    const status = res.status;
    if (responseType === "arraybuffer" || responseType === "blob") {
      const bytes =
        typeof res.data === "string"
          ? base64ToBytes(res.data)
          : res.data instanceof ArrayBuffer
            ? new Uint8Array(res.data)
            : null;
      return { status, data: res.data, text: "", bytes };
    }
    const text = typeof res.data === "string" ? res.data : "";
    return { status, data: res.data, text, bytes: null };
  }
  // 桌面浏览器回退：普通 fetch（Kaggle API 一般不放行浏览器跨域，
  // 正式使用请在真机上跑）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: controller.signal,
    });
    const status = res.status;
    if (responseType === "arraybuffer" || responseType === "blob") {
      const buf = await res.arrayBuffer();
      return { status, data: null, text: "", bytes: new Uint8Array(buf) };
    }
    const text = await res.text();
    let data = text;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { status, data, text, bytes: null };
  } finally {
    clearTimeout(timer);
  }
}

export class KaggleClient {
  /** @param {{username:string, key:string}} creds */
  constructor(creds) {
    this.creds = { username: String(creds.username || "").trim(), key: String(creds.key || "").trim() };
    this._accountCache = null; // {fingerprint, at, username, detail}
  }

  _authHeaders(extra = {}) {
    return { Authorization: kaggleAuthHeader(this.creds), ...extra };
  }

  async _fetchJson(url, { method = "GET", body = null, timeoutMs = 30000 } = {}) {
    const res = await httpRequest({
      url,
      method,
      headers: this._authHeaders({ "content-type": "application/json" }),
      body: body != null ? JSON.stringify(body) : null,
      timeoutMs,
      responseType: "json",
    });
    return res;
  }

  /** POST /kernels/push（JSON POST，官方验证过的路径；不要用 multipart）。 */
  async pushKernel({ slug, title, text, datasetSources = [] }) {
    let res;
    try {
      res = await this._fetchJson(`${KAGGLE_API_BASE}/kernels/push`, {
        method: "POST",
        timeoutMs: 60000,
        body: {
          slug: `${this.creds.username}/${slug}`,
          newTitle: title,
          text,
          language: "python",
          kernelType: "notebook",
          isPrivate: true,
          enableGpu: true,
          enableTpu: false,
          enableInternet: true,
          machineShape: "NvidiaTeslaT4",
          datasetDataSources: datasetSources,
          competitionDataSources: [],
          kernelDataSources: [],
          modelDataSources: [],
          categoryIds: [],
        },
      });
    } catch (e) {
      throw new KaggleError(`连不上 Kaggle API（推送 kernel）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new KaggleError(await kaggleErrorDetail(res.status, res.text), res.status);
    }
    const data = res.data ?? {};
    if (data?.error) {
      throw new KaggleError(`Kaggle 推送 kernel 被拒：${data.error}`);
    }
    return {
      version: data?.versionNumber ?? null,
      ref: data?.ref ?? null,
      url: data?.url ?? null,
      invalidDatasetSources: data?.invalidDatasetSources ?? [],
    };
  }

  /** POST KernelsApiService/GetKernelSessionStatus */
  async kernelStatus(ref) {
    const parts = splitKaggleRef(ref);
    if (!parts) {
      return { state: "unknown", raw: null, failure: null, error: `Kernel 引用格式不对（${ref}），无法查询状态`, notFound: false };
    }
    let res;
    try {
      res = await this._fetchJson(
        `${KAGGLE_API_BASE}/kernels.KernelsApiService/GetKernelSessionStatus`,
        { method: "POST", body: parts, timeoutMs: 30000 },
      );
    } catch (e) {
      return { state: "unknown", raw: null, failure: null, error: `连不上 Kaggle API（查询状态）：${e instanceof Error ? e.message : String(e)}`, notFound: false };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        state: "unknown",
        raw: null,
        failure: null,
        error: await kaggleRpcErrorDetail(res.status, res.text),
        notFound: res.status === 404,
      };
    }
    const data = res.data ?? {};
    return {
      state: normalizeKernelStatus(data?.status ?? ""),
      raw: data?.status || null,
      failure: data?.failureMessage ?? null,
      error: null,
      notFound: false,
    };
  }

  /**
   * 在 kernel 输出列表里找一个文件，返回签名下载 URL。
   * 分页翻到找到为止；单次尝试有时间预算与 60 页上限，翻到哪一页
   * 通过 resumeToken 交给下一次尝试接着翻，不用从头再走。
   */
  async findOutputFile(ref, fileName, { budgetMs = 150000, resumeToken = null, resumeScanned = 0 } = {}) {
    const parts = splitKaggleRef(ref);
    if (!parts) return { ok: false, error: `Kernel 引用格式不对（${ref}），无法查找输出`, resumeToken, scanned: resumeScanned };
    const base = String(fileName).split("/").pop() ?? fileName;
    const deadline = Date.now() + budgetMs;
    let pageToken = resumeToken;
    let scanned = resumeScanned;
    let pages = 0;
    while (true) {
      if (pages > 0 && Date.now() > deadline) {
        return { ok: false, error: `输出列表很长（已扫 ${scanned} 个文件还没翻到 ${fileName}），下一轮会接着上次翻到的位置继续`, resumeToken: pageToken, scanned };
      }
      if (pages >= 60) {
        return { ok: false, error: `输出列表翻了 60 页还没找到 ${fileName}（已扫 ${scanned} 个文件），下一轮会接着翻`, resumeToken: pageToken, scanned };
      }
      let res;
      try {
        res = await this._fetchJson(
          `${KAGGLE_API_BASE}/kernels.KernelsApiService/ListKernelSessionOutput`,
          {
            method: "POST",
            timeoutMs: 60000,
            body: { ...parts, pageToken: pageToken ?? undefined },
          },
        );
      } catch (e) {
        return { ok: false, error: `连不上 Kaggle API（查输出列表）：${e instanceof Error ? e.message : String(e)}`, resumeToken: pageToken, scanned };
      }
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, error: await kaggleRpcErrorDetail(res.status, res.text), resumeToken: pageToken, scanned };
      }
      pages += 1;
      const files = res.data?.files ?? [];
      scanned += files.length;
      for (const f of files) {
        const name = f?.fileName ?? "";
        if (name === fileName || name.split("/").pop() === base) {
          return { ok: true, url: f.url, scanned, resumeToken: null };
        }
      }
      const next = res.data?.nextPageToken ?? null;
      if (!next) {
        return { ok: false, error: `输出列表已翻完，没找到 ${fileName}（共扫 ${scanned} 个文件）`, resumeToken: null, scanned };
      }
      pageToken = next;
    }
  }

  /**
   * 从签名 URL 下载结果 PNG（不带 Authorization）。
   * 校验 PNG 魔数与 8MB 上限；网络/HTTP 失败重试 3 次（2s / 4s 退避），
   * 每次 120s 超时。内容不对（不是 PNG / 超大）不重试，直接报错。
   */
  async downloadPng(url, { attempts = 3 } = {}) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:") {
      throw new KaggleError("Kaggle 给的结果下载地址不是有效的 https 地址");
    }
    let lastError = "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await httpRequest({ url, method: "GET", timeoutMs: 120000, responseType: "arraybuffer" });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`下载结果图时返回 HTTP ${res.status}`);
        }
        const bytes = res.bytes;
        if (!bytes || bytes.length === 0) throw new Error("下载到的结果图是空的");
        if (bytes.length > MAX_PNG_BYTES) {
          throw new KaggleError(`结果图 ${(bytes.length / 1e6).toFixed(1)}MB，超过 8MB 回存上限`);
        }
        if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) {
          throw new KaggleError("下载到的文件不是 PNG（Kaggle 返回的内容不对）");
        }
        return bytes;
      } catch (e) {
        if (e instanceof KaggleError) throw e;
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < attempts - 1) await sleep(attempt === 0 ? 2000 : 4000);
      }
    }
    throw new KaggleError(`下载结果图失败（已重试 ${attempts} 次）：${lastError}`);
  }

  /** 数据集 <owner>/<slug> 里有没有 Moody 模型文件（精确字节数）。true/false/null（null=问不到，不当作没有）。 */
  async datasetHasMoodyFile(ref) {
    let answered = false;
    try {
      const res = await this._fetchJson(`${KAGGLE_API_BASE}/datasets/list/${ref}`, { method: "GET", timeoutMs: 20000 });
      if (res.status === 404) {
        answered = true;
      } else if (res.status >= 200 && res.status < 300) {
        answered = true;
        const data = res.data;
        const files = Array.isArray(data) ? data : (data?.datasetFiles ?? []);
        for (const f of files) {
          if (f?.name === MOODY_MODEL_FILE && (f.totalBytes ?? f.size) === MOODY_MODEL_BYTES) return true;
        }
      }
    } catch {
      // 走第二通道
    }
    const [owner, slug] = String(ref).split("/");
    if (owner && slug) {
      try {
        const res = await this._fetchJson(
          `${KAGGLE_API_BASE}/datasets/list?user=${encodeURIComponent(owner)}&search=${encodeURIComponent(slug)}`,
          { method: "GET", timeoutMs: 20000 },
        );
        if (res.status >= 200 && res.status < 300) {
          answered = true;
          const data = res.data;
          const items = Array.isArray(data) ? data : (data?.datasets ?? []);
          for (const item of items) {
            if (item?.ref?.toLowerCase() === ref.toLowerCase() && item.totalBytes === MOODY_MODEL_BYTES) {
              return true;
            }
          }
        }
      } catch {
        // inconclusive
      }
    }
    return answered ? false : null;
  }

  /** Token 实际归属的账号（kernels/list group=profile 的第一条 ref），5 分钟缓存。 */
  async tokenAccount() {
    const fingerprint = `${this.creds.username}\n${this.creds.key.slice(0, 8)}\n${this.creds.key.slice(-4)}`;
    const now = Date.now();
    if (this._accountCache && this._accountCache.fingerprint === fingerprint && now - this._accountCache.at < 5 * 60 * 1000) {
      return { username: this._accountCache.username, detail: this._accountCache.detail };
    }
    let result;
    try {
      const res = await this._fetchJson(`${KAGGLE_API_BASE}/kernels/list?group=profile&pageSize=5`, { method: "GET", timeoutMs: 15000 });
      if (res.status < 200 || res.status >= 300) {
        result = { username: null, detail: await kaggleErrorDetail(res.status, res.text) };
      } else {
        const data = res.data;
        const items = Array.isArray(data) ? data : (data?.kernels ?? []);
        let owner = null;
        for (const item of items) {
          const ref = normalizeKaggleRef(item?.ref);
          if (ref) {
            owner = ref.split("/")[0] ?? null;
            if (owner) break;
          }
        }
        result = owner
          ? { username: owner, detail: null }
          : { username: null, detail: "这个 Token 名下暂时查不到任何 Kernel，没法确认它归属哪个账号（推送一次后就能确认）。" };
      }
    } catch (e) {
      result = { username: null, detail: `连不上 Kaggle API（查 Token 归属账号）：${e instanceof Error ? e.message : String(e)}` };
    }
    this._accountCache = { fingerprint, at: now, ...result };
    return result;
  }

  /** Token 归属账号的 kernel 列表里有没有这个 ref（true/false/null=问不到）。 */
  async kernelListed(ref) {
    let res;
    try {
      res = await this._fetchJson(`${KAGGLE_API_BASE}/kernels/list?group=profile&pageSize=50`, { method: "GET", timeoutMs: 15000 });
    } catch {
      return null;
    }
    if (res.status < 200 || res.status >= 300) return null;
    const data = res.data;
    const items = Array.isArray(data) ? data : (data?.kernels ?? []);
    for (const item of items) {
      if (normalizeKaggleRef(item?.ref) === ref) return true;
    }
    return false;
  }

  /** 双通道确认 kernel 存在：状态接口 + Token 账号的 kernel 列表。 */
  async confirmKernelExists(ref) {
    const st = await this.kernelStatus(ref);
    if (!st.error && st.state !== "unknown") {
      return { exists: true, state: st.state, viaList: false, authError: null, detail: `状态接口已应答（状态 ${st.state}）` };
    }
    if (!st.error) {
      const listed = await this.kernelListed(ref);
      if (listed === true) {
        return { exists: true, state: null, viaList: true, authError: null, detail: "Token 归属账号的 Kernel 列表里已有这个 Kernel（状态接口返回了本站不认识的状态值）" };
      }
      return {
        exists: false, state: null, viaList: false, authError: null,
        detail: `状态接口返回了本站不认识的状态值${st.raw ? `「${st.raw}」` : ""}；${listed === false ? "Token 归属账号的 Kernel 列表里也没有它" : "Kernel 列表这次没读到（无法确认）"}`,
      };
    }
    if (st.error.includes("401")) {
      return { exists: false, state: null, viaList: false, authError: st.error, detail: st.error };
    }
    const listed = await this.kernelListed(ref);
    if (listed === true) {
      return { exists: true, state: null, viaList: true, authError: null, detail: "Token 归属账号的 Kernel 列表里已有这个 Kernel（kernels/status 还没跟上）" };
    }
    const statusPart = st.notFound ? `kernels/status 对 ${ref} 返回 404` : `kernels/status 查不到（${st.error}）`;
    const listPart = listed === false ? "Token 归属账号的 Kernel 列表里也没有它" : "Kernel 列表这次没读到（无法确认）";
    return { exists: false, state: null, viaList: false, authError: null, detail: `${statusPart}；${listPart}` };
  }

  /**
   * MOSS 推送前必须确认的数据集：先试 Token 归属账号，再试设置里的用户名。
   * @returns {{ref:string|null, conclusive:boolean}}
   */
  async resolveMoodyDatasetRef() {
    const account = await this.tokenAccount();
    const owners = [];
    for (const o of [account.username, this.creds.username]) {
      const t = o?.trim();
      if (t && !owners.some((x) => x.toLowerCase() === t.toLowerCase())) owners.push(t);
    }
    let conclusive = false;
    for (const owner of owners) {
      const ref = `${owner}/${MOODY_DATASET_SLUG}`;
      const has = await this.datasetHasMoodyFile(ref);
      if (has === true) return { ref, conclusive: true };
      if (has === false) conclusive = true;
    }
    return { ref: null, conclusive };
  }
}

/** 把 PNG 字节转 base64（给 Filesystem.writeFile 用）。 */
export function pngBytesToBase64(bytes) {
  return bytesToBase64(bytes);
}
