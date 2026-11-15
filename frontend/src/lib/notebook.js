// notebook.js — 纯函数：notebook 模板打补丁 + 尺寸表。
// 不依赖任何 Capacitor API，可在 plain Node 里直接 import 做单元测试。
// 打补丁规则与管理站 privileged.ts 的 prepareMuseNotebook 逐项一致。

export const NOTEBOOK_KINDS = {
  moss: { file: "moss-comfyui-kaggle.ipynb", base: "moss_fashion", prefix: "moss_dash" },
  qwen: { file: "qwen-comfyui-kaggle.ipynb", base: "qwen_test", prefix: "qwen_dash" },
  krea2: { file: "krea2-comfyui-kaggle.ipynb", base: "krea2_test", prefix: "krea2_dash" },
  zimage: { file: "zimage-comfyui-kaggle.ipynb", base: "zimage_test", prefix: "zimage_dash" },
};

export const MODEL_LABELS = {
  moss: "MOSS-Image",
  qwen: "Qwen Image 2.1",
  krea2: "Krea2",
  zimage: "Z-Image",
};

export const MODEL_NAMES = ["moss", "qwen", "krea2", "zimage"];

// 2.2x 尺寸表（MOSS）
export const MOSS_SIZES = {
  r16x9h: { width: 2528, height: 1424 },
  r9x16v: { width: 1424, height: 2528 },
  r4x3h: { width: 2256, height: 1696 },
  r3x4v: { width: 1696, height: 2256 },
  r1x1: { width: 2256, height: 2256 },
  r3x2h: { width: 2528, height: 1696 },
  r2x3v: { width: 1696, height: 2528 },
  r21x9: { width: 2960, height: 1264 },
  r2x1h: { width: 3488, height: 1456 },
  r1x2v: { width: 1456, height: 3488 },
  r5x4h: { width: 2528, height: 2016 },
  r4x5v: { width: 2016, height: 2528 },
};

// 2.1x 尺寸表（Qwen / Krea2 / Z-Image 共用）
export const QWEN_SIZES = {
  r16x9h: { width: 2880, height: 1600 },
  r9x16v: { width: 1600, height: 2880 },
  r4x3h: { width: 2496, height: 1888 },
  r3x4v: { width: 1888, height: 2496 },
  r1x1: { width: 2144, height: 2144 },
  r3x2h: { width: 2624, height: 1760 },
  r2x3v: { width: 1760, height: 2624 },
  r21x9: { width: 3296, height: 1408 },
  r2x1h: { width: 3296, height: 1376 },
  r1x2v: { width: 1376, height: 3296 },
  r5x4h: { width: 2400, height: 1920 },
  r4x5v: { width: 1920, height: 2400 },
};

export const RATIO_KEYS = [
  "r16x9h", "r9x16v", "r4x3h", "r3x4v", "r1x1", "r3x2h",
  "r2x3v", "r21x9", "r2x1h", "r1x2v", "r5x4h", "r4x5v",
];

export const RATIO_LABELS = {
  r16x9h: "16:9横",
  r9x16v: "9:16竖",
  r4x3h: "4:3横",
  r3x4v: "3:4竖",
  r1x1: "1:1",
  r3x2h: "3:2横",
  r2x3v: "2:3竖",
  r21x9: "21:9",
  r2x1h: "2:1横",
  r1x2v: "1:2竖",
  r5x4h: "5:4横",
  r4x5v: "4:5竖",
};

// 比例值 -> ratioKey（2.39:1 按 2:1 计，1:2.39 按 1:2 计）
const RATIO_BY_VALUE = [
  [16 / 9, "r16x9h"],
  [9 / 16, "r9x16v"],
  [4 / 3, "r4x3h"],
  [3 / 4, "r3x4v"],
  [1, "r1x1"],
  [3 / 2, "r3x2h"],
  [2 / 3, "r2x3v"],
  [21 / 9, "r21x9"],
  [2.39, "r2x1h"],
  [2, "r2x1h"],
  [1 / 2.39, "r1x2v"],
  [1 / 2, "r1x2v"],
  [5 / 4, "r5x4h"],
  [4 / 5, "r4x5v"],
];

