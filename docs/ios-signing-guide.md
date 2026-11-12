# iOS 签名与安装指南（iPhone 16 Pro，未签名 IPA）

> 适用：从 GitHub Actions 构建产物 `tianya-imagegen-ios-unsigned` 里下载的
> `tianya-imagegen-unsigned.ipa`。这是一个**未签名**的包，iPhone 不能直接安装，
> 必须先用你自己的免费 Apple ID 重新签名再装机。
> 全程不需要 Mac、不需要付费开发者账号（$99/年）、不需要越狱。
>
> 本 App 没有后端、不联网到任何私人服务器：它直接在手机上调用 Kaggle API
> 生图，Kaggle Token 是你在 App 设置里自己填的、只存在手机本地。

最后更新：2026-11-13。本文改编自之前管理站 App（vps-manager）的同名指南，
关键事实（7 天有效期、3 个 App 上限、信任证书路径等）在多个独立来源一致；
未在真机上实测，个别界面文字可能随工具版本略有出入，以工具实际界面为准。

---

## 1. 先理解限制（免费 Apple ID）

| 项目 | 免费 Apple ID | 付费开发者账号（$99/年） |
|---|---|---|
| 签名有效期 | **7 天**，到期后 App 打不开，需重新签名 | 1 年 |
| 同时安装的侧载 App 数 | **最多 3 个** | 不限 |
| 每周可注册的新 App ID | 约 10 个 | 不限 |
| 推送通知 | 不可用 | 可用 |
| 费用 | 免费 | $99/年 |

- 7 天到期是苹果对免费账号的限制，不是工具的限制；AltStore/Sideloadly 都绕不过。
- 本 App 不用推送通知，所以免费账号完全够用，只是**每周要续签一次**。
- 建议用一个**备用 Apple ID**（不是主力 iCloud 账号）来签名——签名用的 Apple ID
  和手机上登录的 iCloud 账号可以不同。工具只用它向苹果申请一个免费开发证书，
  不会同步你的照片、通讯录等 iCloud 数据。

## 2. 你需要准备的东西

- iPhone 16 Pro（iOS 18 或 iOS 26 均可；AltStore 称支持 iOS 12.2–26）
- Windows 电脑（你的主力机即可）+ 一根数据线（USB-C）
- 免费 Apple ID 一个（有双重认证也没关系，按提示输入验证码即可）
- 从 GitHub 下载的 `tianya-imagegen-unsigned.ipa` 文件
- 电脑和手机连**同一个 Wi-Fi**（用于 AltStore 的自动续签；Sideloadly 也可用 Wi-Fi 安装）

## 3. 方法 A（推荐）：AltStore + AltServer —— 装一次，每周自动续签

AltStore 分两部分：电脑上的 **AltServer**（负责签名）和手机上的 **AltStore**
App（装 IPA、自动续签）。装好之后每周只要电脑开着、手机连着同一 Wi-Fi，
AltStore 会在证书到期前自动重新签名，不用你每次手动操作。

### 3.1 电脑上安装 AltServer

1. 打开 https://altstore.io ，下载 **AltServer for Windows**，解压后运行 `setup.exe` 安装。
2. **再装 iTunes 和 iCloud（关键一步）：**
   - 必须从 **苹果官网**下载（apple.com），**不要用微软商店（Microsoft Store）版**。
     多个来源一致指出 AltServer 依赖苹果官网版自带的设备驱动（Bonjour + USB 驱动）；
     也有个别来源说商店版也行，但官网版是最稳妥的。
   - 下载地址：苹果官网搜索 "iTunes for Windows" 和 "iCloud for Windows"，或直接在
     https://support.apple.com/zh-cn/108937 之类的官方页面找下载链接。
   - 装好后**打开一次 iTunes**，登录你的 Apple ID（和签名用的可以是同一个，也可以不同）。
3. 把 iPhone 用数据线连上电脑，手机上弹出「信任此电脑？」时点**信任**，输入锁屏密码。
4. 在 iTunes 里点手机图标 → 勾选 **「通过 Wi-Fi 与此 iPhone 同步」**（启用 Wi-Fi 同步，
   之后 AltStore 才能无线续签）→ 点「应用/同步」。
5. 启动 AltServer：它平时只在任务栏右下角托盘区显示一个小图标（点小箭头展开可见）。
   如被 Windows 防火墙拦截，点**允许访问**。

> 2026 年 10 月曾出现苹果侧认证故障（错误 1100 / -22410），AltServer for Windows
> 1.7.3 版已修复。如果你登录时报这类错误，先把 AltServer 更新到最新版再试。

### 3.2 手机上安装 AltStore App

1. 确认手机已解锁、连着电脑。
2. 点电脑托盘区的 AltServer 图标 → **Install AltStore** → 选择你的 iPhone。
3. 输入签名用的 Apple ID 和密码（可能要求输入双重认证验证码），等待安装完成。
4. 手机上出现 AltStore 图标后先别急着打开，先去信任证书：
   **设置 → 通用 → VPN 与设备管理** → 找到你的 Apple ID（显示为你的邮箱）→ 点**信任**。
   - iOS 16 及以上：第一次打开侧载 App 前，还需去
     **设置 → 隐私与安全性 → 开发者模式 → 打开**，按提示重启手机。
     （如果没有「开发者模式」这一项，说明系统还没检测到侧载 App，装完 AltStore 再看。）
5. 打开 AltStore App，用**同一个 Apple ID**登录。

### 3.3 用 AltStore 安装生图 App

