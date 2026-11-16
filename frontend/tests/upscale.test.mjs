// tests/upscale.test.mjs — 超分开关的单元测试（纯函数 + 画廊字段）。
// 跑法：npm test（node --import ./tests/register.mjs --test tests/）。
// 覆盖：开关归一化、数据集挂载、patchNotebook 开/关（四个真实模板）、
// 宽高与 upscaler 字段、画廊推送字段；jobs.js 的重提/老任务兼容在
// jobs-upscale.test.mjs 里测。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MOSS_SIZES,
  SEEDVR_DATASET,
  collectDatasetSources,
  normalizeUseUpscale,
  outputSizeForJob,
  patchNotebook,
  ratioOptionLabel,
  resolveSize,
  upscalerLabelForJob,
  upscaleOffSize,
} from "../src/lib/notebook.js";
import { pushToGallery } from "../src/lib/gallery.js";

const MODELS = ["moss", "qwen", "krea2", "zimage"];
// 各模型一张 2:3/3:4 竖版尺寸（与 resolveSize 的表一致）。
const SIZES = {
  moss: { width: 1696, height: 2256 },
  qwen: { width: 1888, height: 2496 },
  krea2: { width: 1760, height: 2624 },
  zimage: { width: 1760, height: 2624 },
};
const PREFIX = { moss: "moss_dash", qwen: "qwen_dash", krea2: "krea2_dash", zimage: "zimage_dash" };

function loadTemplate(model) {
  return readFileSync(new URL(`../public/notebooks/${model}-comfyui-kaggle.ipynb`, import.meta.url), "utf-8");
}

function patched(model, opts = {}) {
  const { text, notebook } = patchNotebook(loadTemplate(model), {
    model,
    prompt: "a portrait in the woods, soft light",
    width: SIZES[model].width,
    height: SIZES[model].height,
    seed: 12345,
    jobId: 7,
    ...opts,
  });
  const cells = notebook.cells;
  const cellText = (c) => (typeof c.source === "string" ? c.source : c.source.join(""));
  return { text, run: cellText(cells[4]), disp: cellText(cells[5]), dl: cellText(cells[3]) };
}

test("normalizeUseUpscale：只有明确 false 才关，老任务（undefined/null）按开处理", () => {
  assert.equal(normalizeUseUpscale(undefined), true);
  assert.equal(normalizeUseUpscale(null), true);
  assert.equal(normalizeUseUpscale(true), true);
  assert.equal(normalizeUseUpscale(false), false);
});

test("upscaleOffSize：底图 = 最终尺寸一半、取整到 16；2048x3072 的底图就是 1024x1536", () => {
  assert.deepEqual(upscaleOffSize(2048, 3072), { width: 1024, height: 1536 });
  assert.deepEqual(upscaleOffSize(1696, 2256), { width: 848, height: 1136 }); // 1128 不是 16 的倍数，round16 向上取到 1136
  assert.deepEqual(upscaleOffSize(1888, 2496), { width: 944, height: 1248 });
});

test("outputSizeForJob / upscalerLabelForJob：开=任务尺寸/SeedVR 7B，关=底图尺寸/无，老任务按开", () => {
  const base = { model: "moss", width: 1696, height: 2256 };
  assert.deepEqual(outputSizeForJob({ ...base, useUpscale: true }), { width: 1696, height: 2256 });
  assert.equal(upscalerLabelForJob({ ...base, useUpscale: true }), "SeedVR 7B");
  assert.deepEqual(outputSizeForJob({ ...base, useUpscale: false }), { width: 848, height: 1136 });
  assert.equal(upscalerLabelForJob({ ...base, useUpscale: false }), "无");
  assert.deepEqual(outputSizeForJob(base), { width: 1696, height: 2256 });
  assert.equal(upscalerLabelForJob(base), "SeedVR 7B");
});

