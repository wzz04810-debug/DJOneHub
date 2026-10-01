# DJOneHub Windows Flasher 0.1.0 Beta

这是 Windows x64 的 QDC507 首次部署测试工具。它是独立于 `v1.0.0` 的测试预发布，不替代 iPhone/iPad 客户端的正常模块更新流程。

## 鸣谢

- 感谢小红书博主 [「小吴折腾AI」](https://xhslink.cn/o/70Ecv4YqEvk) 的一同开发。
- 感谢 [XUXU](https://xhslink.cn/o/AYJ2PKK9tyj) 的大力支持。
- 感谢 [Jamie（@没错jamie就是我）](https://xhslink.cn/o/2CbGt9pN3AB) 与 [JieDen](https://xhslink.cn/o/5WQkSOfgE3i)。

## 下载与校验

附件：`DJOneHub-Windows-Flasher-0.1.0-beta.exe`

```text
SHA-256  1eaf4ee5b723b07ad22483ad5801dd51b82f68f8f79eb99f0135032ab52c83c4
```

Windows PowerShell 校验命令：

```powershell
Get-FileHash .\DJOneHub-Windows-Flasher-0.1.0-beta.exe -Algorithm SHA256
```

## 本版范围

- 仅支持 Windows 10/11 x64。
- 只会自动选择 USB ID 为 `2c7c:0125` 的单个 QDC507 模块。
- 内置 `0.3.15-first-use` 首次部署包，并在显示刷写按钮前验证固定 SHA-256：

  ```text
  ba1607371c925a466f645b9949a9aad7709c7d418e10f4ddb93d28f2e89bbca1
  ```

- 不提供任意固件、私钥、降级、无备份修复或 Bootstrap rootfs 写入入口。

## 已知限制

这是未签名测试包，Windows 可能显示 SmartScreen“未知发布者”提示。不要关闭安全保护或绕过系统安全机制；不能确认 Release 来源或 SHA-256 时，请停止使用。

尚未完成 Windows 实机矩阵的完整公开验证，不适用于量产、维修交付或未经授权的设备。使用前请阅读 [Windows 刷机工具使用教程](../WINDOWS_FLASHER_APP.md)。

## 免责声明

仅用于学习、研究与合法的非商业用途。使用者必须拥有设备及其中数据的操作授权；不得用于侵权、未经授权访问设备、规避安全限制或违反运营商及平台规则的行为。
