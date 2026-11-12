# 天涯生图 App（Capacitor）

只做生图、只调云端（Kaggle 直连）的手机 App。用户在本地签名安装（AltStore / Sideloadly），不走 Cloady 托管、不走 PWA。

## 这是什么

- 一个 Capacitor 8 手机 App（WebView + 原生壳），iOS / Android 共用同一套前端代码。
- App 内直接调用 Kaggle API（Capacitor 原生 HTTP，绕过 WebView 的 CORS 限制），提交 ComfyUI notebook 到 Kaggle 免费 T4 上跑图，跑完把图下载回手机显示。
- 四个模型：MOSS（Moody Moss Mix V3.3，默认）、Qwen Image 2.1 Turbo、Krea2 Turbo、Z-Image Turbo。尺寸表与管理站一致（MOSS 2.2x，Qwen/Krea2/Z-Image 2.1x），每次提交换新随机种子，Kaggle 最多 2 个并发 GPU 会话（多了在 App 内排队）。
- 生图完成后，如果在设置里填了画廊推送密钥，会同时把图推到天涯画廊（与管理站同一个 /upload.php 协议）。
- 管理站本身不动。这个 App 只是同一套 Kaggle 直连逻辑的另一个入口。

## 仓库结构

```
tianya-imagegen-app/
  frontend/                 # Capacitor App（Vite + 原生 JS，无框架）
    src/
      main.js               # 界面与接线
      styles.css            # 手机端样式
      lib/
        kaggle.js           # Kaggle API 客户端（push / 状态 / 输出列表 / 下载）
        notebook.js         # notebook 模板打补丁（提示词 base64、尺寸、种子）
        jobs.js             # 任务存储、轮询引擎、2 并发排队
        gallery.js          # 画廊推送（/upload.php）
    public/notebooks/       # 四个 Kaggle notebook 模板（与管理站同一套）
    capacitor.config.json   # appId com.tianya.imagegen， appName 天涯生图
    ios/ android/           # 原生工程（npx cap add 生成，构建时同步）
  .github/workflows/        # GitHub Actions：iOS 未签名 IPA、Android Debug APK
  docs/                     # 签名与安装指南
```

## 构建

```sh
cd frontend
npm install
npm run build          # 生成 dist/
npx cap sync           # 同步到 ios/ 与 android/
```

iOS 未签名 IPA 与 Android Debug APK 由 GitHub Actions 构建（见 .github/workflows/），
推送到 main 分支或在 Actions 页手动触发，产物在构建记录的 Artifacts 里下载。

## 安装（用户在本地完成）

- iPhone：见 docs/ios-signing-guide.md —— 用 AltStore（推荐，每周自动续签）或
  Sideloadly，把 `tianya-imagegen-unsigned.ipa` 用自己的免费 Apple ID 重新签名后安装。
  免费账号签名有效期 7 天，到期续签一次即可。
- Android：见 docs/android-sideload-guide.md —— 下载 `app-debug.apk` 直接安装。

## 首次使用

打开 App → 右上角设置 → 填 **Kaggle 用户名** 和 **Kaggle API Token**（Kaggle 设置页
API Tokens 栏点 Generate New Token 生成的那串以 KGAT 开头的 Token），保存。
Token 只存在手机本地（Capacitor Preferences），不上传到任何服务器。
画廊推送密钥是可选的：不填也能生图、看图、保存、分享，只是不会自动推到画廊。

Kaggle Token 可能几个小时就过期：过期后提交会报 401，到 Kaggle 重新生成一串新的，
再到 App 设置里更新即可（与管理站那边的做法一样）。
