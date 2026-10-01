# 使用教程

本教程适用于已获得授权、已完成首次部署的 QDC507/DJI 4G 模块。请仅操作自己的设备；修改 USB 配置、更新模块或执行 eSIM 操作前，应先结束通话并备份重要资料。

## 1. 开始前准备

- 使用可传输数据的 USB-C 线缆，并直接连接电脑或 iPhone/iPad；不要把不稳定的扩展坞当作排障基准。
- Mac 端需要 macOS 13 或更高版本；从源码构建 Mac 客户端需要完整 Xcode、Go 和 `pkg-config`。
- iPhone/iPad 客户端要求 iOS/iPadOS 16.1 或更高版本，构建时需要自己的 Apple Developer 签名 Team。
- 首次部署到空白模块所需的设备专用部署资产不在本仓库。没有完成首次部署时，不要把本教程中的更新步骤当作首次刷机方案。

## 2. 验证 Release 附件

下载私有 GitHub Release 的 `module-update-0.3.21.djupdate` 后，先检查摘要：

```sh
shasum -a 256 module-update-0.3.21.djupdate
```

输出必须为：

```text
b3554ad426a623e18dead9b80cfc3356d41f70934b99d0531dcf8dd3e2a17e2b
```

摘要不一致时立即停止，不要更新模块。

## 3. Mac 客户端

### 从源码构建

```sh
cd macOS
scripts/package-macos-universal.sh v1.2.10
scripts/build-dmg-universal.sh v1.2.10
```

构建产物位于 `macOS/dist/`，该目录是本地构建输出，不会提交到 Git。

### 日常连接

1. 使用数据线连接已部署的模块。
2. 打开 DJOneHub，等待其发现模块的 USB 接口。
3. 在设置中确认网络、短信、通话或 GPS 功能状态；首次通话时允许麦克风权限。
4. 模块接回 Mac 后，保持完整 Mac USB 模式；不要在通话中拔插或切换 USB 配置。

若自动发现不到 AT 串口，可在已构建产物目录中指定端口运行：

```sh
./djonehub-macos -port /dev/cu.usbmodemXXXX
```

本地服务默认仅监听 `127.0.0.1:7575`，不会对局域网开放。

## 4. iPhone / iPad 客户端

1. 将已验证的模块包复制到：

   ```text
   iPadOS/DJOneHub-iPad/Resources/module-update.djupdate
   ```

   此文件受 Git 忽略，只用于本地 Xcode 打包。
2. 使用完整 Xcode 打开 `iPadOS/DJOneHub-iPad.xcodeproj`。
3. 选择 `DJOneHub-iPad` scheme，设置自己的 Signing Team，连接真实 iPhone 或 iPad 后构建安装。
4. 在 Mac 客户端的“连接模式”中选择 iPhone/iPad 模式；按提示完成一次物理拔插。
5. 将模块直接接入 iPhone/iPad 的 USB-C 口，允许应用的麦克风、通讯录等必要权限。

移动端通过模块的 CDC ECM 网络访问 `http://192.168.225.1:7575/`。如设备未获得 DHCP 地址，可临时设为 `192.168.225.2/24`；不要手动设置路由器或 DNS，以免覆盖 Wi-Fi 的默认互联网出口。

Windows 电脑为未部署模块进行首次刷写时，请不要套用本节的移动端更新流程。优先参阅 [Windows 刷机工具使用教程](WINDOWS_FLASHER_APP.md)；第三方 WebUSB 方案见 [Windows 电脑刷机页面](WINDOWS_WEB_FLASHER.md)。

## 5. 模块状态与更新

已部署模块可通过客户端进行版本检查和签名更新。更新时务必保持：

- 没有进行中的通话；
- 供电与 USB 连接稳定；
- 模块包 SHA-256 已验证；
- 不中断更新、不强制重启，也不手动删除模块上的运行文件。

在 Mac 上可先进行只读健康检查：

