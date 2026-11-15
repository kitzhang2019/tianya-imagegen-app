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
