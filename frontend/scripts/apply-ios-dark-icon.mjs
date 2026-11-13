// 把 iOS 深色 / 透明（tinted）App 图标补进 asset catalog。
//
// 背景：@capacitor/assets v4 没有 icon-dark / icon-tinted 这种输入（只有
// logo-dark / splash-dark），它每次 generate --ios 都会用
// frontend/assets/icon.png 重建 AppIcon.appiconset，把手动加的变体洗掉。
// 所以变体不靠 generate，而是靠这个脚本在 generate 之后补：
//   1. 把 frontend/assets/icon-dark.png 拷进 appiconset，叫
//      AppIcon-512@2x-dark.png（深色模式）；
//   2. 把 frontend/assets/icon-tinted.png 拷进 appiconset，叫
//      AppIcon-512@2x-tinted.png（透明/着色模式；iOS 26 的“透明”外观
//      和“着色”外观都由这张灰度图驱动：亮处上色、暗处沉底）；
//   3. 把 Contents.json 写成亮色 + 深色 + 透明三条。
// iOS 18+ 会按系统外观自动切换；更老的 iOS 忽略深色/透明条目，只用亮色。
// 幂等：重复跑结果一样。CI 在 "Generate app icons and splash" 之后跑它，
// 本地改完图标也跑一次再提交。
//
// 教训（v0.8.9）：亮色条目千万别加 appearances。之前给亮色也加了
// luminosity:light，actool 直接把所有条目都当成未分配（unassigned），
// 编出来的包没有可用图标，装上就是白色网格。亮色条目必须和
// @capacitor/assets 生成的格式一字不差（不带 appearances）。
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'assets');
const setDir = join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
const contentsPath = join(setDir, 'Contents.json');

const variants = [
  { src: join(assetsDir, 'icon-dark.png'), dst: 'AppIcon-512@2x-dark.png', appearance: 'dark' },
  { src: join(assetsDir, 'icon-tinted.png'), dst: 'AppIcon-512@2x-tinted.png', appearance: 'tinted' },
];

for (const v of variants) {
  if (!existsSync(v.src)) {
    console.error(`missing icon source: ${v.src}`);
    process.exit(1);
  }
}
if (!existsSync(join(setDir, 'AppIcon-512@2x.png'))) {
  console.error('light icon missing in appiconset — run `npx @capacitor/assets generate --ios` first');
  process.exit(1);
}

for (const v of variants) {
  copyFileSync(v.src, join(setDir, v.dst));
}

const contents = {
  images: [
    {
      // 亮色条目不带 appearances（就是默认图标）。见文件头教训。
      idiom: 'universal',
      size: '1024x1024',
      filename: 'AppIcon-512@2x.png',
      platform: 'ios',
    },
    ...variants.map((v) => ({
      idiom: 'universal',
      size: '1024x1024',
      filename: v.dst,
      platform: 'ios',
      appearances: [{ appearance: 'luminosity', value: v.appearance }],
    })),
  ],
  info: { author: 'xcode', version: 1 },
};
writeFileSync(contentsPath, JSON.stringify(contents, null, 2) + '\n');
console.log('iOS dark + tinted app icons applied: AppIcon-512@2x-dark.png, AppIcon-512@2x-tinted.png + Contents.json (light/dark/tinted)');