function ratioPairToKey(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  for (const [value, key] of RATIO_BY_VALUE) {
    if (Math.abs(r - value) < 0.02) return key;
  }
  return null;
}

/**
 * 按提示词解析比例（auto 模式）。
 * 识别 16:9 / 9:16 / 4:3 / 3:4 / 1:1 / 3:2 / 2:3 / 21:9 / 2:1 / 1:2 /
 * 2.39:1 / 5:4 / 4:5（半角或全角冒号）；裸写 竖屏 -> 9:16，横屏 -> 16:9；
 * 都没有时 fallback 3:4。
 */
export function detectRatioKeyFromPrompt(prompt) {
  const text = String(prompt ?? "");
  const re = /(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = ratioPairToKey(parseFloat(m[1]), parseFloat(m[2]));
    if (key) return key;
  }
  if (/竖屏|竖版|竖构图/.test(text)) return "r9x16v";
  if (/横屏|横版|横构图/.test(text)) return "r16x9h";
  return "r3x4v";
}

/** 解析最终尺寸：ratioKey 为 "auto" 时从提示词里猜，否则直接查表。 */
export function resolveSize(model, ratioKey, prompt) {
  const table = model === "moss" ? MOSS_SIZES : QWEN_SIZES;
  const key =
    ratioKey && ratioKey !== "auto" && table[ratioKey]
      ? ratioKey
      : ratioKey === "auto"
        ? detectRatioKeyFromPrompt(prompt)
        : "r3x4v";
  const size = table[key] ?? table.r3x4v;
  return { key, width: size.width, height: size.height, label: RATIO_LABELS[key] };
}

export function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}

export function kernelBaseSlug(model) {
  return (NOTEBOOK_KINDS[model] ?? NOTEBOOK_KINDS.moss).file.replace(
    "-comfyui-kaggle.ipynb",
    "-comfyui-kaggle",
  );
}

export function outputFileName(model, jobId) {
  const prefix = (NOTEBOOK_KINDS[model] ?? NOTEBOOK_KINDS.moss).prefix;
  return `${prefix}_${jobId}.png`;
}

// --- LoRA 选择（2026-11-15，用户定版）---
// MOSS：观澜 0.8（默认带，HF 镜像下载，无 Kaggle 数据集）+ Blender3D 1.0
// （默认不带，Kaggle 私有数据集 kitzhang2019/moss-blender3d-lora-v2）；
// Krea2：HerRAW 0.3（默认带，HF 镜像下载 + Kaggle 数据集 herraw-sensual-krea2）；
// Z-Image：HerRAW 0.8 + 瑶光 1.0 + ostris 1.0（默认全带，各自走 Kaggle 数据集）。
export const MOSS_LORA = {
  file: "KOOK-MOSS-SFT-观澜.safetensors",
  repo: "RunningHubAI/rh-kook-moss-sft-lora",
  strength: 0.8,
  label: "观澜 LoRA 0.8",
};
// MOSS 双 LoRA 注册表（2026-11-15，Blender3D 加入）：顺序固定观澜 → Blender3D。
// label 是画廊标签；switchLabel 是表单开关上显示的文字（Blender3D 开关只写
// "Blender3D 1.0"，与任务要求一致）。
export const MOSS_LORAS = [
  { key: "guanlan", file: "KOOK-MOSS-SFT-观澜.safetensors", strength: 0.8, label: "观澜 LoRA 0.8", switchLabel: "观澜 LoRA 0.8" },
  { key: "blender3d", file: "Moss_Blender3D_V2.safetensors", strength: 1.0, dataset: "kitzhang2019/moss-blender3d-lora-v2", label: "Blender3D LoRA 1.0", switchLabel: "Blender3D 1.0" },
];
export const DEFAULT_MOSS_LORA_KEYS = ["guanlan"];
// Blender3D 数据集（Kaggle 私有，145,157,344 字节已核实）：观澜走 HF 不挂数据集。
export const MOSS_BLENDER3D_DATASET = "kitzhang2019/moss-blender3d-lora-v2";
// Blender3D 触发词（2026-11-15，用户要求）：选中 Blender3D 时提示词里没有
// @blender 就在末尾追加整串，一个都不能丢；已经有 @blender 就什么都不加。
export const MOSS_BLENDER3D_TRIGGER =
  "@blender, dreamy smooth polished body rendering, wet oily skin look, anime style with realistic skin reflection";