1. 把 `tianya-imagegen-unsigned.ipa` 传到手机上（微信文件传输助手、QQ、网盘、数据线拷到手机存储，任选一种）。
2. 在手机上打开 AltStore → **My Apps** → 点左上角 **+** → 找到 `.ipa` 文件选中。
   AltStore 会用你的 Apple ID 重新签名并安装（第一次约 1–2 分钟）。
3. 装好后桌面出现「天涯生图」图标，点开即用。
   - 首次打开如果闪退或提示「未受信任的开发者」，回到
     **设置 → 通用 → VPN 与设备管理** 再信任一次该 Apple ID 证书。

### 3.4 每周续签（自动）

- 保持 AltServer 在电脑上运行，手机和电脑连同一 Wi-Fi，AltStore 会自动在到期前续签。
- 如果某天打开 App 提示过期/闪退：手机连上电脑（USB 或同一 Wi-Fi），打开 AltStore →
  **My Apps** → 点 App 旁边的剩余天数 → **Refresh**，即可手动续签。
- 续签失败最常见的原因：电脑关机了、AltServer 没运行、手机和电脑不在同一 Wi-Fi、
  或开了 VPN / iCloud 专用代理（Private Relay）。逐项排查即可。

## 4. 方法 B（最简单，一次性）：Sideloadly

如果你不想装 AltStore 整套东西、只想快速装一次，用 Sideloadly：

1. 打开 https://sideloadly.io ，下载 **Sideloadly for Windows**（2026 年最新版为 v0.60+，支持 iOS 18+ 和 Wi-Fi 安装）并安装。
2. 同方法 A 的 3.1 第 2 步：从苹果官网装 iTunes 和 iCloud（Sideloadly 同样需要苹果驱动）。
3. 手机连电脑，点**信任此电脑**。
4. 打开 Sideloadly：把 `tianya-imagegen-unsigned.ipa` **拖进窗口**，在 Apple ID 栏输入签名用的
   Apple ID，点 **Start**，按提示输入密码和双重认证验证码。
5. 等进度条走完，手机桌面出现 App。同样要去
   **设置 → 通用 → VPN 与设备管理 → 信任你的 Apple ID** 才能打开。
6. **缺点**：没有自动续签。7 天到期后要重复第 4–5 步重新装一次。
   优点：步骤最少，不用在手机上常驻 AltStore。

> 还有一个叫 SideStore 的工具，配对一次后可在手机上直接续签、不需要电脑常开。
> 但它配置更复杂（需先用电脑配对 + 开一个本机 VPN 做续签通道），先用 AltStore，
> 等用顺手了再考虑也不迟。

## 5. 装好之后：填 Kaggle Token

打开「天涯生图」→ 右上角设置 → 填 **Kaggle 用户名** 和 **Kaggle API Token**：

- 到 Kaggle 网站 → 头像 → Settings → API Tokens → 点 **Generate New Token**，
  生成的那串以 KGAT 开头的 Token，复制后粘贴到 App 设置里，保存。
- Token 只存在手机本地，不上传到任何服务器。
- 画廊推送密钥是可选的：不填也能生图、看图、保存、分享；填了之后每次出图
  还会自动推一份到天涯画廊。

## 6. 常见问题

| 现象 | 原因 / 做法 |
|---|---|
| 打开 App 闪退 / 提示「无法验证完整性」 | 签名过期了（超过 7 天）。按 3.4 节续签或用 Sideloadly 重装 |
| 提示「未受信任的开发者」 | 没信任证书：设置 → 通用 → VPN 与设备管理 → 点你的 Apple ID → 信任 |
| AltServer 找不到手机 | 数据线没插好 / 没点「信任此电脑」/ iTunes 没装官网版 / 防火墙拦了 AltServer；换线、重装官网版 iTunes 后重试 |
| 登录 Apple ID 报错 1100 / -22410 | AltServer 版本太旧，更新到最新版；再不行退出 iTunes 重新登录一次，保持 iTunes 运行 |
| AltStore 续签失败 | 电脑和手机不在同一 Wi-Fi；AltServer 没运行；开了 VPN 或 iCloud 专用代理，先关掉再试 |
| 提示已达 3 个 App 上限 | 免费账号最多 3 个侧载 App。删掉一个不用的，或换一个 Apple ID 签名 |
| 提交后报 401 | Kaggle Token 过期或被撤销了。到 Kaggle 重新生成一串新的，再到 App 设置里更新 |
| 提交后报 403 | Kaggle 账号还没做手机号验证。在 Kaggle Settings 里验证手机号后，API 才能提交 |
| 任务一直在「准备」不走 | MOSS 模型数据集还没在 Kaggle 上就绪，或网络暂时不通。等一会儿重试；一直这样就检查 Token |
| 每次打开都要重新填 Token | 正常现象：侧载 App 的数据保存在 App 内，重装后数据会丢。Token 只存在手机本地，丢了重新填一次即可 |

## 7. 安全提醒

- 只从我们自己的 GitHub Actions 产物页下载 IPA，不要从第三方网站下所谓「签名版」。
- AltStore / Sideloadly 只从官网（altstore.io / sideloadly.io）下载，警惕仿冒站。
- 签名用的 Apple ID 密码只在 AltServer / Sideloadly 的官方弹窗里输入，不要发给任何人、
  不要填到任何网页里。
- Kaggle Token 只填进 App 设置里，不要发给任何人、不要贴到聊天记录里。
- 付费签名服务（号称「永久不掉签」的企业证书）不在考虑范围：证书随时可能被
  苹果吊销，且要把 Apple ID 交给陌生服务，风险高。
