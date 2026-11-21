// kaggle.js — v3.0 起只剩传输层与图片工具。
// 手机不再直连 Kaggle API：Kaggle 任务也走 Colab 中转（见 colab.js），
// 守护进程在服务器上代劳提交/盯状态/取图，手机只提交、轮询、取备好的图。
// 这里留下的都是还被用到的导出：httpRequest（Colab 中转也走它）、
// MAX_IMAGE_BYTES（下载上限）、pngDimensions（画廊补原图时验尺寸）。
// 其余 KaggleClient 相关（pushKernel / kernelStatus / listOutputFiles /
// findResultImage / downloadPng / downloadWebp / confirmKernelExists /
// deleteKernel / resolveMoodyDatasetRef 等）已随直连整条路删掉。

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { base64ToBytes } from "./notebook.js";

// 浏览器 UA：中转域名所在 zone 开了 Cloudflare Browser Integrity Check，
// App 原生请求默认的 CFNetwork UA 会被当成非浏览器流量拦下；改发桌面
// Chrome UA（与中转上游同款），让请求看起来像浏览器流量。
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 读 PNG 的 IHDR 尺寸（宽在偏移 16、高在偏移 20，大端 uint32）。
 * 不是 PNG、太短、或 IHDR 标记不对时返回 null（调用方按“尺寸读不到”处理，
 * 不贴图）。 */
export function pngDimensions(bytes) {
  if (!bytes || bytes.length < 24) return null;
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
  // IHDR 标记在偏移 12–15（"IHDR"）
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 回存图片上限 20MB（用户规则：生成图 <20MB；PNG 和 WebP 共用；2560×3840 的 PNG 约 12MB，8MB 装不下）

/**
 * 统一 HTTP 请求。
 * @returns {{status:number, data:any, text:string, bytes:Uint8Array|null}}
 * data：JSON 响应时为解析后的对象；text 为原始文本；bytes 仅 responseType
 * 为 arraybuffer 时有值。CapacitorHttp 在真机与浏览器里都会把 arraybuffer
 * 响应以 base64 字符串放在 data 里，这里统一解回 Uint8Array。
 * Colab 中转也走它（见 colab.js），所以导出。
 */
export async function httpRequest({ url, method = "GET", headers = {}, body = null, timeoutMs = 30000, responseType = "text" }) {
  const isNative = Capacitor.isNativePlatform();
  if (isNative) {
    const res = await CapacitorHttp.request({
      url,
      method,
      // 原生请求改发浏览器 UA（见 BROWSER_USER_AGENT）：中转域名开了
      // Cloudflare Browser Integrity Check，CFNetwork UA 会被拦。
      headers: { ...headers, "User-Agent": BROWSER_USER_AGENT },
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
  // 桌面浏览器回退：普通 fetch。
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