test("collectDatasetSources：开超分挂 seedvr2-7b，关不挂；主模型与 LoRA 数据集照原逻辑", () => {
  // MOSS：Moody + Blender3D（选中才挂）+ SeedVR（开才挂）；观澜走 HF，不挂数据集
  assert.deepEqual(
    collectDatasetSources({ model: "moss", loraKeys: ["guanlan"], useUpscale: true, moodyRef: "kitzhang2019/moody-moss-mix-v33" }),
    ["kitzhang2019/moody-moss-mix-v33", SEEDVR_DATASET],
  );
  assert.deepEqual(
    collectDatasetSources({ model: "moss", loraKeys: ["guanlan", "blender3d"], useUpscale: false, moodyRef: "kitzhang2019/moody-moss-mix-v33" }),
    ["kitzhang2019/moody-moss-mix-v33", "kitzhang2019/moss-blender3d-lora-v2"],
  );
  // Krea2：Ray 必挂，HerRAW 只在带 LoRA 时挂，SeedVR 只在开时挂
  assert.deepEqual(
    collectDatasetSources({ model: "krea2", useLora: true, useUpscale: true }),
    ["kitzhang2019/ray-artshoot-krea2-v5-nvfp4", "kitzhang2019/herraw-sensual-krea2", SEEDVR_DATASET],
  );
  assert.deepEqual(
    collectDatasetSources({ model: "krea2", useLora: false, useUpscale: false }),
    ["kitzhang2019/ray-artshoot-krea2-v5-nvfp4"],
  );
  // Z-Image：主模型必挂，LoRA 按选择挂，SeedVR 只在开时挂
  assert.deepEqual(
    collectDatasetSources({ model: "zimage", loraKeys: ["herraw", "ostris"], useUpscale: true }),
    ["kitzhang2019/pornmaster-zimage-v35-fp8", "kitzhang2019/herraw-zimage-v02", "kitzhang2019/ostris-zimage-turbo-adapter-v2", SEEDVR_DATASET],
  );
  // Qwen：没有主模型/LoRA 数据集，开只挂 SeedVR，关一个都不挂
  assert.deepEqual(collectDatasetSources({ model: "qwen", useUpscale: true }), [SEEDVR_DATASET]);
  assert.deepEqual(collectDatasetSources({ model: "qwen", useUpscale: false }), []);
  assert.deepEqual(collectDatasetSources({ model: "qwen" }), [SEEDVR_DATASET]);
});

for (const model of MODELS) {
  test(`patchNotebook 开（默认）：${model} 保持两段式，种子与前后缀都换成任务值`, () => {
    const { run, disp, dl } = patched(model);
    assert.ok(run.includes("SeedVR2VideoUpscaler"), "应保留 SeedVR 放大节点");
    assert.ok(run.includes("nodes_seedvr"), "应保留 SeedVR 节点定义");
    assert.ok(!run.includes('"seed": 42'), "种子 42 应全换成任务种子");
    assert.ok(run.includes('"seed": 12345') || run.includes('"noise_seed": 12345'), "任务种子应写进采样器");
    assert.ok(run.includes(`"filename_prefix": "${PREFIX[model]}_7"`), "成品前缀应是任务前缀");
    assert.ok(run.includes(`/kaggle/working/${PREFIX[model]}_7.webp`), "WebP 应是任务前缀");
    assert.ok(disp.includes(`/kaggle/working/${PREFIX[model]}_7.png`), "展示格应指任务前缀 PNG");
    assert.ok(dl.includes("seedvr2-7b"), "下载格应保留 SeedVR 软链");
  });

  test(`patchNotebook 开（显式 true 与默认一致）：${model}`, () => {
    const a = patched(model);
    const b = patched(model, { useUpscale: true });
    assert.equal(a.text, b.text);
  });

  test(`patchNotebook 关：${model} 切掉 SeedVR 段，底图直接当成品`, () => {
    const { run, disp, dl } = patched(model, { useUpscale: false });
    assert.ok(!run.includes("nodes_seedvr"), "出图格不应再有 SeedVR 节点定义");
    // 注意：出图格开头的 need 预检列表里仍写着 SeedVR 节点名（只查“节点类型
    // 在不在”，插件照常安装，不影响）；断言的是放大节点定义本身已切掉。
    assert.ok(!run.includes('"class_type": "SeedVR2VideoUpscaler"'), "出图格不应再有 SeedVR 放大节点定义");
    assert.ok(!run.includes("DIT_MODEL"), "出图格不应再有 SeedVR 模型断言");
    assert.ok(!run.includes("sv_ok"), "出图格不应再有 Phase 2 提交");
    assert.ok(!run.includes('"resolution": 2048'), "出图格不应再有 SeedVR resolution");
    assert.ok(!run.includes(`${model}_lowres`), "低分中间名不应再出现（已改成任务前缀）");
    assert.ok(!dl.includes("seedvr2-7b"), "下载格不应再有 SeedVR 软链（数据集没挂）");
    assert.ok(!dl.includes("SEEDVR_DIT"), "下载格不应再有 SeedVR 文件名");
    // 底图直接当成品：phase 1 的 SaveImage 与 GEN 落盘路径都是任务前缀
    assert.ok(run.includes(`"filename_prefix": "${PREFIX[model]}_7"`), "phase 1 SaveImage 应直接用任务前缀");
    assert.ok(run.includes(`/kaggle/working/${PREFIX[model]}_7.png`), "GEN 落盘路径应是任务前缀 PNG");
    // WebP 仍从这张底图 PNG 出精细版，展示格也指它
    assert.ok(run.includes(`webp_fine("/kaggle/working/${PREFIX[model]}_7.png", "/kaggle/working/${PREFIX[model]}_7.webp")`), "WebP 应从任务前缀底图出");
    assert.ok(disp.includes(`/kaggle/working/${PREFIX[model]}_7.png`), "展示格应指任务前缀 PNG");
    // RESULT 打印里的 sv_s 不存在，改成 0；底图尺寸与任务种子仍对
    assert.ok(run.includes("seedvr_s=0"), "RESULT 打印的 seedvr_s 应为 0");
    assert.ok(!run.includes("sv_s"), "RESULT 打印不应再引用 sv_s");
    assert.ok(!run.includes('"seed": 42'), "种子 42 应全换成任务种子");
    assert.ok(run.includes('"seed": 12345') || run.includes('"noise_seed": 12345'), "任务种子应写进采样器");
  });
}