export const KREA2_LORA = {
  file: "HerRAW_Sensual_v0.2.safetensors",
  repo: "RunningHubAI/rh-herraw-sensual-v0.2-lora",
  strength: 0.3,
  dataset: "kitzhang2019/herraw-sensual-krea2",
  label: "HerRAW LoRA 0.3",
};
// Krea2 主模型：Ray Artshoot v5 nvfp4（2026-11-15，App 与管理站/磁盘模板同步，
// 旧 GGUF Q5_K_M 已弃用）。模板从该私有数据集里取模型文件，Krea2 单必挂。
export const KREA2_RAY_DATASET = "kitzhang2019/ray-artshoot-krea2-v5-nvfp4";
// Z-Image 主模型：PornMaster Turbo V3.5 fp8（2026-11-15，App 与管理站/磁盘模板同步，
// 旧官方 Turbo 已弃用）。模板从该私有数据集里取模型文件，Z-Image 单必挂。
export const ZIMAGE_MAIN_DATASET = "kitzhang2019/pornmaster-zimage-v35-fp8";
// SeedVR 7B 放大模型（2026-11-15，四模板同步 SeedVR 第二段）：DiT + VAE 走私有
// 数据集，模板下载格从 /kaggle/input 软链进 ComfyUI/models/SEEDVR2/。四模型都挂。
export const SEEDVR_DATASET = "kitzhang2019/seedvr2-7b";
export const ZIMAGE_LORAS = [
  { key: "herraw", file: "HerRAW_zimage_v0.2_c1-st5000.safetensors", strength: 0.8, dataset: "kitzhang2019/herraw-zimage-v02", label: "HerRAW 0.8" },
  { key: "yaoguang", file: "Kook_Zimage_Yaoguang.safetensors", strength: 1.0, dataset: "kitzhang2019/kook-zimage-yaoguang2", label: "瑶光 1.0" },
  { key: "ostris", file: "zimage_turbo_training_adapter_v2.safetensors", strength: 1.0, dataset: "kitzhang2019/ostris-zimage-turbo-adapter-v2", label: "ostris 1.0" },
];
export const DEFAULT_ZIMAGE_LORA_KEYS = ZIMAGE_LORAS.map((l) => l.key);

/** 把任意输入规整成 MOSS LoRA key 列表：只留认识的、去重、按注册表顺序排。 */
export function normalizeMossLoraKeys(keys) {
  const wanted = new Set(Array.isArray(keys) ? keys.map((k) => String(k)) : []);
  return MOSS_LORAS.filter((l) => wanted.has(l.key)).map((l) => l.key);
}

/** MOSS LoRA 组合标签（与管理站推送格式一致），没挂返回 ""。 */
export function mossLoraLabel(keys) {
  return normalizeMossLoraKeys(keys)
    .map((k) => MOSS_LORAS.find((l) => l.key === k).label)
    .join(" + ");
}

/** MOSS 选中 LoRA 对应的 Kaggle 数据集（观澜走 HF 镜像，不挂数据集；Blender3D 只走数据集）。 */
export function mossLoraDatasets(keys) {
  return normalizeMossLoraKeys(keys)
    .map((k) => MOSS_LORAS.find((l) => l.key === k).dataset)
    .filter(Boolean);
}

