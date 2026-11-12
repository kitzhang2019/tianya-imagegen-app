// gallery.js — 把完成的生图推到天涯画廊（upload.php，multipart POST）。
// 只推真实完成的生图，绝不推测试图；推送失败只记在任务上，绝不让任务失败。
//
// 传输说明（按装好的 @capacitor/core 8.6.0 实测源码）：
// - 真机：CapacitorHttp.request 不能直接传 FormData/Blob 对象过桥（桥只传
//   字符串或 JSON），但原生 iOS/Android 都支持 dataType:'formData' + 条目
//   数组 {type:'string'|'base64File', key, value, fileName?, contentType?}
//   （见 node_modules/@capacitor/core/types/definitions-internal.d.ts 的
//   CapFormDataEntry，以及 iOS CapacitorUrlRequest.getRequestDataFromFormData
//   / Android CapacitorHttpUrlConnection.writeFormDataRequestBody），图片
//   以 base64 传过去由原生端解码拼 multipart。走的就是这条路。
// - 桌面浏览器：CapacitorHttp 的 web 实现走 fetch，改用真实 FormData +
//   fetch；但 upload.php 不发 CORS 头，桌面浏览器会被跨域拦住——这是
//   桌面调试的限制，真机（原生 HTTP，不走 CORS）不受影响。

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { bytesToBase64 } from "./notebook.js";

export const DEFAULT_GALLERY_URL =
  "https://tianya-gallery-bizen7j8-workspace-krgsbt.cloady.io/upload.php";

export const GALLERY_MODEL_LABELS = {
  moss: "MOSS-Image",
  qwen: "Qwen Image 2.1",
  krea2: "Krea2",
  zimage: "Z-Image",
};

/**
 * @param {{url:string, key:string, job:{model:string, prompt:string, seed:number, width:number, height:number, createdAt:number}, pngBytes:Uint8Array, fileName:string}} args
 * @returns {Promise<{ok:boolean, error:string|null}>}
 */
export async function pushToGallery({ url, key, job, pngBytes, fileName }) {
  if (!key) return { ok: false, error: "画廊推送密钥未配置" };
  if (!pngBytes || pngBytes.length === 0) return { ok: false, error: "没有图片数据" };
  const endpoint = (url || "").trim() || DEFAULT_GALLERY_URL;
  const modelLabel = GALLERY_MODEL_LABELS[job.model] ?? "MOSS-Image";
  const fields = {
    key,
    prompt: job.prompt,
    model: modelLabel,
    seed: job.seed != null ? String(job.seed) : "",
    width: String(job.width),
    height: String(job.height),
    created_at: new Date(job.createdAt).toISOString(),
  };

  try {
    if (Capacitor.isNativePlatform()) {
      // 原生 formData 条目数组：字符串字段 + base64 图片文件
      const entries = Object.entries(fields).map(([k, v]) => ({ type: "string", key: k, value: v }));
      entries.push({
        type: "base64File",
        key: "image",
        value: bytesToBase64(pngBytes),
        fileName,
        contentType: "image/png",
      });
      const res = await CapacitorHttp.request({
        url: endpoint,
        method: "POST",
        data: entries,
        dataType: "formData",
        connectTimeout: 15000,
        readTimeout: 60000,
        responseType: "json",
      });
      const data = res.data ?? {};
      if (res.status >= 200 && res.status < 300 && data?.ok === true) {
        return { ok: true, error: null };
      }
      return { ok: false, error: data?.error ?? `画廊返回异常（HTTP ${res.status}）` };
    }

    // 桌面浏览器：真实 FormData + fetch（需服务端放行 CORS 才能通）
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("image", new Blob([pngBytes], { type: "image/png" }), fileName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(endpoint, { method: "POST", body: form, signal: controller.signal });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok === true) return { ok: true, error: null };
      return { ok: false, error: data?.error ?? `画廊返回异常（HTTP ${res.status}）` };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
