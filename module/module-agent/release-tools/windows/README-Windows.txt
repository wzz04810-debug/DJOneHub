DJOneHub QDC507 模块 Windows 首次部署包
=======================================

这是作者 macOS 首次部署包 (install.command) 的 Windows 等价版本。
部署到模块里的内容、逐项 SHA-256 校验、失败回滚逻辑与 macOS 版完全一致,
区别只有三点: 底层传输从 libusb 换成 Google 官方 platform-tools 的 adb.exe,
附带自动下载 platform-tools 的 .bat 引导脚本, 以及把"写 USB 组合 + 部署"
合成一个双击即走的入口 Flash-All.bat (分步脚本仍然保留, 用于排错)。

使用条件
--------
- Windows 10 / 11 (x64 / arm64 均可)。
- Python 3.8 或更高版本 (https://www.python.org/downloads/windows/ , 安装时勾选
  "Add python.exe to PATH")。其余依赖由脚本自动安装:
    * Android platform-tools (adb.exe) -> 自动从 dl.google.com 下载
    * pyserial -> 自动用 pip 安装 (仅装到当前用户)
- 模块通过支持数据传输的 USB 线直连电脑。若 Windows 没有出现 COM 口,
  请先安装模块 (Quectel MDM9607 平台) 的 Windows 串口驱动。
- 已验证的模块: Baiwang QDC507, USB ID 2c7c:0125, 固件 QDC507GLEFM21_*。

使用步骤 (推荐: 一键)
---------------------
0. 把整个压缩包全部解压到一个目录 (不要在压缩包里直接双击), 路径不要带奇怪符号。
   模块用支持数据传输的 USB 线直连电脑。

1. 双击 Flash-All.bat
   一个脚本跑完全部流程, 中间只需要按一次确认 (输入 Y 回车):
       a. 只读预检: 连上模块 AT 串口, 确认是 QDC507, 打印型号/固件/当前 USB 组合,
          并把原组合备份到 usbcfg-rollback\ (这一步不写入任何内容);
       b. 写入作者客户端用的目标组合 0x2C7C,0x0125,1,1,1,1,1,1,1, 并立刻回读;
          回读不一致 -> 立即写回原值, 并且不重启;
          顺手把 USB 网络模式写成 usbnet=1 (ECM): 作者部署器要求组合里有 ecm, 而
          usbnet=0 的模块只有 rmnet, 会静默 exit 43 (原值也在备份里, 回滚一起写回);
       c. 回读一致后才重启模块 (AT+CFUN=1,1), 等它重新枚举并再次校验;
       d. adb 看到模块后复用作者原始部署器永久部署 Agent, 逐个打印 SHA-256 校验。
   当前组合已经是目标值、且 adb 已经能看到模块时, b/c 会自动跳过, 不会白白多重启一次。

   可选参数:
       Flash-All.bat --yes           不问确认, 全自动跑完 (无人值守)
       Flash-All.bat --force         即使组合已是目标值也重新写入并重启 (adb 看不到模块时用)
       Flash-All.bat --port COM8     串口认不出来时手工指定 AT 口

   任何一步失败都会立刻停下并打印原因, 不会带着异常状态继续往下刷:
       exit 3  AT 串口找不到, 或重启后没重新枚举 -> 换支持数据的 USB 线、装串口驱动, 或用 --port
       exit 4  当前 USBCFG 解析不出来             -> 多半不是 QDC507, 或 AT 口选错
       exit 6  模块正在通话                       -> 挂断后重跑
       exit 7  QADBKEY 解锁被拒                   -> 该固件不支持这种解锁方式, 请停下
       exit 8  adb 在 120 秒内没发现模块          -> 重新插拔后重跑, 或加 --force
       其他非 0                                    -> 看终端输出, 部署器会打印具体原因

2. 部署成功后, 把模块插到已安装并授权 DJOneHub 的 iPhone / iPad 上使用。

使用步骤 (手动分步, 排错用; 与一键流程完全等价)
------------------------------------------------
1. 双击 Setup-Only.bat
   自动下载 platform-tools 到本目录的 platform-tools\, 并安装 pyserial。
   这一步不碰模块, 只准备本机环境。第一次跑 Flash-All.bat / Deploy-Module.bat 时也会自动做同样的事。

