// tests/settings-about.test.mjs — 设置页“关于”：版本 + GitHub 两行，打开设置页
// 直接可见（不锁）；版本号从 package.json 注入，不手写。跑法：npm test。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const mainJs = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const viteConfig = fs.readFileSync(
  new URL("../vite.config.js", import.meta.url),
  "utf8",
);
const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const GITHUB_URL = "https://github.com/kitzhang2019/tianya-imagegen-app";

test("关于卡片在设置页，不藏在密码锁/首次设置/表单后面", () => {
  // 关于卡片是 settings-form 的兄弟节点，不带 hidden，打开设置页直接可见
  assert.match(mainJs, /id="settings-about"/);
  const aboutIdx = mainJs.indexOf('id="settings-about"');
  const formIdx = mainJs.indexOf('id="settings-form"');
  assert.ok(aboutIdx > formIdx, "关于卡片应放在 settings-form 之后、同一 section 内");
  const aboutTag = mainJs.slice(aboutIdx - 60, aboutIdx + 40);
  assert.doesNotMatch(aboutTag, /hidden/, "关于卡片不能带 hidden");
  // 锁/首次/表单三块仍各自由 renderSettings 控制，关于卡片不在其中
  assert.match(mainJs, /id="settings-lock"[^>]*hidden/);
  assert.match(mainJs, /id="settings-form"[^>]*hidden/);
});

test("版本行：显示当前版本，GitHub 行：标签 + 看得见的地址", () => {
  assert.match(mainJs, /<span class="about-label">版本<\/span><span id="app-version">/);
  assert.match(mainJs, /<span class="about-label">GitHub<\/span>/);
  // 地址本身写在链接文本里，不是只放一个图标
  assert.ok(mainJs.includes(`>${GITHUB_URL}</a>`), "GitHub 地址应作为链接文本完整可见");
  // 点一下在系统浏览器里打开：Capacitor iOS 会把 target=_blank 的链接
  // 交给 UIApplication.shared.open（系统 Safari），桌面浏览器则开新标签页
  assert.ok(
    mainJs.includes(`href="${GITHUB_URL}" target="_blank" rel="noopener"`),
    "GitHub 链接应为 target=_blank 的外链",
  );
});

test("版本号从 package.json 注入，不手写死数字", () => {
  // vite.config.js 从 package.json 读 version，define 成 __APP_VERSION__
  assert.match(viteConfig, /readFileSync\(new URL\('\.\/package\.json', import\.meta\.url\)/);
  assert.match(viteConfig, /__APP_VERSION__:\s*JSON\.stringify\(pkg\.version\)/);
  // main.js 用注入值填版本行，带 typeof 守卫（define 缺失时不报错）
  assert.match(mainJs, /typeof __APP_VERSION__ !== "undefined"/);
  assert.match(mainJs, /appVersionEl\.textContent = __APP_VERSION__/);
  // 注入源与包版本一致：当前应为 3.0.0
  assert.equal(pkg.version, "3.0.0");
  // main.js 里不出现手写死的版本号文本
  assert.doesNotMatch(mainJs, />1\.2\.5</);
});

test("关于卡片样式：两行对齐，GitHub 长地址可断行", () => {
  assert.match(css, /\.settings-about\s*\{[^}]*margin-top:\s*12px/s);
  assert.match(css, /\.settings-about \.about-row\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.settings-about \.external-link\s*\{[^}]*word-break:\s*break-all/s);
});
