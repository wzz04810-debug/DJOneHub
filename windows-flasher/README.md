# DJOneHub Windows Flasher

`0.1.0` 是面向 Windows x64 的 QDC507 首次部署测试工具。它以 Electron 封装 WebUSB 刷写流程，不要求普通用户安装 Node.js、打开网页或手动选择任意固件。

## 安全设计

- 只接受 USB ID `2c7c:0125` 的 QDC507 模块。
- 只提供固定的 `0.3.15-first-use` 基线包，加载前同时核对文件名、文件大小与 SHA-256。
- 用户界面没有私钥导入、任意本地固件、降级、无备份修复或 Bootstrap rootfs 写入入口。
- 设备不匹配、签名异常、通话中、空间不足或回滚无法确认时，流程会停止并保留脱敏日志。

这是测试版。Windows 实机矩阵尚未完整公开验证，不能用于量产、维修交付或未经授权的设备。

## 本地开发

```sh
npm ci
npm test
npm run build
```

发布构建前，把经过人工验证的首次部署包放到：

```text
resources/firmware/module-update-0.3.15-first-use.djupdate
```

该文件必须与 `resources/firmware/baseline.json` 中的大小和 SHA-256 一致；二进制被 Git 忽略，不能提交。

构建 Windows x64 便携版：

```sh
npm run dist:win
```

产物写入 `dist/DJOneHub-Windows-Flasher-0.1.0-beta.exe`。构建机需要在发布前自行验证 `dist/win-unpacked/resources/firmware/` 中的文件仍与基线摘要一致。

## 用户教程

下载、驱动、刷写与验证步骤见仓库的 [Windows 刷机工具使用教程](../docs/WINDOWS_FLASHER_APP.md)。

## 许可与边界

仅操作你拥有授权的 QDC507/DJI 4G 模块。本工具不提供绕过认证、替换整个 USB 复合设备驱动、私钥重签或任意固件写入能力。