/** 把任意输入规整成 Z-Image LoRA key 列表：只留认识的、去重、按注册表顺序排。 */
export function normalizeLoraKeys(keys) {
  const wanted = new Set(Array.isArray(keys) ? keys.map((k) => String(k)) : []);
  return ZIMAGE_LORAS.filter((l) => wanted.has(l.key)).map((l) => l.key);
}

/** Z-Image LoRA 组合标签（与管理站推送格式一致），没挂返回 ""。 */
export function zimageLoraLabel(keys) {
  return normalizeLoraKeys(keys)
    .map((k) => ZIMAGE_LORAS.find((l) => l.key === k).label)
    .join(" + ");
}

/** 一条任务的 LoRA 标签：MOSS 看 loraKeys（新任务）或 useLora（旧任务，默认带观澜），Krea2 看 useLora（默认带），Z-Image 看 loraKeys。 */
export function loraLabelForJob(job) {
  if (!job) return "";
  if (job.model === "moss") {
    if (job.loraKeys !== undefined) return mossLoraLabel(job.loraKeys);
    return job.useLora === false ? "" : MOSS_LORA.label;
  }
  if (job.model === "krea2") return job.useLora === false ? "" : KREA2_LORA.label;
  if (job.model === "zimage") return zimageLoraLabel(job.loraKeys ?? DEFAULT_ZIMAGE_LORA_KEYS);
  return "";
}

// --- base64（UTF-8 <-> base64），Node 用 Buffer，浏览器用 btoa/atob ---
export function utf8ToBase64(text) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(String(text), "utf-8").toString("base64");
  }
  const bytes = new TextEncoder().encode(String(text));
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToUtf8(b64) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(String(b64), "base64").toString("utf-8");
  }
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(u8).toString("base64");
  }
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(String(b64), "base64"));
  }
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- 补丁常量（与管理站 privileged.ts 逐字一致） ---
export const MOODY_DATASET_SLUG = "moody-moss-mix-v33";
export const MOODY_MODEL_FILE =
  "Moody-Moss-Mix-V3.3_00001__clean-int8_convrot.safetensors";
export const MOODY_MODEL_BYTES = 5088901904;

export const OUTPUT_CLEANUP_SNIPPET = [
  "",
  "# [管理站注入] 出图已完成、结果图已存到 /kaggle/working 根目录：",
  "# 清掉部署进工作区的 ComfyUI 本体和模型缓存，让 Kaggle 输出列表",
  "# 从上万个文件缩到只剩结果图和日志，管理站取图翻一页就能找到。",
  "# 模型每次运行本来就会重新下载，清掉不影响下一次运行；清理失败",
  "# 也绝不影响出图结果，所以全程吞掉异常。",
  "try:",
  "    import shutil as _shutil",
  "    for _p in ('/kaggle/working/ComfyUI', '/kaggle/working/hf_cache'):",
  "        _shutil.rmtree(_p, ignore_errors=True)",
  "    print('output cleanup done')",
  "except Exception:",
  "    pass",
].join("\n");

const PROMPT_ASSIGN_RE = /PROMPT = ("""[\s\S]*?"""|"(?:[^"\\]|\\.)*")/;

function cellText(cell) {
  if (!cell) return "";
  if (typeof cell.source === "string") return cell.source;
  if (Array.isArray(cell.source)) return cell.source.join("");
  return "";
}

function replaceOnce(text, oldStr, newStr, label) {
  const n = text.split(oldStr).length - 1;
  if (n !== 1) {
    throw new Error(`${label}：模板里应恰好出现 1 次，实际 ${n} 次`);
  }
  return text.replace(oldStr, newStr);
}

