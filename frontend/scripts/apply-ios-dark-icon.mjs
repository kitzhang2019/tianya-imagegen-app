// 把 iOS 深色模式 App 图标补进 asset catalog。
//
// 背景：@capacitor/assets v4 没有 icon-dark 这种输入（只有 logo-dark /
// splash-dark），它每次 generate --ios 都会用 frontend/assets/icon.png
// 重建 AppIcon.appiconset，把手动加的深色变体洗掉。所以深色图标不靠
// generate，而是靠这个脚本在 generate 之后补：
//   1. 把 frontend/assets/icon-dark.png 拷进 appiconset，叫
//      AppIcon-512@2x-dark.png；
//   2. 把 Contents.json 写成亮色 + 深色两条（luminosity appearances）。
// iOS 18+ 会按系统外观自动切换；更老的 iOS 忽略深色条目，只用亮色。
// 幂等：重复跑结果一样。CI 在 "Generate app icons and splash" 之后跑它，
// 本地改完图标也跑一次再提交。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'assets');
const setDir = join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
const darkSrc = join(assetsDir, 'icon-dark.png');
const darkDst = join(setDir, 'AppIcon-512@2x-dark.png');
const contentsPath = join(setDir, 'Contents.json');

if (!existsSync(darkSrc)) {
  console.error(`missing dark icon source: ${darkSrc}`);
  process.exit(1);
}
if (!existsSync(join(setDir, 'AppIcon-512@2x.png'))) {
  console.error('light icon missing in appiconset — run `npx @capacitor/assets generate --ios` first');
  process.exit(1);
}

copyFileSync(darkSrc, darkDst);

const contents = {
  images: [
    {
      // 亮色条目不带 appearances（就是默认图标，和 @capacitor/assets
      // 生成的格式一字不差）。之前给亮色也加了 luminosity:light，
      // actool 直接把两条都当成未分配（unassigned），编出来的包没有
      // 可用图标，装上就是白色网格——v0.8.9 的教训。
      idiom: 'universal',
      size: '1024x1024',
      filename: 'AppIcon-512@2x.png',
      platform: 'ios',
    },
    {
      idiom: 'universal',
      size: '1024x1024',
      filename: 'AppIcon-512@2x-dark.png',
      platform: 'ios',
      appearances: [{ appearance: 'luminosity', value: 'dark' }],
    },
  ],
  info: { author: 'xcode', version: 1 },
};
writeFileSync(contentsPath, JSON.stringify(contents, null, 2) + '\n');
console.log('iOS dark app icon applied: AppIcon-512@2x-dark.png + Contents.json (light/dark)');