2. 双击 Write-USBConfig.bat
   默认是"只读预检": 连上模块的 AT 串口, 打印型号/固件/当前 USB 组合并备份,
   不写入任何内容。确认打印出来的确实是 QDC507 后, 再执行:
       Write-USBConfig.bat --write
   它会写入作者客户端使用的目标组合 0x2C7C,0x0125,1,1,1,1,1,1,1, 然后:
       - 先备份原组合与 usbnet 模式到 usbcfg-rollback\ (时间戳 + latest 各一份)
       - 写入后立刻回读; 回读不一致 -> 立即写回原值, 并且不重启
       - 回读一致才重启 (AT+CFUN=1,1), 重启后重新校验
       - 重启后仍不是目标值 -> 自动恢复原配置
   写入前会拒绝在通话中写入。串口不认识时可用 --port COM8 指定。

3. 等模块重新枚举 (约 10-30 秒), 双击 Deploy-Module.bat
   复用作者原始部署器 module-agent\deploy-qdc507-agent.py, 只把传输层换成 adb.exe。
   模块身份校验 (uid=0 / armv7l / Linux 3.18.44)、USB 组合校验、原厂服务 PID 校验、
   通话校验、目标路径摘要校验、原子 mv、/data 空间校验、失败自动回滚全部保持作者原样。
   部署前还会只读复查模块 USB 组合: 缺 serial/audio 就按作者的做法把 gadget 补回 Mac 完整
   模式后再部署; 缺 ecm 则不再硬改 gadget (那是模块 usbnet=0 造成的, 只有 AT 侧能改),
   直接报清楚原因并提示重跑 Flash-All.bat (作者部署器在组合不符时只回 exit 41/42/43, 一句话都不打印)。
   部署完成时终端会打印每个文件在模块内的 SHA-256 校验结果。

4. 部署成功后, 把模块插到已安装并授权 DJOneHub 的 iPhone / iPad 上使用。

回滚
----
- 恢复 USB 组合与 usbnet 模式 (回到写入前状态):
      双击 Restore-USBConfig.bat
      或 Write-USBConfig.bat --restore
  默认使用 usbcfg-rollback\usbcfg-latest.json; 也可用
      Restore-USBConfig.bat --restore-file "D:\...\usbcfg-before-20260930-123000.json"
- 移除已部署的 Agent 与启动钩子 (模块恢复成空白状态, 适合首次部署的模块):
      platform-tools\adb.exe shell "set -e; /etc/init.d/djonehub_agent stop || true; mount -o remount,rw /dev/ubi0_0 /; rm -f /etc/rc5.d/S99zz_djonehub_agent /etc/init.d/djonehub_agent; rm -rf /data/djonehub; sync; mount -o remount,ro /dev/ubi0_0 /"

安全边界
--------
- Write-USBConfig.bat 默认只读, 只有显式加 --write 才会写入模块。
- Flash-All.bat 自己不含任何写模块的代码, 只是按顺序调用上面两个脚本, 并且任何一步
  失败都会立刻停止, 不会在异常状态下继续执行下一步。
- 每一步都可回滚: USB 组合有 usbcfg-rollback\ 备份, 部署有失败自动回滚。
- 本包不会刷写模块固件、不会覆盖原厂服务; 部署前后原厂 ql_manager_server 不被重启。
- iPhone / iPad 上没有 ADB 与内核写入权限, 首次刷写必须在电脑 (macOS 或 Windows) 上完成。

常见问题
--------
- "未找到 QDC507 AT 串口": 模块没被识别为 AT 口。换一根支持数据的 USB 线,
  装好串口驱动, 或用 --port 指定; 已经写入过 USB 组合的模块 AT 口会变成另一个 COM 号。
- "adb 未发现已授权的模块设备": USB 组合还没写成目标值, 或模块还没重新枚举;
  先重跑 Flash-All.bat (它会在需要时自动补做写组合这一步)。
- "模块 shell 未返回退出状态": 作者部署器内的检查失败时会直接 exit, 所以没有任何输出;
  报错里会附带模块当前的 USB ID 与 functions。functions 里没有 ecm 说明模块是
  usbnet=0 (RMNET) 模式: 重新插拔后重跑 Flash-All.bat 即可 (它会把 usbnet 改成 1 再重启);
  单跑 Deploy-Module.bat 修不好, 因为 ecm 由模块固件重启后的组合提供。
- 杀毒软件报 module-agent\deploy-qdc507-agent.py: 该文件只是 Python 脚本,
  会被某些安全软件误判; 请把本目录加入信任区后重新解压。
- 只想看当前状态不想部署: 直接跑
      powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Action usbcfg
  以及
      powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Action deploy --inspect-startup-hooks

限制: 仅限 PolyForm Noncommercial License 允许的非商业用途。
DJOneHub 是非官方第三方项目, 与 DJI / Quectel / 运营商 / eSIM 供应商均无关联。
