#!/usr/bin/env python3
"""在 Windows 上复用作者原始部署器的全部安全检查, 只把底层传输换成 adb.exe.

原始 deploy-qdc507-agent.py 一字不改地导入执行; 本文件只做四件事:
  1. 指定打包自带的语音运行时目录 (DJONEHUB_VOICE_RUNTIME)
  2. 用 adb.exe 版 DeployTransport 替换 macOS 的 libusb 版
  3. 部署前只读复查 USB 组合, 缺 serial/audio 就按作者的做法补回来;
     缺 ecm 说明模块是 usbnet=0, 这时"按作者的做法"补不回来, 直接报清楚原因
     (作者部署器组合不符时只回 exit 41/42/43, 没有任何输出)
  4. 把命令行参数原样交给原始 main()

因此模块身份校验(uid=0/armv7l/3.18.44)、USB 组合校验、原厂服务 PID 校验、通话校验、
目标路径摘要校验、原子 mv、/data 空间校验、失败自动回滚全部保持作者原样.

用法(通常由 Deploy-Module.bat 调用):
    python deploy_qdc507_windows.py --confirm-persistent-deploy
    python deploy_qdc507_windows.py --inspect-startup-hooks
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import secrets
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# 作者部署器校验的模块 USB 组合都在这个目录下.
USB_GADGET = "/sys/devices/virtual/android_usb/android0"
MAC_USB_IDS = "2c7c:0125"
# 手机直连模式相对 Mac 完整模式就少这两个功能 (作者 activate_mobile_functions 的 sed
# 只删 serial/audio), 缺了它们作者部署器直接 exit 41 / exit 42.
MAC_FUNCTIONS = ("serial", "audio")
# 作者部署器还要求组合里有 ecm (exit 43), 但 ecm 补不出来: 它由模块固件的 USB
# 网络模式决定 (usbnet=0 时 gadget 里是 rmnet), 只能在 AT 侧用 usbnet 改写.
ECM_FUNCTION = "ecm"
MAC_REPAIR_SCRIPT = "/data/local/tmp/djonehub-mac-profile.sh"
# 部署器构建日期. 排错时先看启动输出里的这一行, 用来确认对方拿到的到底是不是新版分享包
# (同版本号的老包和新包只能靠这行区分).
BUILD_STAMP = "2026-10-01"


def resolve_module_agent_directory() -> Path:
    """定位作者原始部署器: 优先打包布局, 其次源码树布局."""
    packaged = HERE / "module-agent"
    if (packaged / "deploy-qdc507-agent.py").is_file():
        return packaged
    if len(HERE.parents) >= 2:
        source = HERE.parents[1]
        if (source / "deploy-qdc507-agent.py").is_file():
            return source
    raise RuntimeError(
        "找不到 module-agent/deploy-qdc507-agent.py; "
        "请完整解压分享包后再运行, 不要只单独复制本文件."
    )


MODULE_DIR = resolve_module_agent_directory()
ORIGINAL = MODULE_DIR / "deploy-qdc507-agent.py"
VOICE_RUNTIME = MODULE_DIR / "voice-runtime"


def resolve_adb() -> str:
    """定位 adb.exe: 环境变量 > 包内 platform-tools > PATH."""
    candidates = [os.environ.get("DJONEHUB_ADB", "")]
    candidates += [
        str(HERE / "platform-tools" / "adb.exe"),
        str(HERE / "platform-tools" / "adb"),
    ]
    candidates.append(shutil.which("adb") or "")
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise RuntimeError(
        "找不到 adb.exe; 请先运行 Setup-Only.bat 自动下载 platform-tools, "
        "或用环境变量 DJONEHUB_ADB 指定 adb.exe 的完整路径."
    )


class AdbDeployTransport:
    """用 platform-tools 的 adb.exe 提供与 macOS 版相同的 open/shell/push/pull 语义."""

    def __init__(self, _probe_module=None) -> None:
        self._adb = resolve_adb()
        self._serial: str | None = None

    def _run(self, args, timeout_seconds=60):
        command = [self._adb] + (["-s", self._serial] if self._serial else []) + list(args)
        return subprocess.run(command, capture_output=True, timeout=timeout_seconds)

    def _raw_shell(self, command: str, timeout_seconds: int = 30) -> str:
        """不走状态标记的单条 adb shell, 只给只读复查和 USB 组合修复用."""
        completed = self._run(["shell", command], timeout_seconds)
        output = completed.stdout.decode("utf-8", "replace")
        if completed.stderr:
            output += completed.stderr.decode("utf-8", "replace")
        return output

    def open(self) -> None:
        self._run(["start-server"], 60)
        listing = self._run(["devices"], 60).stdout.decode("utf-8", "replace")
        serials = []
        for line in listing.splitlines()[1:]:
            parts = line.split("\t")
            if len(parts) >= 2 and parts[1].strip() == "device":
                name = parts[0].strip()
                serials.append("" if name.startswith("(") else name)
        if not serials:
            raise RuntimeError(
                "adb 未发现已授权的模块设备; 请确认 USB 线支持数据传输、"
                "已用 Write-USBConfig.bat 写入目标 USB 组合, 并在提示时允许 USB 调试."
            )
        if len(serials) > 1:
            raise RuntimeError(f"adb 发现多个设备, 无法确定目标: {serials}")
        self._serial = serials[0] or None

    def close(self) -> None:
        return None

    def read_usb_state(self) -> dict:
        """一次 shell 读完三个只读属性; 缺项给空串, 由调用方判断."""
        output = self._raw_shell(
            f"cd {USB_GADGET} 2>/dev/null || exit 0; "
            "for name in idVendor idProduct functions; do "
            'echo "$name=$(cat $name 2>/dev/null)"; done'
        )
        values = {}
        for line in output.replace("\r", "\n").splitlines():
            name, _, value = line.partition("=")
            values[name.strip()] = value.strip()
        return {
            "vendor": values.get("idVendor", ""),
            "product": values.get("idProduct", ""),
            "functions": values.get("functions", "").replace(" ", ""),
        }

    def repair_mac_profile(self, target_functions: str, timeout_seconds: int = 90) -> None:
        """后台把 gadget 补成 Mac 完整模式 (activate_mobile_functions 的逆操作)."""
        self._push_bytes(mac_repair_script(target_functions).encode("utf-8"), MAC_REPAIR_SCRIPT, 120)
        self._raw_shell(
            f"chmod 755 {MAC_REPAIR_SCRIPT}; start-stop-daemon -S -b -x {MAC_REPAIR_SCRIPT}", 60
        )
        # 写 enable=0 时 USB 会断开重新枚举, 旧 serial 可能失效; 每轮重新发现设备.
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            time.sleep(3)
            self._serial = None
            try:
                self.open()
                if not missing_mac_functions(self.read_usb_state()["functions"]):
                    return
            except Exception:
                continue
        raise RuntimeError("USB 组合修复失败: 模块没有回到 Mac 完整模式; 请重新插拔模块后重跑本脚本.")

    def _push_bytes(self, data: bytes, remote_path: str, timeout_seconds: int = 600) -> None:
        import tempfile

        handle, local_path = tempfile.mkstemp(prefix="djonehub-push-")
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
            completed = self._run(["push", local_path, remote_path], timeout_seconds)
            if completed.returncode != 0:
                raise RuntimeError(
                    "adb push 失败: " + completed.stderr.decode("utf-8", "replace")[-500:]
                )
        finally:
            try:
                os.unlink(local_path)
            except OSError:
                pass

    def shell(self, command: str, timeout_seconds: int = 20) -> str:
        """与 macOS 版逐字相同的包装方式: 随机标记 + 严格退出码, 非零即抛错."""
        token = secrets.token_hex(12)
        marker = f"__DJONEHUB_STATUS_{token}_"
        wrapped = (
            f"{{ {command}; }}; code=$?; " f"printf '\\n{marker}%u__\\n' \"$code\"\n"
        ).encode("utf-8")
        remote = f"/data/local/tmp/.djonehub_cmd_{token}.sh"
        try:
            self._push_bytes(wrapped, remote, timeout_seconds + 120)
            completed = self._run(["shell", f"sh {remote}"], timeout_seconds + 120)
            output = completed.stdout.decode("utf-8", errors="replace")
            if completed.stderr:
                output += completed.stderr.decode("utf-8", errors="replace")
        finally:
            self._run(["shell", f"rm -f {remote}"], 30)
        position = output.rfind(marker)
        if position < 0:
            # 作者部署器遇到组合不符时用 `exit NN` 直接结束命令, 且不打印状态标记,
            # 只看得到一句没有信息量的话; 顺手把模块当前的 USB 组合和是哪个闸门带出来.
            try:
                current = self.read_usb_state()
                state = describe_usb_state(current)
                gate = silent_gate_hint(current["functions"])
            except Exception as error:
                state = f"读取模块 USB 状态也失败: {error}"
                gate = ""
            raise RuntimeError(
                "模块 shell 未返回退出状态 (作者部署器在组合不符时会静默 exit, 且不打印状态标记);\n"
                f"  command={command[:240]!r}\n"
                f"  output={output[-500:]!r}\n"
                f"  模块当前: {state}"
                + (f"\n  作者闸门: {gate}" if gate else "")
            )
        status = int(output[position + len(marker):].split("__", 1)[0])
        clean = output[:position].rstrip()
        if status != 0:
            raise RuntimeError(f"模块命令失败({status}): {clean[-5000:]}")
        return clean

    def push(self, data: bytes, remote_path: str, mode: int) -> None:
        """与 macOS 版相同: 先写调用方给定的临时路径, 权限显式设置."""
        if not remote_path.startswith("/") or "," in remote_path or "\x00" in remote_path:
            raise ValueError("ADB push 目标路径无效")
        self._push_bytes(data, remote_path)
        self.shell(f"chmod {mode:o} {shlex.quote(remote_path)}")

    def pull(self, remote_path: str) -> bytes:
        import tempfile

        if not remote_path.startswith("/") or "\x00" in remote_path:
            raise ValueError("ADB pull 源路径无效")
        handle, local_path = tempfile.mkstemp(prefix="djonehub-pull-")
        os.close(handle)
        try:
            completed = self._run(["pull", remote_path, local_path], 300)
            if completed.returncode != 0:
                raise RuntimeError(
                    "adb pull 失败: " + completed.stderr.decode("utf-8", "replace")[-500:]
                )
            with open(local_path, "rb") as stream:
                return stream.read()
        finally:
            try:
                os.unlink(local_path)
            except OSError:
                pass


def describe_usb_state(state: dict) -> str:
    """把 USB 组合渲染成一行, 给日志和报错用."""
    vendor = state.get("vendor") or "?"
    product = state.get("product") or "?"
    functions = state.get("functions") or "空"
    return f"USB ID={vendor}:{product} (期望 {MAC_USB_IDS}) functions={functions}"


def silent_gate_hint(functions: str) -> str:
    """作者部署器组合不符时只 `exit 41/42/43` 且不打印状态标记, 把是哪个闸门说清楚."""
    items = {item.strip() for item in functions.split(",") if item.strip()}
    if not items & {"diag", "ffs", ECM_FUNCTION}:
        return (
            f"读到的 USB 组合是 {functions!r}, 不像模块的组合 (多半是刚插上还没启动完); "
            "等 10 秒重新插拔模块后重跑本脚本."
        )
    for name, code in (("audio", 41), ("serial", 42), (ECM_FUNCTION, 43)):
        if name not in items:
            if name == ECM_FUNCTION:
                return (
                    f"缺 {name}, 作者部署器静默 exit {code}: 模块是 usbnet=0 (RMNET/传统拨号) 模式; "
                    "重新插拔后重跑 Flash-All.bat, 它会用 AT 把 usbnet 改成 1 (ECM) 并重启模块. "
                    "只跑 Deploy-Module.bat 改不了这个."
                )
            return (
                f"缺 {name}, 作者部署器静默 exit {code}; "
                "重新插拔模块后重跑 Flash-All.bat 会自动补回 Mac 完整组合."
            )
    return "读到的组合其实是齐的, 多半是模块还没启动完; 等 10 秒重新插拔后重跑本脚本."


def missing_mac_functions(functions: str) -> list[str]:
    """作者部署器要求的 serial/audio 里缺了哪些."""
    items = [item.strip() for item in functions.split(",") if item.strip()]
    return [name for name in MAC_FUNCTIONS if name not in items]


def missing_ecm(functions: str) -> bool:
    """模块组合里是不是缺 ecm (usbnet=0 的模块 gadget 里是 rmnet).

    只有读到的组合像模块的组合时才判定, 免得把空读/错读当成缺 ecm.
    """
    items = {item.strip() for item in functions.split(",") if item.strip()}
    return bool(items & {"diag", "ffs"}) and ECM_FUNCTION not in items


def mac_functions(current: str) -> str:
    """在模块现有 functions 上补回 serial/audio 并保持原顺序."""
    items = [item.strip() for item in current.split(",") if item.strip()]
    if "serial" not in items:
        items.insert(items.index("diag") + 1 if "diag" in items else 0, "serial")
    if "audio" not in items:
        items.append("audio")
    return ",".join(items)


def mac_repair_script(target: str) -> str:
    """后台把 gadget 补成 Mac 完整模式; 任何失败都还原, 不会把 USB 留在关闭状态.

    必须 detached 跑: 写 enable=0 时 USB 断开, 前台的 adb shell 会被杀掉, trap 来不及恢复.
    """
    return f"""#!/bin/sh
