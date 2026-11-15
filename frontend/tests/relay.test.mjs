// tests/relay.test.mjs — 中转测试：全部 Kaggle 流量走 Cloudflare 中转
// https://kaggle.tianyagk.dpdns.org，不再直连 kaggle.com / kaggleusercontent。
// 跑法：npm test。fetch 桩记录实际请求的 URL，断言 API 与下载都落在中转上。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  KAGGLE_API_BASE,
  KAGGLE_RELAY_BASE,
  KaggleClient,
  relayDownloadUrl,
} from "../src/lib/kaggle.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function pngRes(status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "image/png" },
    text: async () => "",
    arrayBuffer: async () => PNG_BYTES.buffer.slice(0),
  };
}

function jsonRes(status, obj) {
  const text = JSON.stringify(obj);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) =>
        String(name).toLowerCase() === "content-type" ? "application/json" : null,
    },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

test("KAGGLE_API_BASE 是中转地址，不再是 www.kaggle.com", () => {
  assert.equal(KAGGLE_RELAY_BASE, "https://kaggle.tianyagk.dpdns.org");
  assert.equal(KAGGLE_API_BASE, "https://kaggle.tianyagk.dpdns.org/api/v1");
  assert.ok(!KAGGLE_API_BASE.includes("www.kaggle.com"));
});

test("relayDownloadUrl：kaggleusercontent 子域名改写成中转 /dl?url=", () => {
  const original =
    "https://www.kaggleusercontent.com/abc123/output.png?x=1&y=2";
  const rewritten = relayDownloadUrl(original);
  assert.equal(
    rewritten,
    `https://kaggle.tianyagk.dpdns.org/dl?url=${encodeURIComponent(original)}`,
  );
  const back = new URL(rewritten).searchParams.get("url");
  assert.equal(back, original);
});

test("relayDownloadUrl：storage.googleapis.com 改写成中转 /dl?url=", () => {
  const original =
    "https://storage.googleapis.com/kaggle-output/xyz/result.png";
  assert.equal(
    relayDownloadUrl(original),
    `https://kaggle.tianyagk.dpdns.org/dl?url=${encodeURIComponent(original)}`,
  );
});

test("relayDownloadUrl：不在白名单的 host 保持直连", () => {
  const original = "https://example.com/files/result.png";
  assert.equal(relayDownloadUrl(original), original);
  assert.equal(relayDownloadUrl("not-a-url"), "not-a-url");
});

test("downloadPng：kaggleusercontent 地址实际请求走中转", async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return pngRes(200);
  };
  const client = new KaggleClient({ username: "u", key: "t" });
  const original =
    "https://www.kaggleusercontent.com/abc123/output.png?token=zzz";
  const bytes = await client.downloadPng(original);
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0],
    `https://kaggle.tianyagk.dpdns.org/dl?url=${encodeURIComponent(original)}`,
  );
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("downloadPng：非白名单 host 实际请求保持直连", async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return pngRes(200);
  };
  const client = new KaggleClient({ username: "u", key: "t" });
  const original = "https://example.com/files/result.png";
  await client.downloadPng(original);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], original);
});

test("pushKernel：提交 POST 到中转 /kernels/push，Authorization 原样带上", async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), opts });
    return jsonRes(200, {
      ref: "u/app-qwen-comfyui-kaggle-1",
      versionNumber: 1,
      url: "https://www.kaggle.com/code/u/app-qwen-comfyui-kaggle-1",
    });
  };
  const client = new KaggleClient({ username: "u", key: "KGAT-abcdef" });
  const res = await client.pushKernel({
    slug: "app-qwen-comfyui-kaggle-1",
    title: "relay test",
    text: "print(1)",
  });
  assert.equal(res.ref, "u/app-qwen-comfyui-kaggle-1");
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    "https://kaggle.tianyagk.dpdns.org/api/v1/kernels/push",
  );
  assert.equal(seen[0].opts.headers.Authorization, "Bearer KGAT-abcdef");
});