```sh
curl -fsS http://127.0.0.1:7575/api/health
```

预期结果应包含 `"ok":true` 和 Agent 版本 `0.3.21`。健康检查失败时，先排查线缆、供电和 USB 枚举，不要反复刷写。

## 6. USB / ADB 排障

以下 ADB 修复脚本仅适用于 Mac 已识别到、且为已验证 QDC507 的模块。它会先检查通话状态、设备型号和当前 USB 配置，并在写入前创建本地备份。

先做只读检查：

```sh
bash tools/qdc507-legacy/repair-djonehub-adb.sh --check
```

只有检查结果明确提示需要启用 ADB，且确认当前没有通话时，才执行受控修复与重启：

```sh
bash tools/qdc507-legacy/repair-djonehub-adb.sh --restart
```

脚本依赖本地 DJOneHub 后端、`curl`、`openssl`、`osascript` 和 `sed`。未知 USB 配置、非 QDC507 设备、通话中或回读失败时，脚本会拒绝操作；不要绕过这些检查。

Linux 主机上的只读诊断脚本会暂时停止 `openvohive.service`，退出时自动恢复：

```sh
sudo bash tools/qdc507-legacy/diagnose-new-dji-module.sh
```

它需要 `socat`、`qmicli` 与 `systemctl`，仅适用于有相应设备节点的 Linux 主机。

## 7. QDC507 Agent 开发构建

Agent 的正式目标是 Linux ARMv7，构建脚本严格要求 Go `1.24.13`：

```sh
cd module/module-agent
./build-qdc507-agent.sh
shasum -a 256 qdc507-agent
```

生成的 `qdc507-agent` 是本地构建产物，已被 `.gitignore` 排除。部署、启动钩子更新和运行时更新会影响真实模块，仅应在理解相应脚本与回滚流程后执行。

## 8. 常见问题

| 现象 | 先做什么 |
| --- | --- |
| Mac 未识别模块 | 更换确认支持数据的线缆/直连端口；查看 USB 枚举后再指定 AT 串口。 |
| iPhone/iPad 显示无网络 | 确认已切换移动模式并重新插拔；检查是否取得 `192.168.225.x` 地址。 |
| 客户端无法连接 Agent | 先运行健康检查；确认模块已完成首次部署，且地址为 `192.168.225.1:7575`。 |
| ADB 不可用 | 先运行 `--check`，不要直接写 USB 配置。 |
| 更新失败 | 停止操作并保留日志；核对版本、SHA-256、供电和 USB 连接，勿用测试固件替代正式 `0.3.21` 包。 |

## 9. 数据与安全

短信、通话、eSIM、GPS、联系人和录音均可能涉及个人或运营商数据。请遵守当地法律、运营商条款和设备授权范围；不要把日志、设备标识、签名私钥、部署 Token、签名 IPA 或 provisioning profile 上传到 Issue、仓库或截图中。

---

## 鸣谢、支持与免责声明

感谢小红书博主 [「小吴折腾AI」](https://xhslink.cn/o/70Ecv4YqEvk) 的一同开发，感谢 [XUXU](https://xhslink.cn/o/AYJ2PKK9tyj)、[Jamie（@没错jamie就是我）](https://xhslink.cn/o/2CbGt9pN3AB) 与 [JieDen](https://xhslink.cn/o/5WQkSOfgE3i) 的支持。

我的微信小程序售卖咖啡豆和茶叶；如果你喜欢本项目，欢迎扫码支持，感谢大家。

![咖啡豆与茶叶小程序二维码](https://raw.githubusercontent.com/wzz04810-debug/DJOneHub/main/docs/assets/coffee-tea-miniprogram-qr.jpg)

本项目仅用于学习、研究与合法的非商业用途。严禁将本项目、其源码、脚本或发布附件用于任何非法、侵权、规避安全限制、未经授权访问设备或违反运营商及平台规则的行为；不当使用造成的后果由使用者自行承担。