test("patchNotebook 关 + LoRA：LoRA 逻辑不受超分开关影响", () => {
  const moss = patched("moss", { useUpscale: false, loraKeys: ["guanlan", "blender3d"] });
  assert.ok(moss.dl.includes('LORA_NAMES = [MOSS_LORAS[k] for k in ("guanlan", "blender3d")]'), "MOSS 双 LoRA 选择应保留");
  assert.ok(!moss.run.includes("nodes_seedvr"), "关超分仍应切掉 SeedVR");
  const krea2 = patched("krea2", { useUpscale: false, useLora: false });
  assert.ok(krea2.dl.includes('LORA_NAME = ""'), "Krea2 不带 LoRA 应清空 LORA_NAME");
  assert.ok(!krea2.run.includes("nodes_seedvr"), "关超分仍应切掉 SeedVR");
  const zimage = patched("zimage", { useUpscale: false, loraKeys: ["yaoguang"] });
  assert.ok(zimage.dl.includes('LORA_NAMES = [ZIMAGE_LORAS[k] for k in ("yaoguang",)]'), "Z-Image 单选 LoRA 应保留（单元素元组带尾逗号）");
  assert.ok(!zimage.run.includes("nodes_seedvr"), "关超分仍应切掉 SeedVR");
});

test("patchNotebook 守卫：模板不是 SeedVR 接线版时抛错（开与关都一样）", () => {
  for (const model of MODELS) {
    const broken = loadTemplate(model).replaceAll("SeedVR2VideoUpscaler", "NoSuchNode");
    const opts = { model, prompt: "x", width: 1024, height: 1536, seed: 1, jobId: 1 };
    assert.throws(() => patchNotebook(broken, opts), /不是 SeedVR 版/);
    assert.throws(() => patchNotebook(broken, { ...opts, useUpscale: false }), /不是 SeedVR 版/);
  }
});

// --- 画廊推送字段（桌面分支：fetch + FormData，抓 body 验字段） ---
function stubFetchCapture() {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = opts.body;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  return () => captured;
}

test("pushToGallery：开超分写任务尺寸 + SeedVR 7B；关写底图尺寸 + 无；老任务按开", async () => {
  const getBody = stubFetchCapture();
  const base = { model: "moss", prompt: "p", seed: 5, width: 1696, height: 2256, createdAt: 1700000000000, loraKeys: ["guanlan"] };
  let res = await pushToGallery({ url: "https://x/upload.php", key: "k", job: { ...base, useUpscale: true }, imageBytes: new Uint8Array([1]), fileName: "a.png" });
  assert.equal(res.ok, true);
  let body = getBody();
  assert.equal(body.get("width"), "1696");
  assert.equal(body.get("height"), "2256");
  assert.equal(body.get("upscaler"), "SeedVR 7B");
  assert.equal(body.get("lora"), "观澜 LoRA 0.8");

  res = await pushToGallery({ url: "https://x/upload.php", key: "k", job: { ...base, useUpscale: false }, imageBytes: new Uint8Array([1]), fileName: "a.png" });
  assert.equal(res.ok, true);
  body = getBody();
  assert.equal(body.get("width"), "848");
  assert.equal(body.get("height"), "1136");
  assert.equal(body.get("upscaler"), "无");

  res = await pushToGallery({ url: "https://x/upload.php", key: "k", job: base, imageBytes: new Uint8Array([1]), fileName: "a.png" });
  assert.equal(res.ok, true);
  body = getBody();
  assert.equal(body.get("width"), "1696");
  assert.equal(body.get("height"), "2256");
  assert.equal(body.get("upscaler"), "SeedVR 7B");
});