/**
 * 给 notebook 模板打补丁。
 * @param {string|object} template - notebook JSON 文本或已解析对象
 * @param {{model:string, prompt:string, width:number, height:number, seed:number, jobId:number, useLora?:boolean, loraKeys?:string[]}} opts
 *   useLora：Krea2 的 LoRA 开关（默认带，false 时清空 LORA_NAME）；MOSS 旧任务
 *   的开关（新任务走 loraKeys，未传时 useLora=false = 不挂，否则默认只带观澜）；
 *   loraKeys：MOSS / Z-Image 的 LoRA 选择（MOSS 默认只带观澜，空数组 = 不挂；
 *   Z-Image 默认全带，空数组 = 不挂）。MOSS 选中 Blender3D 时提示词没有
 *   @blender 会自动在末尾追加整串触发词，已有则不加。
 * @returns {{text:string, notebook:object}} text 为可直接推送的 notebook JSON 字符串
 * （cell source 已按 Kaggle 官方客户端的方式归一化为单个字符串，code cell 输出已清空）。
 * 失败时抛错，绝不返回半成品。
 */
export function patchNotebook(template, { model, prompt, width, height, seed, jobId, useLora, loraKeys }) {
  const cfg = NOTEBOOK_KINDS[model];
  if (!cfg) throw new Error(`未知的模型：${model}`);
  if (!prompt || !String(prompt).trim()) throw new Error("提示词不能为空");
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`尺寸不对：${width}x${height}`);
  }
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`种子不对：${seed}`);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error(`任务号不对：${jobId}`);

  const nb = typeof template === "string" ? JSON.parse(template) : template;
  const cells = nb.cells;
  if (!Array.isArray(cells) || cells.length < 6) {
    throw new Error(`模板 ${cfg.file} 结构不对（格子数不足）`);
  }
  let run = cellText(cells[4]);
  let disp = cellText(cells[5]);
  let dl = cellText(cells[3]);
  if (!run.includes("PROMPT")) {
    throw new Error(`模板 ${cfg.file} 第 5 格不像出图格（没有 PROMPT）`);
  }

  // LoRA 选择：只改下载格（cell 3）的 LORA_NAME / LORA_NAMES，出图格按它走。
  // MOSS 是双选：按选择重写 LORA_NAMES 里的 key 元组（默认只带观澜）。
  // Krea2 是单 LoRA 开关：关 = 清空 LORA_NAME；开 = 模板默认值必须已是接线版。
  // Z-Image 是多选：按选择重写 LORA_NAMES 里的 key 元组。
  // MOSS 的选择先算出来：触发词追加也要按它判断。
  const mossKeys =
    model === "moss"
      ? loraKeys !== undefined
        ? normalizeMossLoraKeys(loraKeys)
        : useLora === false
          ? []
          : [...DEFAULT_MOSS_LORA_KEYS]
      : null;
  let dlChanged = false;
  if (model === "moss") {
    if (!dl.includes("MOSS_LORAS = {")) {
      throw new Error("MOSS 模板的下载格不是两 LoRA 注册表版（缺 MOSS_LORAS 注册表）");
    }
    // 注意：单元素元组必须带尾逗号 ("blender3d",)，否则 ("blender3d") 只是字符串，
    // for 循环会逐字符迭代报 KeyError（管理站 2026-11-15 抓到过的同款 bug）。
    const tuple = mossKeys.length === 1 ? `"${mossKeys[0]}",` : mossKeys.map((k) => `"${k}"`).join(", ");
    const re = /LORA_NAMES = \[MOSS_LORAS\[k\] for k in \([^)]*\)\]/;
    const hits = dl.match(re);
    if (!hits || hits.length !== 1) {
      throw new Error(`MOSS LORA_NAMES 赋值应恰好出现 1 次，实际 ${hits ? hits.length : 0} 次`);
    }
    dl = dl.replace(re, `LORA_NAMES = [MOSS_LORAS[k] for k in (${tuple})]`);
    dlChanged = true;
  } else if (model === "krea2") {
    if (!dl.includes(`LORA_NAME = "${KREA2_LORA.file}"`)) {
      throw new Error("Krea2 模板的下载格不是 HerRAW 接线版（LORA_NAME 应为 HerRAW 文件）");
    }
    if (!run.includes('"sampler_name": "ddim"') || !run.includes('"scheduler": "beta"')) {
      throw new Error("Krea2 模板的出图格不是 ddim/beta 采样器");
    }
    if (useLora === false) {
      dl = replaceOnce(dl, `LORA_NAME = "${KREA2_LORA.file}"`, 'LORA_NAME = ""', "Krea2 不带 LoRA");
      dlChanged = true;
    }
  } else if (model === "zimage") {
    if (!dl.includes("ZIMAGE_LORAS = {")) {
      throw new Error("Z-Image 模板的下载格不是三 LoRA 串联版（缺 ZIMAGE_LORAS 注册表）");
    }
    if (loraKeys !== undefined) {
      const keys = normalizeLoraKeys(loraKeys);
      // 注意：单元素元组必须带尾逗号 ("yaoguang",)，否则 ("yaoguang") 只是字符串，
      // for 循环会逐字符迭代报 KeyError（管理站 2026-11-15 抓到过的同款 bug）。
      const tuple = keys.length === 1 ? `"${keys[0]}",` : keys.map((k) => `"${k}"`).join(", ");
      const re = /LORA_NAMES = \[ZIMAGE_LORAS\[k\] for k in \([^)]*\)\]/;
      const hits = dl.match(re);
      if (!hits || hits.length !== 1) {
        throw new Error(`Z-Image LORA_NAMES 赋值应恰好出现 1 次，实际 ${hits ? hits.length : 0} 次`);
      }
      dl = dl.replace(re, `LORA_NAMES = [ZIMAGE_LORAS[k] for k in (${tuple})]`);
      dlChanged = true;
    }
  }

  // MOSS 模板守卫：必须是 Moody Moss Mix V3.3 版
  if (model === "moss") {
    const dl = cellText(cells[3]);
    if (
      !dl.includes(MOODY_DATASET_SLUG) ||
      !dl.includes(MOODY_MODEL_FILE) ||
      !dl.includes("/kaggle/input") ||
      dl.includes("diffusion_models/moss_image_sft_int8_convrot.safetensors")
    ) {
      throw new Error(
        "MOSS 模板的模型下载格不是 Moody 版（应从数据集 moody-moss-mix-v33 在 /kaggle/input 下递归找模型文件、不再从 HuggingFace 下载扩散模型）",
      );
    }
    if (
      !run.includes(`"unet_name": "${MOODY_MODEL_FILE}"`) ||
      !run.includes('"steps": 25, "cfg": 3.5')
    ) {
      throw new Error(
        "MOSS 模板的出图格不是 Moody 配置（UNETLoader 应加载 Moody-Moss-Mix-V3.3 文件、KSampler 应为 25 步 / CFG 3.5）",
      );
    }
  }

  // PROMPT：整段赋值换成 base64 解码行，原始提示词绝不进带引号的字面量。
  // MOSS 选中 Blender3D 时，提示词里没有 @blender 就在末尾追加整串触发词
  //（用户 2026-11-15 要求，一个都不能丢；已经有 @blender 就什么都不加）。
  let effectivePrompt = String(prompt);
  if (model === "moss" && mossKeys.includes("blender3d") && !effectivePrompt.includes("@blender")) {
    effectivePrompt = `${effectivePrompt}, ${MOSS_BLENDER3D_TRIGGER}`;
  }
  const promptB64 = utf8ToBase64(effectivePrompt);
  let promptHits = 0;
  run = run.replace(PROMPT_ASSIGN_RE, () => {
    promptHits += 1;
    return `PROMPT = __import__("base64").b64decode("${promptB64}").decode("utf-8")`;
  });
  if (promptHits !== 1) {
    throw new Error(`PROMPT 赋值应恰好替换 1 次，实际 ${promptHits} 次`);
  }

  // SeedVR 两段式（2026-11-15，四模板已同步）：出图格先在底图尺寸上生成，
  // 再由 SeedVR2 7B 放大 2 倍到最终尺寸。底图 = 最终尺寸的一半，向下取整到
  // 16 的倍数（latent 是像素 /8，DiT patch 2 要求 latent 边长为偶数，即像素
  // 边长能被 16 整除）；SeedVR resolution = 底图短边 × 2（与磁盘模板
  // 1024×1536 配 resolution 2048 的做法一致，短边 1024 → 2048）。
  const round16 = (v) => Math.max(16, Math.round(v / 16) * 16);
  const baseW = round16(width / 2);
  const baseH = round16(height / 2);
  const seedvrResolution = 2 * Math.min(baseW, baseH);

  // SeedVR 模板守卫：四模板都已是两段式，缺 SeedVR 就抛错，绝不推送一个
  // 单段模板当两段跑。
  if (
    !run.includes("SeedVR2VideoUpscaler") ||
    !run.includes("nodes_seedvr") ||
    !run.includes("webp_fine") ||
    !dl.includes("seedvr2-7b")
  ) {
    throw new Error(`模板 ${cfg.file} 不是 SeedVR 版（缺 SeedVR 第二段或下载格缺 SeedVR 模型软链）`);
  }

  if (model === "moss") {
    run = replaceOnce(
      run,
      '{"width": 1024, "height": 1536, "batch_size": 1}',
      `{"width": ${baseW}, "height": ${baseH}, "batch_size": 1}`,
      "MOSS latent 尺寸（SeedVR 底图）",
    );
    // 种子：KSampler 与 SeedVR 放大节点各有一个 "seed": 42（管理站的做法也是
    // 任务种子同步写进 SeedVR 节点），两个都换成任务种子。
    {
      const seedHits = run.split('"seed": 42').length - 1;
      if (seedHits !== 2) {
        throw new Error(`MOSS 种子应恰好出现 2 次（KSampler + SeedVR），实际 ${seedHits} 次`);
      }
      run = run.split('"seed": 42').join(`"seed": ${seed}`);
    }
    run = replaceOnce(
      run,
      '"resolution": 2048, "max_resolution": 6000',
      `"resolution": ${seedvrResolution}, "max_resolution": 6000`,
      "MOSS SeedVR resolution",
    );
  } else if (model === "qwen") {
    run = replaceOnce(
      run,
      '{"width": 1024, "height": 1024, "batch_size": 1}',
      `{"width": ${baseW}, "height": ${baseH}, "batch_size": 1}`,
      "Qwen latent 尺寸（SeedVR 底图）",
    );
    run = replaceOnce(run, '"resolution": 1024', `"resolution": ${baseH}`, "Qwen resolution（跟底图高度走，与磁盘模板一致）");
    run = replaceOnce(run, '"noise_seed": 42', `"noise_seed": ${seed}`, "Qwen 种子");
    run = replaceOnce(run, '"seed": 42', `"seed": ${seed}`, "Qwen SeedVR 种子");
    run = replaceOnce(
      run,
      '"resolution": 2048, "max_resolution": 6000',
      `"resolution": ${seedvrResolution}, "max_resolution": 6000`,
      "Qwen SeedVR resolution",
    );
  } else if (model === "krea2") {
    run = replaceOnce(
      run,
      '{"width": 1024, "height": 1024, "batch_size": 1}',
      `{"width": ${baseW}, "height": ${baseH}, "batch_size": 1}`,
      "Krea2 latent 尺寸（SeedVR 底图）",
    );
    run = replaceOnce(run, '"noise_seed": 42', `"noise_seed": ${seed}`, "Krea2 种子");
    run = replaceOnce(run, '"seed": 42', `"seed": ${seed}`, "Krea2 SeedVR 种子");
    run = replaceOnce(
      run,
      '"resolution": 2048, "max_resolution": 6000',
      `"resolution": ${seedvrResolution}, "max_resolution": 6000`,
      "Krea2 SeedVR resolution",
    );
  } else if (model === "zimage") {
    run = replaceOnce(run, "WIDTH = 1024", `WIDTH = ${baseW}`, "Z-Image 宽度（SeedVR 底图）");
    run = replaceOnce(run, "HEIGHT = 1024", `HEIGHT = ${baseH}`, "Z-Image 高度（SeedVR 底图）");
    // 种子：KSampler 与 SeedVR 放大节点各有一个 "seed": 42，两个都换成任务种子。
    {
      const seedHits = run.split('"seed": 42').length - 1;
      if (seedHits !== 2) {
        throw new Error(`Z-Image 种子应恰好出现 2 次（KSampler + SeedVR），实际 ${seedHits} 次`);
      }
      run = run.split('"seed": 42').join(`"seed": ${seed}`);
    }
    run = replaceOnce(
      run,
      '"resolution": 2048, "max_resolution": 6000',
      `"resolution": ${seedvrResolution}, "max_resolution": 6000`,
      "Z-Image SeedVR resolution",
    );
  }

  run = replaceOnce(
    run,
    `"filename_prefix": "${cfg.base}"`,
    `"filename_prefix": "${cfg.prefix}_${jobId}"`,
    "filename_prefix",
  );

  const oldPath = `/kaggle/working/${cfg.base}.png`;
  const newPath = `/kaggle/working/${cfg.prefix}_${jobId}.png`;
  const pathHits =
    run.split(oldPath).length - 1 + (disp.split(oldPath).length - 1);
  if (pathHits < 2) {
    throw new Error(`输出路径应至少出现 2 次（出图格+展示格），实际 ${pathHits} 次`);
  }
  run = run.split(oldPath).join(newPath);
  disp = disp.split(oldPath).join(newPath);

  // WebP 精细导出与 PNG 同名（SeedVR 第二段的产物）：路径也要换成任务号。
  const oldWebp = `/kaggle/working/${cfg.base}.webp`;
  const newWebp = `/kaggle/working/${cfg.prefix}_${jobId}.webp`;
  if (!run.includes(oldWebp)) {
    throw new Error(`模板 ${cfg.file} 不是 SeedVR 版（出图格缺 WebP 导出）`);
  }
  run = run.split(oldWebp).join(newWebp);
  disp = disp.split(oldWebp).join(newWebp);

  // 出图完成后清掉 ComfyUI 本体与模型缓存（只在出图格末尾执行）
  run = `${run.replace(/\s+$/, "")}\n${OUTPUT_CLEANUP_SNIPPET}\n`;

  // 归一化：与官方 Kaggle 客户端一致，code cell 输出清空、source 并成单个字符串
  const outCells = nb.cells.map((cell) => {
    const next = { ...cell };
    if (next.cell_type === "code" && "outputs" in next) next.outputs = [];
    if (Array.isArray(next.source)) next.source = next.source.join("");
    return next;
  });
  outCells[4] = { ...outCells[4], source: run };
  outCells[5] = { ...outCells[5], source: disp };
  if (dlChanged) outCells[3] = { ...outCells[3], source: dl };
  const outNb = { ...nb, cells: outCells };
  const text = JSON.stringify(outNb);

  // 校验：JSON 有效，且内嵌的 base64 载荷解码后与原提示词逐字一致
  //（设备上没有 Python ast.parse，往返校验就是校验）。
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`改好的 notebook 不是有效 JSON：${e.message}`);
  }
  const patchedRun = cellText(parsed.cells[4]);
  const m = /b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(patchedRun);
  if (!m) throw new Error("改好的 notebook 里找不到 base64 提示词载荷");
  if (base64ToUtf8(m[1]) !== effectivePrompt) {
    throw new Error("提示词往返校验失败：解码结果与原提示词不一致");
  }
  return { text, notebook: parsed };
}
