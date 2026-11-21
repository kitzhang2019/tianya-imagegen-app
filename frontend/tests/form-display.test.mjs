// tests/form-display.test.mjs — 表单显示测试：LoRA 开关只写名字和值（不带“LoRA”
// 二字）、画廊推送的 lora 标签格式不动；LoRA + 超分两列网格；模型/比例
// 下拉框紧凑尺寸（重点是框高 36px）。跑法：npm test。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  KREA2_LORA,
  MOSS_LORAS,
  ZIMAGE_LORAS,
  loraLabelForJob,
  mossLoraLabel,
  zimageLoraLabel,
} from "../src/lib/notebook.js";

const mainJs = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("表单显示标签：只写名字和值，不带“LoRA”二字", () => {
  assert.deepEqual(
    MOSS_LORAS.map((l) => l.switchLabel),
    ["观澜 0.8", "Blender3D 1.0"],
  );
  assert.equal(KREA2_LORA.switchLabel, "HerRAW 0.3");
  assert.deepEqual(
    ZIMAGE_LORAS.map((l) => l.label),
    ["HerRAW 0.8", "瑶光 1.0", "ostris 1.0"],
  );
  // 表单渲染用的就是这些显示字段：MOSS 用 switchLabel，Krea2 用 switchLabel，
  // Z-Image 直接用 label，不再往里插“LoRA”二字
  assert.match(mainJs, /l\.switchLabel/);
  assert.match(mainJs, /KREA2_LORA\.switchLabel/);
  assert.doesNotMatch(mainJs, /" LoRA \$1"/);
  // 两个盒子包在两列网格容器里
  assert.match(mainJs, /class="options-grid"/);
  assert.match(mainJs, /id="lora-box"/);
  assert.match(mainJs, /id="upscale-box"/);
});

test("画廊推送的 lora 标签格式不动（仍带“LoRA”二字，Z-Image 本来就不带）", () => {
  assert.equal(mossLoraLabel(["guanlan", "blender3d"]), "观澜 LoRA 0.8 + Blender3D LoRA 1.0");
  assert.equal(mossLoraLabel(["guanlan"]), "观澜 LoRA 0.8");
  assert.equal(loraLabelForJob({ model: "krea2" }), "HerRAW LoRA 0.3");
  assert.equal(loraLabelForJob({ model: "krea2", useLora: false }), "");
  assert.equal(zimageLoraLabel(["herraw", "yaoguang", "ostris"]), "HerRAW 0.8 + 瑶光 1.0 + ostris 1.0");
});

test("LoRA + 超分两列网格，盒子自身不再叠外边距", () => {
  assert.match(css, /\.options-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s);
  assert.match(css, /\.options-grid \.lora-box\s*\{[^}]*display:\s*contents/s);
  assert.match(css, /\.options-grid \.lora-title\s*\{[^}]*grid-column:\s*1 \/ -1/s);
});

test("模型/比例下拉框紧凑：框高 36px，内边距与字号配合收紧", () => {
  assert.match(css, /\.glass-select\s*\{[^}]*height:\s*36px/s);
  assert.match(css, /\.glass-select\s*\{[^}]*font-size:\s*14px/s);
  assert.match(css, /\.glass-select\s*\{[^}]*padding:\s*0 32px 0 12px/s);
});

test("后端选择器：模型那一行左边两颗椭圆形药丸按钮（Kaggle / Colab），不是复选框", () => {
  // 平台按钮在模型下拉框同一行左边，右边仍是模型下拉框
  assert.match(mainJs, /class="backend-pills"/);
  assert.match(mainJs, /data-backend="kaggle"/);
  assert.match(mainJs, /data-backend="colab"/);
  assert.match(mainJs, /id="model-select"/);
  // 药丸是 button，不是 LoRA 那种 checkbox
  assert.doesNotMatch(mainJs, /backend-pill[^>]*type="checkbox"/);
  assert.match(mainJs, /class="backend-pill"[^>]*data-backend="kaggle"/);
  // 椭圆：border-radius 999px；点亮态用渐变
  assert.match(css, /\.backend-pill\s*\{[^}]*border-radius:\s*999px/s);
  assert.match(css, /\.backend-pill\.active\s*\{[^}]*linear-gradient/s);
  // 任务列表显示每单走的后端
  assert.match(mainJs, /backend-badge-colab/);
  assert.match(mainJs, /job\.backend === "colab" \? "Colab" : "Kaggle"/);
  // 设置里有 Colab 中转密钥项（只存本机）
  assert.match(mainJs, /id="set-relay-key"/);
  assert.match(mainJs, /relayKey/);
});