// 画廊推送改推 WebP（v1.2.12）：2560×3840 的 PNG 约 12MB 超过画廊 10MB 上传上限
// （实测 12MB 推画廊回 502），同名 WebP 只有约 1.25MB。contentType 跟着文件名走。
test("pushToGallery：传 contentType=image/webp 时图片以 WebP 类型发出；默认仍是 PNG", async () => {
  const getBody = stubFetchCapture();
  const base = { model: "moss", prompt: "p", seed: 5, width: 2560, height: 3840, createdAt: 1700000000000, loraKeys: ["guanlan"] };
  let res = await pushToGallery({ url: "https://x/upload.php", key: "k", job: base, imageBytes: new Uint8Array([1]), fileName: "moss_dash_4.webp", contentType: "image/webp" });
  assert.equal(res.ok, true);
  let file = getBody().get("image");
  assert.equal(file.type, "image/webp");
  assert.equal(file.name, "moss_dash_4.webp");

  res = await pushToGallery({ url: "https://x/upload.php", key: "k", job: base, imageBytes: new Uint8Array([1]), fileName: "moss_dash_4.png" });
  assert.equal(res.ok, true);
  file = getBody().get("image");
  assert.equal(file.type, "image/png");
  assert.equal(file.name, "moss_dash_4.png");
});

// 画廊推送补 steps / cfg / text_encoder / vae（v1.2.13）：值与画廊服务端
// MODEL_PARAMS 一致，详情页不再靠服务端按时间查表兜底。
test("pushToGallery：四模型都带 steps/cfg/text_encoder/vae，且值与画廊服务端 MODEL_PARAMS 一致", async () => {
  const getBody = stubFetchCapture();
  const cases = [
    { model: "moss", steps: "25", cfg: "3.5", text_encoder: "Qwen3.5-9B w4a8", vae: "FLUX.2 small" },
    { model: "qwen", steps: "25", cfg: "3", text_encoder: "Qwen3-VL 8B int8", vae: "Qwen Image 2.1 VAE" },
    { model: "krea2", steps: "8", cfg: "1", text_encoder: "Qwen3-VL 4B fp8", vae: "Qwen Image VAE" },
    { model: "zimage", steps: "8", cfg: "1", text_encoder: "Qwen3-4B FP8", vae: "Flux VAE" },
  ];
  for (const c of cases) {
    const job = { model: c.model, prompt: "p", seed: 5, width: 2048, height: 3072, createdAt: 1700000000000, loraKeys: [] };
    const res = await pushToGallery({ url: "https://x/upload.php", key: "k", job, imageBytes: new Uint8Array([1]), fileName: "a.webp", contentType: "image/webp" });
    assert.equal(res.ok, true, c.model);
    const body = getBody();
    assert.equal(body.get("steps"), c.steps, `${c.model} steps`);
    assert.equal(body.get("cfg"), c.cfg, `${c.model} cfg`);
    assert.equal(body.get("text_encoder"), c.text_encoder, `${c.model} text_encoder`);
    assert.equal(body.get("vae"), c.vae, `${c.model} vae`);
  }
});

test("MOSS 尺寸表（2026-11-16，只改底图 1280）：最终短边 2560、底图短边 1280，2:3 为 2560x3840", () => {
  // 每档最终尺寸短边都是 2560（底图短边 1280），边长都能被 32 整除
  // （底图边长即能被 16 整除，latent 要求满足）。
  for (const [key, size] of Object.entries(MOSS_SIZES)) {
    assert.equal(Math.min(size.width, size.height), 2560, `${key} 短边应为 2560`);
    assert.equal(size.width % 32, 0, `${key} 宽应能被 32 整除`);
    assert.equal(size.height % 32, 0, `${key} 高应能被 32 整除`);
    const base = upscaleOffSize(size.width, size.height);
    assert.equal(Math.min(base.width, base.height), 1280, `${key} 底图短边应为 1280`);
  }
  assert.deepEqual(resolveSize("moss", "r2x3v"), { key: "r2x3v", width: 2560, height: 3840, label: "2:3竖" });
  assert.deepEqual(resolveSize("moss", "r9x16v"), { key: "r9x16v", width: 2560, height: 4544, label: "9:16竖" });
});

test("ratioOptionLabel：比例选项后面括号里写原始尺寸（底图），不是超分后的最终尺寸（2026-11-16 用户要求并纠正）", () => {
  // MOSS 2:3 最终 2560×3840，底图 1280×1920；括号里写底图
  assert.equal(ratioOptionLabel("moss", "r2x3v"), "2:3竖 (1280×1920)");
  assert.equal(ratioOptionLabel("moss", "r9x16v"), "9:16竖 (1280×2272)");
  assert.equal(ratioOptionLabel("moss", "r1x1"), "1:1 (1280×1280)");
  // 非 MOSS 模型走 QWEN_SIZES 表，尺寸跟着换，同样写底图
  // （2026-11-16：Qwen/Krea2/Z-Image 底图短边提到 1024，2:3 底图 1024×1536）
  assert.equal(ratioOptionLabel("qwen", "r2x3v"), "2:3竖 (1024×1536)");
  assert.equal(ratioOptionLabel("krea2", "r2x3v"), "2:3竖 (1024×1536)");
  assert.equal(ratioOptionLabel("zimage", "r2x3v"), "2:3竖 (1024×1536)");
});