G={USB_GADGET}
original_functions=$(cat $G/functions)
original_transports=$(cat $G/f_serial/transports)
restore() {{
    echo 0 >$G/enable 2>/dev/null || true
    echo "$original_transports" >$G/f_serial/transports 2>/dev/null || true
    echo "$original_functions" >$G/functions 2>/dev/null || true
    echo 1 >$G/enable 2>/dev/null || true
}}
trap restore 0 1 2 3 15
sleep 3
echo 0 >$G/enable || exit 11
sleep 1
echo tty >$G/f_serial/transports
echo {target} >$G/functions || exit 12
echo 1 >$G/enable || exit 13
sleep 2
trap - 0 1 2 3 15
"""


def ensure_mac_usb_profile(transport) -> None:
    """作者部署器只接受 Mac 完整模式; 不符时先按作者的方式把 gadget 补回来.

    组合不符时作者用 `exit 41/42/43` 直接结束命令且不打印状态标记, Windows 侧
    只会看到一句没有信息量的 "模块 shell 未返回退出状态".
    """
    state = transport.read_usb_state()
    print(f"[USB 预检] {describe_usb_state(state)}", flush=True)
    if f"{state['vendor']}:{state['product']}" != MAC_USB_IDS:
        print(f"[USB 预检] 警告: USB ID 不是 {MAC_USB_IDS}, 请先重跑 Flash-All.bat 写入组合.", flush=True)
    if missing_ecm(state["functions"]):
        # serial/audio 用 gadget 重写就能补回来, ecm 不行: 它由模块固件的 usbnet
        # 模式决定, 只能在 AT 侧写 AT+QCFG="usbnet",1 再重启模块.
        raise RuntimeError(
            f"模块 USB functions 里没有 {ECM_FUNCTION} (当前 {state['functions'] or '空'}): "
            "模块是 usbnet=0 (RMNET/传统拨号) 模式, 作者部署器会静默 exit 43 后失败.\n"
            "  重新插拔模块, 然后重跑 Flash-All.bat: 它会用 AT 把 usbnet 改成 1 (ECM) 并重启模块.\n"
            "  单跑 Deploy-Module.bat 修不好这个: ecm 只能由模块重启后的组合提供."
        )
    missing = missing_mac_functions(state["functions"])
    if not missing:
        return
    items = {item.strip() for item in state["functions"].split(",") if item.strip()}
    if not items & {"diag", "ffs", ECM_FUNCTION}:
        raise RuntimeError(
            f"读到的 USB functions={state['functions'] or '空'} 不像模块的组合, 拒绝改写; "
            "请重新插拔模块后重跑本脚本."
        )
    print(f"[USB 预检] 缺少 {','.join(missing)}, 正在按作者的方式补回 Mac 完整模式 ...", flush=True)
    transport.repair_mac_profile(mac_functions(state["functions"]))
    print(f"[USB 预检] 修复后 {describe_usb_state(transport.read_usb_state())}", flush=True)


def load_original():
    if not ORIGINAL.is_file():
        raise RuntimeError(f"原始部署器缺失: {ORIGINAL}")
    digest = hashlib.sha256(ORIGINAL.read_bytes()).hexdigest()
    spec = importlib.util.spec_from_file_location("djonehub_deploy_original", ORIGINAL)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载原始部署器")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module, digest


def main() -> int:
    os.environ.setdefault("DJONEHUB_VOICE_RUNTIME", str(VOICE_RUNTIME))
    # 先把 adb 路径打印出来, 出问题时用户能一眼看到用的是哪一个 adb.exe.
    print(f"adb: {resolve_adb()}", flush=True)
    module, digest = load_original()
    module.DeployTransport = AdbDeployTransport
    module.load_probe_module = lambda: None
    print(
        f"复用作者原始部署器 (sha256 {digest[:16]}), 传输层 = adb.exe, "
        f"部署器构建 {BUILD_STAMP}",
        flush=True,
    )

    # 只给部署路径加 USB 预检: --inspect-* 必须保持只读, 不能顺手改模块状态.
    original_deploy = module.deploy

    def deploy_with_usb_preflight() -> None:
        transport = AdbDeployTransport()
        transport.open()
        ensure_mac_usb_profile(transport)
        original_deploy()

    module.deploy = deploy_with_usb_preflight
    return module.main()


def self_test() -> None:
    assert mac_functions("diag,ecm,ffs") == "diag,serial,ecm,ffs,audio"
    assert mac_functions("diag,serial,ecm,ffs,audio") == "diag,serial,ecm,ffs,audio"
    assert mac_functions("ffs,ecm") == "serial,ffs,ecm,audio"
    assert mac_functions("audio,diag,ecm") == "audio,diag,serial,ecm"
    assert missing_mac_functions("diag,serial,ecm,ffs,audio") == []
    assert missing_mac_functions("diag,ecm,ffs") == ["serial", "audio"]
    assert missing_ecm("diag,serial,rmnet,ffs,audio")
    assert not missing_ecm("diag,serial,ecm,ffs,audio")
    assert not missing_ecm("")
    assert not missing_ecm("hello")
    assert "usbnet=0" in silent_gate_hint("diag,serial,rmnet,ffs,audio")
    assert "audio" in silent_gate_hint("diag,serial,ecm,ffs")
    assert "还没启动完" in silent_gate_hint("")
    assert "组合其实是齐的" in silent_gate_hint("diag,serial,ecm,ffs,audio")
    assert "diag,serial,ecm,ffs,audio" in mac_repair_script("diag,serial,ecm,ffs,audio")
    print("self-test ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        raise SystemExit(0)
    raise SystemExit(main())
