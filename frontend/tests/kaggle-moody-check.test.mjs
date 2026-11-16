// tests/kaggle-moody-check.test.mjs — Moody 模型数据集核查重试测试：
// Kaggle 接口偶尔抽风回 404/空列表，单次回答当铁证会把好好的任务误杀
// （2026-11-16 用户实测：数据集和文件明明都在，App 却报“找不到完整模型文件”）。
// 修法：查到“没有”时等一会再问一次才下结论。
// 跑法：npm test。fetch 桩按脚本应答，retryDelayMs 传 0 让测试不真等。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { KaggleClient, MOODY_MODEL_BYTES, MOODY_MODEL_FILE } from "../src/lib/kaggle.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

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

const FILE_ENTRY = { name: MOODY_MODEL_FILE, totalBytes: MOODY_MODEL_BYTES };
const REF = "kitzhang2019/moody-moss-mix-v33";

// 按脚本应答的 fetch 桩：每次调用从 queue 头取一个响应（函数或固定响应）。
function installFetch(queue, calls) {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const next = queue.shift();
    if (next === undefined) throw new Error(`测试桩没预料到的请求：${url}`);
    if (typeof next === "function") return next();
    return next;
  };
}

function client() {
  return new KaggleClient({ username: "kitzhang2019", key: "KGAT_fake-test-key" });
}

test("第一次 404、第二次找到：返回 true（抽风自愈）", async () => {
  const calls = [];
  installFetch(
    [
      jsonRes(404, { error: "not found" }), // 第一次：通道 1（文件列表）404
      jsonRes(200, { datasets: [] }), // 第一次：通道 2（搜索）空列表
      jsonRes(200, { datasetFiles: [FILE_ENTRY] }), // 第二次：通道 1 找到文件
    ],
    calls,
  );
  const got = await client().datasetHasMoodyFile(REF, { retryDelayMs: 0 });
  assert.equal(got, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((u) => u.includes("datasets/list")));
});

test("两次都 404：返回 false（真没有，两次确认）", async () => {
  const calls = [];
  installFetch(
    [
      jsonRes(404, { error: "not found" }),
      jsonRes(200, { datasets: [] }),
      jsonRes(404, { error: "not found" }),
      jsonRes(200, { datasets: [] }),
    ],
    calls,
  );
  const got = await client().datasetHasMoodyFile(REF, { retryDelayMs: 0 });
  assert.equal(got, false);
  assert.equal(calls.length, 4);
});

test("第一次 404、第二次问不到：返回 null（不当死刑，走软路）", async () => {
  const calls = [];
  installFetch(
    [
      jsonRes(404, { error: "not found" }),
      jsonRes(200, { datasets: [] }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    calls,
  );
  const got = await client().datasetHasMoodyFile(REF, { retryDelayMs: 0 });
  assert.equal(got, null);
  assert.equal(calls.length, 4);
});

test("第一次就找到：返回 true，不重试", async () => {
  const calls = [];
  installFetch([jsonRes(200, { datasetFiles: [FILE_ENTRY] })], calls);
  const got = await client().datasetHasMoodyFile(REF, { retryDelayMs: 0 });
  assert.equal(got, true);
  assert.equal(calls.length, 1);
});
