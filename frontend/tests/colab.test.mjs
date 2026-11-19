// tests/colab.test.mjs — Colab 中转客户端测试：提交/轮询/下载、401 翻译、
// 魔数校验、超大图拒绝、404 不重试。跑法：npm test。
// fetch 桩模拟 Cloudflare Worker colab-relay。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ColabClient, ColabError, COLAB_RELAY_BASE } from "../src/lib/colab.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 1, 2, 3,
]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function jsonRes(status, obj) {
  const text = JSON.stringify(obj);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

function bytesRes(status, bytes) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/octet-stream" },
    text: async () => "",
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

// 可编程的中转行为（每个测试按需改）
const fake = {
  submit: "ok", // "ok" | "401" | "503-nokey" | "400" | "down"
  job: { id: "cb-test-1", status: "running", progress: 40, stage: "生成中" },
  jobStatus: 200,
  webp: "ok", // "ok" | "404" | "png-content"
  png: "ok", // "ok" | "404" | "webp-content"
  calls: [],
};

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = opts?.method || "GET";
  fake.calls.push({ url: u, method, headers: opts?.headers || {}, body: opts?.body });
  if (u === `${COLAB_RELAY_BASE}/job` && method === "POST") {
    if (fake.submit === "down") throw new TypeError("fetch failed");
    if (fake.submit === "401") return jsonRes(401, { ok: false, error: "unauthorized" });
    if (fake.submit === "503-nokey") return jsonRes(503, { ok: false, error: "relay key not configured" });
    if (fake.submit === "400") return jsonRes(400, { ok: false, error: "model not supported" });
    return jsonRes(200, { ok: true, job_id: "cb-test-1" });
  }
  if (u === `${COLAB_RELAY_BASE}/job/cb-test-1` && method === "GET") {
    if (fake.jobStatus === 404) return jsonRes(404, { ok: false, error: "not found" });
    return jsonRes(200, { ok: true, job: fake.job });
  }
  if (u === `${COLAB_RELAY_BASE}/job/cb-test-1/webp`) {
    if (fake.webp === "404") return jsonRes(404, { ok: false, error: "not ready" });
    if (fake.webp === "png-content") return bytesRes(200, PNG_BYTES);
    return bytesRes(200, WEBP_BYTES);
  }
  if (u === `${COLAB_RELAY_BASE}/job/cb-test-1/png`) {
    if (fake.png === "404") return jsonRes(404, { ok: false, error: "not ready" });
    if (fake.png === "webp-content") return bytesRes(200, WEBP_BYTES);
    return bytesRes(200, PNG_BYTES);
  }
  throw new Error(`测试桩没预料到的请求：${method} ${u}`);
};

function resetFake() {
  fake.submit = "ok";
  fake.job = { id: "cb-test-1", status: "running", progress: 40, stage: "生成中" };
  fake.jobStatus = 200;
  fake.webp = "ok";
  fake.png = "ok";
  fake.calls = [];
}

test("submitJob：POST /job，带 X-Colab-Key 与提交字段", async () => {
  resetFake();
  const client = new ColabClient({ key: "test-relay-key" });
  const { jobId } = await client.submitJob({
    model: "qwen",
    prompt: "a cat",
    ratioKey: "auto",
    seed: 42,
    useUpscale: true,
  });
  assert.equal(jobId, "cb-test-1");
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.url, `${COLAB_RELAY_BASE}/job`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["X-Colab-Key"], "test-relay-key");
  assert.match(call.headers["content-type"], /application\/json/);
  const body = JSON.parse(call.body);
  assert.equal(body.model, "qwen");
  assert.equal(body.prompt, "a cat");
  assert.equal(body.ratioKey, "auto");
  assert.equal(body.seed, 42);
  assert.equal(body.useUpscale, true);
  assert.equal(body.source, "app");
});

test("submitJob 401：翻成人话，告诉用户去设置里核对密钥", async () => {
  resetFake();
  fake.submit = "401";
  const client = new ColabClient({ key: "wrong-key" });
  await assert.rejects(client.submitJob({ model: "qwen", prompt: "x" }), (e) => {
    assert.ok(e instanceof ColabError);
    assert.equal(e.status, 401);
    assert.match(e.message, /中转密钥不对/);
    assert.match(e.message, /设置/);
    return true;
  });
});