test("开始生成按钮下方有后端使用说明：优先 Kaggle，队列满中转重新排队、不自动切 Colab", () => {
  // 说明紧跟在开始生成按钮之后，用已有的 hint 小字样式
  assert.match(
    mainJs,
    /id="btn-submit"[^>]*>开始生成<\/button>\s*<p class="hint">优先使用 Kaggle，如果 Kaggle 出故障了，使用 Colab 生成。（Kaggle 队列已满时中转会重新排队，不会自动切换到 Colab；想走 Colab 请手动切换。）<\/p>/s,
  );
});

test("切后端保留各自开关状态：灰掉的开关值不动，切回来还是原来的状态", () => {
  // 换后端只重渲染盒子、不重置开关值：useUpscale / useColabUpscale 在 main.js
  // 里各只在两处赋值——初始化（默认开）和开关本身的 change 事件；后端药丸
  // 的点击处理里没有对它们的赋值，所以 Kaggle 下把 7B 关了、切到 Colab 再
  // 切回 Kaggle，7B 还是关着的（3B 同理）。
  assert.equal((mainJs.match(/useUpscale =/g) || []).length, 2, "useUpscale 只应在初始化和 change 时赋值");
  assert.equal((mainJs.match(/useColabUpscale =/g) || []).length, 2, "useColabUpscale 只应在初始化和 change 时赋值");
  // 渲染时 checked 从各自变量读、disabled 从后端读：值与可用状态是两回事，
  // 灰掉只禁点，不改值
  assert.match(mainJs, /data-upscale \$\{useUpscale \? "checked" : ""\}/);
  assert.match(mainJs, /data-colab-upscale \$\{useColabUpscale \? "checked" : ""\}/);
  // 提交时按当前后端取对应开关：Colab 单传 3B 的值，Kaggle 单传 7B 的值
  assert.match(mainJs, /await submitJob\(\{[\s\S]*?useUpscale,\n\s*useColabUpscale,/);
});

test("超分 SeedVR 3B 开关：只在 Colab 下可点，Kaggle 下灰掉；7B 开关反过来", () => {
  // 主页上有 3B 开关，文案写明是 SeedVR 3B，跟 7B 开关并排在超分盒子里
  assert.match(mainJs, /超分 SeedVR 3B/);
  assert.match(mainJs, /data-colab-upscale/);
  assert.match(mainJs, /id="upscale-box"/);
  // 渲染函数按后端给两个开关加 disabled：3B 只在 Colab 下可点
  // （Kaggle 下 label 带 disabled、checkbox 带 disabled），7B 反过来
  assert.match(mainJs, /lora-row\$\{kaggleSelected \? " disabled" : ""\}/);
  assert.match(mainJs, /lora-row\$\{kaggleSelected \? "" : " disabled"\}/);
  assert.match(mainJs, /data-colab-upscale \$\{useColabUpscale \? "checked" : ""\}\$\{kaggleSelected \? " disabled" : ""\}/);
  assert.match(mainJs, /data-upscale \$\{useUpscale \? "checked" : ""\}\$\{kaggleSelected \? "" : " disabled"\}/);
  // 3B 开关默认开（和 7B 开关一样，只认明确关掉）
  assert.match(mainJs, /let useColabUpscale = true;/);
  // 换后端立刻重渲染超分盒子，可用状态马上跟着变；恢复上次选的后端时也一样
  assert.match(mainJs, /selectedBackend = btn\.dataset\.backend;[\s\S]{0,300}renderUpscaleBox\(\);/);
  assert.match(mainJs, /selectedBackend = getSettings\(\)\.backend === "colab" \? "colab" : "kaggle";[\s\S]{0,200}renderUpscaleBox\(\);/);
  // 提交时把 3B 选择传给任务层
  assert.match(mainJs, /await submitJob\(\{[\s\S]*?useColabUpscale,/);
  // 灰掉的开关行变淡、不可点
  assert.match(css, /\.lora-row\.disabled\s*\{[^}]*opacity:\s*0\.45/s);
});
