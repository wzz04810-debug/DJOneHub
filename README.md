# DJOneHub

DJI 4G 模块的 Mac、iPhone/iPad 与 QDC507 Agent 源码，以及用于诊断和修复 QDC507 USB/QMI/ADB 状态的辅助工具。

## 鸣谢

- 感谢小红书博主 [「小吴折腾AI」](https://xhslink.cn/o/70Ecv4YqEvk) 的一同开发。
- 感谢 [XUXU](https://xhslink.cn/o/AYJ2PKK9tyj) 的大力支持。
- 感谢 [Jamie（@没错jamie就是我）](https://xhslink.cn/o/2CbGt9pN3AB)。
- 感谢 [JieDen](https://xhslink.cn/o/5WQkSOfgE3i)。

## 免责声明

本项目仅用于学习、研究与合法的非商业用途。严禁将本项目、其源码、脚本或发布附件用于任何非法、侵权、规避安全限制、未经授权访问设备或违反运营商及平台规则的行为。使用者应自行确认设备授权范围，并遵守所在地法律法规、运营商协议和第三方平台规则；由不当使用造成的后果由使用者自行承担。

## 支持小店

这是我的微信小程序，售卖咖啡豆和茶叶；如果你喜欢这个项目，欢迎扫码支持，感谢大家。

![咖啡豆与茶叶小程序二维码](docs/assets/coffee-tea-miniprogram-qr.jpg)

当前仓库首发版本为 `v1.0.0`。这是 GitHub 项目版本；各组件保留其真实独立版本，避免发布包与源码版本被错误伪造。

## 项目简介

DJOneHub 面向 DJI 4G 模块的日常连接、通信与维护场景，提供 Mac 与 iPhone/iPad 客户端、QDC507 端 Agent，以及 USB/QMI/ADB 状态诊断和修复工具。项目把客户端界面、模块端服务和维护脚本整理到同一套可审查源码中，便于后续构建、排障与迭代。

## 小白上手：请按这个顺序做

### 先确认你手上的东西

开始前请确认以下四项都具备：

1. 自己有权操作的 DJI/QDC507 4G 模块，且模块已经完成**首次部署**。
2. 一根确认可传输数据的 USB-C 线；仅充电线无法连接。
3. iPhone 或 iPad（系统需 iOS/iPadOS 16.1 或更高版本）。
4. 自己的 Apple 账号和侧载/重签条件。Release 提供的 IPA 未签名，不能双击或直接安装。

> **重要：**本仓库提供的 `module-update-0.3.21.djupdate` 是已部署模块的更新包，不是空白模块的首次刷机包。模块尚未首次部署时，请不要自行反复刷写、执行 ADB 修复或套用网上未知脚本。

### 第一步：下载正确的文件

打开 [v1.0.0 Release](https://github.com/wzz04810-debug/DJOneHub/releases/tag/v1.0.0)，按设备下载其中一个 IPA：

| 你的设备 | 下载文件 |
| --- | --- |
| iPhone | `DJOneHub-iPhone-v0.7.6-build42-unsigned.ipa` |
| iPad | `DJOneHub-iPad-v0.7.6-build42-unsigned.ipa` |

不要下载错设备版本；也不要把 `.djupdate` 当作 iPhone/iPad App。

### 第二步：给 IPA 签名并安装

下载的 IPA 是**未签名包**。请使用你信任的侧载工具，并使用**自己的** Apple 账号/开发者证书完成签名后再安装；不要使用来路不明的企业证书、共享证书或他人提供的已签名 IPA。

安装失败时，先检查这三项：

1. 是否下载了对应 iPhone/iPad 的 IPA。
2. 是否已用自己的证书成功重签。
3. 设备是否允许该签名对应的开发者 App 运行。

签名、证书或侧载工具本身的问题与 DJOneHub 无关；不要为了“绕过安装”关闭系统安全保护。

### 第三步：连接模块

1. 先确认模块不在通话中，供电稳定。
2. 用数据线将已首次部署的模块直接接入 iPhone/iPad；排障时先不要使用扩展坞。
3. 打开 DJOneHub，按系统提示允许麦克风、通讯录等权限；不需要的权限可暂不允许。
4. 等待应用检测模块。正常情况下，移动端会通过模块的 USB 网络访问 `192.168.225.1:7575`。
5. 先查看模块状态与网络状态，确认正常后再使用短信、通话、GPS 或其他功能。

如果没有连接成功：先换一根数据线、重新插拔、关闭并重新打开 App；仍不行时先确认模块是否已经完成首次部署。不要一上来就更新固件或运行 ADB 修复脚本。

### 第四步：更新模块（仅已正常连接时）

只有当 App 已正常识别模块、没有通话、供电和 USB 连接稳定时，才进行模块更新。更新前请核对 Release 中的 SHA-256；更新过程中不要拔线、断电、强制退出 App 或重启模块。

更新失败时立即停止继续尝试，保留错误信息并先检查线缆、供电、当前模块版本和首次部署状态。**不要用测试固件替代正式 `0.3.21` 更新包。**

### Mac 用户怎么用

当前 Release 没有提供可直接安装的 Mac DMG；Mac 客户端需要从 `macOS/` 源码构建。新手优先使用上面的 iPhone/iPad 流程；有开发环境的用户再阅读 [macOS 使用说明](macOS/README.md)。

### Windows 电脑刷机页面（第三方候选）

Windows 用户如需为**自己已授权的、尚未部署 Agent 的 QDC507 模块**进行首次刷写，优先使用 [Windows 刷机工具使用教程](docs/WINDOWS_FLASHER_APP.md)。它对应 `DJOneHub-Windows-Flasher 0.1.0` 测试版：仅支持 Windows x64、QDC507 `2c7c:0125` 和固定的 `0.3.15-first-use` 签名基线包。

[Windows 电脑刷机页面](docs/WINDOWS_WEB_FLASHER.md) 与 [Windows 小白使用说明](docs/WINDOWS_FLASH_USAGE.md) 保留为第三方 Chrome/Edge WebUSB 候选方案参考，不是本 Release 的正式附件。不要把两种刷写流程混用。

### 遇到问题先看这里

| 现象 | 建议操作 |
| --- | --- |
| IPA 安装不上 | 这是未签名 IPA 的正常限制；使用自己的证书重签后安装。 |
| App 看不到模块 | 更换数据线、直连设备、重新插拔，并确认模块已首次部署。 |
| 更新包打不开 | `.djupdate` 不是 App，不能在 iPhone/iPad 文件管理器中直接打开。 |
| Windows 需要首次刷写 | 优先查看 [Windows 刷机工具使用教程](docs/WINDOWS_FLASHER_APP.md)；不要替换整个复合 USB 设备的驱动。 |
| 不确定 ADB 脚本能不能运行 | 先不要运行。该脚本仅用于已验证的 QDC507 模块排障，不是新手初始化步骤。 |
| 需要更多技术细节 | 查看 [完整使用教程](docs/USAGE_GUIDE.md)。 |

当前源码基线：

- Mac 客户端与后台：`1.2.10 (19)`
- iPhone/iPad 客户端：`0.7.6 (42)`
- QDC507 Agent：`0.3.21`

## 目录

- `macOS/`：Mac 客户端与后台 Go 源码。
- `iPadOS/`：iPhone/iPad Swift/Xcode 工程。
- `module/`：QDC507 Agent、内核桥接和构建工具。
- `tools/qdc507-legacy/`：独立诊断、配置、USB/QMI/ADB 修复工具的源码与脚本。
- `docs/release/`：本次正式基线的发布说明。
- `docs/USAGE_GUIDE.md`：从构建、连接到排障的使用教程。
- `docs/WINDOWS_WEB_FLASHER.md`：Windows 电脑首次刷机的第三方候选页面与安全边界。
- `docs/WINDOWS_FLASH_USAGE.md`：Windows 用户从校验候选包到刷写后验证的小白使用说明。
- `docs/WINDOWS_FLASHER_APP.md`：DJOneHub Windows `.exe` 测试版的下载、连接与刷写教程。
- `windows-flasher/`：Windows x64 Electron/WebUSB 刷机工具源码；发布包在 Release 附件中提供。
- `release-assets/`：仅在本地暂存、等待上传至私有 GitHub Release 的发布包；二进制不会被 Git 跟踪。
