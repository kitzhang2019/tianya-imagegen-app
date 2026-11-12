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
 * @param {{model:string, prompt:string, width:number, height:number, seed:number, jobId:number}} opts
 * @returns {{text:string, notebook:object}} text 为可直接推送的 notebook JSON 字符串
 * （cell source 已按 Kaggle 官方客户端的方式归一化为单个字符串，code cell 输出已清空）。
 * 失败时抛错，绝不返回半成品。
 */
export function patchNotebook(template, { model, prompt, width, height, seed, jobId }) {
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
  if (!run.includes("PROMPT")) {
    throw new Error(`模板 ${cfg.file} 第 5 格不像出图格（没有 PROMPT）`);
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

  // PROMPT：整段赋值换成 base64 解码行，原始提示词绝不进带引号的字面量
  const promptB64 = utf8ToBase64(prompt);
  let promptHits = 0;
  run = run.replace(PROMPT_ASSIGN_RE, () => {
    promptHits += 1;
    return `PROMPT = __import__("base64").b64decode("${promptB64}").decode("utf-8")`;
  });
  if (promptHits !== 1) {
    throw new Error(`PROMPT 赋值应恰好替换 1 次，实际 ${promptHits} 次`);
  }

  if (model === "moss") {
    run = replaceOnce(
      run,
      '{"width": 1696, "height": 2112, "batch_size": 1}',
      `{"width": ${width}, "height": ${height}, "batch_size": 1}`,
      "MOSS latent 尺寸",
    );
    run = replaceOnce(run, '"seed": 42', `"seed": ${seed}`, "MOSS 种子");
  } else if (model === "qwen") {
    run = replaceOnce(
      run,
      '{"width": 1024, "height": 1024, "batch_size": 1}',
      `{"width": ${width}, "height": ${height}, "batch_size": 1}`,
      "Qwen latent 尺寸",
    );
    run = replaceOnce(run, '"resolution": 1024', '"resolution": 2144', "Qwen resolution");
    run = replaceOnce(run, '"noise_seed": 42', `"noise_seed": ${seed}`, "Qwen 种子");
  } else if (model === "krea2") {
    run = replaceOnce(
      run,
      '{"width": 1024, "height": 1024, "batch_size": 1}',
      `{"width": ${width}, "height": ${height}, "batch_size": 1}`,
      "Krea2 latent 尺寸",
    );
    run = replaceOnce(run, '"seed": 42', `"seed": ${seed}`, "Krea2 种子");
  } else if (model === "zimage") {
    run = replaceOnce(run, "WIDTH = 1024", `WIDTH = ${width}`, "Z-Image 宽度");
    run = replaceOnce(run, "HEIGHT = 1024", `HEIGHT = ${height}`, "Z-Image 高度");
    run = replaceOnce(run, '"seed": 42', `"seed": ${seed}`, "Z-Image 种子");
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
  if (base64ToUtf8(m[1]) !== prompt) {
    throw new Error("提示词往返校验失败：解码结果与原提示词不一致");
  }
  return { text, notebook: parsed };
}