test("submitJob 503（Worker 没配密钥）：翻成人话", async () => {
  resetFake();
  fake.submit = "503-nokey";
  const client = new ColabClient({ key: "test-relay-key" });
  await assert.rejects(client.submitJob({ model: "qwen", prompt: "x" }), (e) => {
    assert.ok(e instanceof ColabError);
    assert.equal(e.status, 503);
    assert.match(e.message, /Worker 上没有 RELAY_KEY/);
    return true;
  });
});

test("submitJob 400：带上中转的原错", async () => {
  resetFake();
  fake.submit = "400";
  const client = new ColabClient({ key: "test-relay-key" });
  await assert.rejects(client.submitJob({ model: "qwen", prompt: "x" }), (e) => {
    assert.ok(e instanceof ColabError);
    assert.equal(e.status, 400);
    assert.match(e.message, /model not supported/);
    return true;
  });
});

test("submitJob 断网：ColabError，不判成 401", async () => {
  resetFake();
  fake.submit = "down";
  const client = new ColabClient({ key: "test-relay-key" });
  await assert.rejects(client.submitJob({ model: "qwen", prompt: "x" }), (e) => {
    assert.ok(e instanceof ColabError);
    assert.match(e.message, /连不上 Colab 中转/);
    return true;
  });
});

test("getJob：返回中转的 job 行原样", async () => {
  resetFake();
  const client = new ColabClient({ key: "test-relay-key" });
  const job = await client.getJob("cb-test-1");
  assert.equal(job.status, "running");
  assert.equal(job.progress, 40);
  assert.equal(job.stage, "生成中");
  assert.equal(fake.calls[0].headers["X-Colab-Key"], "test-relay-key");
});

test("getJob 404：ColabError 404", async () => {
  resetFake();
  fake.jobStatus = 404;
  const client = new ColabClient({ key: "test-relay-key" });
  await assert.rejects(client.getJob("cb-test-1"), (e) => {
    assert.ok(e instanceof ColabError);
    assert.equal(e.status, 404);
    assert.match(e.message, /找不到这单任务/);
    return true;
  });
});

test("downloadImage webp：魔数对了才返回字节", async () => {
  resetFake();
  const client = new ColabClient({ key: "test-relay-key" });
  const bytes = await client.downloadImage("cb-test-1", "webp");
  assert.deepEqual([...bytes], [...WEBP_BYTES]);
  assert.equal(fake.calls[0].url, `${COLAB_RELAY_BASE}/job/cb-test-1/webp`);
});

test("downloadImage webp：内容是 PNG 就报错", async () => {
  resetFake();
  fake.webp = "png-content";
  const client = new ColabClient({ key: "test-relay-key" });
  await assert.rejects(client.downloadImage("cb-test-1", "webp"), /不是 WebP/);
});

test("downloadImage png：内容是 WebP 就报错", async () => {
  resetFake();
  fake.png = "webp-content";
  const client = new ColabClient({ key: "test-relay-key" });
  await assert.rejects(client.downloadImage("cb-test-1", "png"), /不是 PNG/);
});

test("downloadImage 404：ColabError 404，且只请求一次（不重试）", async () => {
  resetFake();
  fake.webp = "404";
  const client = new ColabClient({ key: "test-relay-key" });
  await assert.rejects(client.downloadImage("cb-test-1", "webp"), (e) => {
    assert.ok(e instanceof ColabError);
    assert.equal(e.status, 404);
    return true;
  });
  assert.equal(fake.calls.length, 1);
});

test("downloadImage 超 20MB：拒绝", async () => {
  resetFake();
  // 21MB 的“图”：魔数对、但超上限
  const big = new Uint8Array(21 * 1024 * 1024);
  big.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const client = new ColabClient({ key: "test-relay-key" });
  const realFetchNow = globalThis.fetch;
  globalThis.fetch = async () => bytesRes(200, big);
  try {
    await assert.rejects(client.downloadImage("cb-test-1", "webp"), /太大/);
  } finally {
    globalThis.fetch = realFetchNow;
  }
});
