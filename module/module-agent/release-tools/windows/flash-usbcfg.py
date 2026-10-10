#!/usr/bin/env python3
"""DJOneHub QDC507 首次部署第一步: 安全写入 USB 组合 (usbcfg), 失败自动回滚.

安全设计:
  1. 默认只读: 不加 --write 时绝不写入任何内容.
  2. 写入前强制备份当前 USBCFG 到 usbcfg-rollback/ (时间戳 + latest 两份).
  3. 前置闸门: 必须是 QDC507, USBCFG 必须可解析, 通话中拒绝写入.
  4. 写入后立即回读; 未匹配目标值 -> 立刻把原值写回并回读确认, 不重启.
  5. 只有回读确认才重启; 重启后校验失败 -> 自动恢复原配置并再次重启.
  6. --restore 可用备份文件把模块恢复到写入前状态.
  7. 顺手把 USB 网络模式写成 usbnet=1 (ECM): 作者部署器要求模块 functions 里有
     ecm, 而 usbnet=0 的模块只有 rmnet, 部署器会静默 exit 43. 原值也一样先备份,
     回滚时一起写回.

只依赖 pyserial (由 Setup-Only.bat / bootstrap.ps1 自动安装), 不依赖 passlib:
QADBKEY 的 md5-crypt 由本文件自带实现, 已在 400 组随机用例上与 passlib 逐字节比对一致.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    raise SystemExit(
        "缺少 pyserial; 请运行 Setup-Only.bat 自动安装, "
        "或手动执行: python -m pip install pyserial"
    )

HERE = Path(__file__).resolve().parent
BACKUP_DIR = HERE / "usbcfg-rollback"

# 作者 macOS 客户端 module_setup.go 中的正式目标组合.
TARGET_VID = 0x2C7C
TARGET_PID = 0x0125
TARGET_FLAGS = [1, 1, 1, 1, 1, 1, 1]
# 作者客户端 (macOS/cmd/djonehub-macos/web/index.html) 写明"模块固定保持 usbnet=1":
# 0=RMNET(传统拨号), 1=ECM(4G 网卡), 2/3=实验模式. usbnet=0 时 gadget 里是 rmnet
# 而不是 ecm, 作者部署器的组合闸门 (exit 43) 会直接失败.
TARGET_USBNET = 1
# 脚本构建日期. 排错时先看输出里的这一行, 用来确认对方拿到的到底是不是新版分享包
# (同版本号的老包和新包只能靠这行区分).
BUILD_STAMP = "2026-10-01"

USBCFG_RE = re.compile(
    r'\+QCFG:\s*"usbcfg"\s*,\s*(0x[0-9A-Fa-f]+)\s*,\s*(0x[0-9A-Fa-f]+)'
    r'\s*,\s*((?:[01]\s*,\s*)*[01])',
    re.IGNORECASE,
)
USBNET_RE = re.compile(r'\+QCFG:\s*"usbnet"\s*,\s*(\d+)', re.IGNORECASE)
QD_RE = re.compile(r"QDC507", re.IGNORECASE)
VOICE_CALL_RE = re.compile(r"\+CLCC:\s*\d+\s*,\s*\d+\s*,\s*[0-5]\s*,\s*0\s*,")
MD5CRYPT_ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def log(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def composition_command(vid: int, pid: int, flags: list[int]) -> str:
    body = ",".join([f"0x{vid:04X}", f"0x{pid:04X}"] + [str(f) for f in flags])
    return f'AT+QCFG="USBCFG",{body}'


def parse_usbcfg(raw: str):
    match = USBCFG_RE.search(raw or "")
    if not match:
        return None
    vid = int(match.group(1), 0)
    pid = int(match.group(2), 0)
    flags = [int(value) for value in match.group(3).replace(" ", "").split(",")]
    return vid, pid, flags


def parse_usbnet(raw: str):
    match = USBNET_RE.search(raw or "")
    return int(match.group(1)) if match else None


def usbnet_command(mode: int) -> str:
    return f'AT+QCFG="usbnet",{mode}'


def fmt(vid: int, pid: int, flags: list[int]) -> str:
    return f"0x{vid:04X},0x{pid:04X}," + ",".join(str(f) for f in flags)


class AtPort:
    """115200 8N1 的 AT 串口封装."""

    def __init__(self, name: str):
        self.name = name
        self.ser = serial.Serial()
        self.ser.port = name
        self.ser.baudrate = 115200
        self.ser.bytesize = serial.EIGHTBITS
        self.ser.parity = serial.PARITY_NONE
        self.ser.stopbits = serial.STOPBITS_ONE
        self.ser.timeout = 0.2
        self.ser.write_timeout = 3
        self.ser.dtr = True
        self.ser.rts = True

    def open(self) -> None:
        self.ser.open()
        time.sleep(0.7)
        self.ser.reset_input_buffer()

    def close(self) -> None:
        try:
            self.ser.close()
        except Exception:
            pass

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *_exc):
        self.close()

    def at(self, command: str, wait: float = 1.5) -> str:
        try:
            self.ser.reset_input_buffer()
            self.ser.write((command + "\r").encode("ascii"))
            self.ser.flush()
        except Exception as error:
            return f"<write-error: {error}>"
        deadline = time.time() + wait
        buffer = bytearray()
        while time.time() < deadline:
            try:
                chunk = self.ser.read(4096)
            except Exception as error:
                return bytes(buffer).decode("utf-8", "replace") + f"<read-error: {error}>"
            if chunk:
                buffer.extend(chunk)
                if re.search(r"(^|[\r\n])(OK|ERROR)[\r\n]*$", bytes(buffer).decode("utf-8", "replace")):
                    break
                deadline = time.time() + 0.6
            else:
                time.sleep(0.05)
        return bytes(buffer).decode("utf-8", "replace")

    def read_usbcfg(self, wait: float = 1.5) -> str:
        return self.at('AT+QCFG="usbcfg"', wait)

    def read_usbnet(self, wait: float = 1.5) -> str:
        return self.at('AT+QCFG="usbnet"', wait)


def probe_port(name: str):
    """返回 (ati, gmr, usbcfg, clcc) 或 None."""
    try:
        with AtPort(name) as port:
            gmr = port.at("AT+QGMR", 1.2)
            if not QD_RE.search(gmr):
                return None
            return {
                "ati": port.at("ATI", 0.9).strip(),
                "gmr": gmr.strip(),
                "usbcfg": port.read_usbcfg().strip(),
                "usbnet": port.read_usbnet().strip(),
                "clcc": port.at("AT+CLCC", 0.9).strip(),
            }
    except Exception:
        return None


def candidate_ports(preferred: str | None) -> list[str]:
    names = []
    if preferred:
        names.append(preferred)
    for info in list_ports.comports():
        if info.device not in names:
            names.append(info.device)
    return names


def find_module(preferred: str | None = None):
    for name in candidate_ports(preferred):
        info = probe_port(name)
        if info:
            return name, info
    return None, None


def _md5crypt_to64(value: int, count: int) -> str:
    characters = []
    for _ in range(count):
        characters.append(MD5CRYPT_ALPHABET[value & 0x3F])
        value >>= 6
    return "".join(characters)


def md5crypt(password: str, salt: str, rounds: int = 1000) -> str:
    """标准 $1$ (FreeBSD/PAM md5-crypt), 与 passlib.hash.md5_crypt 结果一致."""
    password_bytes = password.encode()
    salt_bytes = salt.encode()[:8]
    context = hashlib.md5(password_bytes + b"$1$" + salt_bytes)
    alternate = hashlib.md5(password_bytes + salt_bytes + password_bytes).digest()
    remaining = len(password_bytes)
    while remaining > 0:
        context.update(alternate[: min(16, remaining)])
        remaining -= 16
    bits = len(password_bytes)
    while bits:
        context.update(b"\x00" if (bits & 1) else password_bytes[:1])
        bits >>= 1
    final = context.digest()
    for index in range(rounds):
        inner = hashlib.md5()
        inner.update(password_bytes if (index & 1) else final)
        if index % 3:
            inner.update(salt_bytes)
        if index % 7:
            inner.update(password_bytes)
        inner.update(final if (index & 1) else password_bytes)
        final = inner.digest()
    return "$1$" + salt_bytes.decode() + "$" + (
        _md5crypt_to64((final[0] << 16) | (final[6] << 8) | final[12], 4)
        + _md5crypt_to64((final[1] << 16) | (final[7] << 8) | final[13], 4)
        + _md5crypt_to64((final[2] << 16) | (final[8] << 8) | final[14], 4)
        + _md5crypt_to64((final[3] << 16) | (final[9] << 8) | final[15], 4)
        + _md5crypt_to64((final[4] << 16) | (final[10] << 8) | final[5], 4)
        + _md5crypt_to64(final[11], 2)
    )


def md5crypt_unlock_key(challenge: str, secret: str = "SH_adb_quectel") -> str:
    """Quectel QADBKEY: 以挑战码为 salt 的 MD5-crypt, 取摘要前 15 位."""
    return md5crypt(secret, challenge).split("$")[3][:15]


def save_backup(raw: str, vid: int, pid: int, flags: list[int], gmr: str, usbnet) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    payload = {
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "gmr": gmr,
        "usbcfg": fmt(vid, pid, flags),
        "raw": raw,
        "command": composition_command(vid, pid, flags),
        "target": fmt(TARGET_VID, TARGET_PID, TARGET_FLAGS),
        "usbnet": usbnet,
        "usbnet_target": TARGET_USBNET,
    }
    stamped = BACKUP_DIR / f"usbcfg-before-{stamp}.json"
    latest = BACKUP_DIR / "usbcfg-latest.json"
    for path in (stamped, latest):
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return stamped


def confirm_applied(port: AtPort, vid: int, pid: int, flags: list[int], wait: float = 2.0) -> bool:
    for _ in range(3):
        parsed = parse_usbcfg(port.read_usbcfg(wait))
        if parsed and parsed == (vid, pid, flags):
            return True
        time.sleep(0.4)
    return False


def confirm_usbnet(port: AtPort, mode: int, wait: float = 2.0) -> bool:
    for _ in range(3):
        if parse_usbnet(port.read_usbnet(wait)) == mode:
            return True
        time.sleep(0.4)
    return False


def apply_usbnet(port: AtPort, mode: int):
    """把 USB 网络模式写成 mode 并回读; 返回 (是否成功, 写入前读到的值).

    已经是目标值时不写入, 所以 usbnet 本来就正确的模块行为完全不变.
    """
    previous = parse_usbnet(port.read_usbnet(2.0))
    if previous == mode:
        log(f"  usbnet 已是 {mode}, 无需写入.")
        return True, previous
    log(f"  usbnet {previous if previous is not None else '<读取失败>'} -> {mode} (ECM)")
    log("  " + port.at(usbnet_command(mode), 2.0).strip().replace("\r\n", " | "))
    return confirm_usbnet(port, mode), previous


def rollback(port: AtPort, original, usbnet, reason: str) -> int:
    vid, pid, flags = original
    log(f"回滚: {reason}")
    if usbnet is not None and usbnet != TARGET_USBNET:
        log(f"写回原 usbnet {usbnet}")
        log("  " + port.at(usbnet_command(usbnet), 2.0).strip().replace("\r\n", " | "))
    log(f"写回原配置 {fmt(vid, pid, flags)}")
    log("  " + port.at(composition_command(vid, pid, flags), 2.0).strip().replace("\r\n", " | "))
    confirmed = confirm_applied(port, vid, pid, flags)
    if usbnet is not None and usbnet != TARGET_USBNET:
        confirmed = confirm_usbnet(port, usbnet) and confirmed
    if confirmed:
        log("回滚已确认: 模块保持写入前的 USB 配置, 未重启.")
        return 2
    log("警告: 回滚回读未确认, 请重新插拔模块后执行 --restore.")
    return 5


def write_composition(port: AtPort, vid: int, pid: int, flags: list[int], wait: float = 2.0) -> str:
    return port.at(composition_command(vid, pid, flags), wait)


def resolve_adb() -> str | None:
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
    return None


def usb_adb_present() -> bool | None:
    """用 adb 确认 ADB 接口是否已随新组合枚举; 没有 adb 时返回 None."""
    adb = resolve_adb()
    if not adb:
        return None
    try:
        result = subprocess.run(
            [adb, "devices"], capture_output=True, text=True, timeout=60
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) >= 2 and parts[1].strip() == "device":
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="安全写入 QDC507 USB 组合 (含自动回滚)")
    parser.add_argument("--write", action="store_true", help="真正写入目标组合 (默认只读预检)")
    parser.add_argument("--restore", action="store_true", help="使用最新备份恢复写入前的配置")
    parser.add_argument("--restore-file", help="使用指定备份 JSON 恢复")
    parser.add_argument("--port", help="指定 AT 串口, 例如 COM8")
    parser.add_argument("--no-reboot", action="store_true", help="写入并回读确认后不重启")
    parser.add_argument("--wait-reboot", type=int, default=150, help="重启后等待重新枚举的秒数")
    args = parser.parse_args()

    actions = [args.write, args.restore, bool(args.restore_file)]
    if sum(1 for a in actions if a) > 1:
        log("--write / --restore / --restore-file 只能选一个.")
        return 64

    log(f"刷机脚本构建 {BUILD_STAMP}")
    log("步骤 1/6 定位 QDC507 AT 串口 ...")
    for _ in range(6):
        name, info = find_module(args.port)
        if info:
            break
        time.sleep(2)
    else:
        log("未找到 QDC507 AT 串口, 请确认模块已连接且驱动已就绪.")
        return 3
    log(f"AT 串口 = {name}")
    log("  " + info["ati"].replace("\r\n", " | "))
    log("  " + info["gmr"].replace("\r\n", " | "))

    parsed = parse_usbcfg(info["usbcfg"])
    if not parsed:
        log(f"无法解析当前 USBCFG: {info['usbcfg']!r}, 拒绝写入.")
        return 4
    current = parsed
    log(f"当前 USBCFG = {fmt(*current)}")

    original_usbnet = parse_usbnet(info["usbnet"])
    if original_usbnet is None:
        log(f"警告: 读不出 usbnet 模式 (读到 {info['usbnet']!r}), 本次不改它.")
    elif original_usbnet == TARGET_USBNET:
        log(f"当前 usbnet = {original_usbnet} (ECM), 正确.")
    else:
        log(f"当前 usbnet = {original_usbnet}, 需要改成 {TARGET_USBNET} (ECM) 才能部署.")

    def load_backup(path: Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        vid, pid, flags = parse_usbcfg(data["usbcfg"]) or (None, None, None)
        if vid is None:
            raise ValueError(f"备份文件缺少可用 usbcfg: {path}")
        return (vid, pid, flags), data

    if args.restore or args.restore_file:
        path = Path(args.restore_file) if args.restore_file else (BACKUP_DIR / "usbcfg-latest.json")
        if not path.is_file():
            log(f"找不到备份文件: {path}")
            return 64
        original, data = load_backup(path)
        log(f"步骤 2/6 使用备份 {path} ({data.get('saved_at')}) 恢复 -> {fmt(*original)}")
        try:
            with AtPort(name) as port:
                port.at(composition_command(*original), 2.0)
                saved_usbnet = data.get("usbnet")
                if isinstance(saved_usbnet, int) and parse_usbnet(port.read_usbnet(1.5)) != saved_usbnet:
                    log(f"  usbnet 也写回 {saved_usbnet}")
                    port.at(usbnet_command(saved_usbnet), 2.0)
                if not confirm_applied(port, *original):
                    log("恢复回读未确认, 请重新插拔后再试.")
                    return 5
                log("恢复回读已确认, 正在重启模块 ...")
                port.at("AT+CFUN=1,1", 1.5)
        except Exception as error:
            log(f"恢复过程中串口断开 (重启属正常): {error}")
        log("恢复完成.")
        return 0

    # ---- 前置闸门 ----
    log("步骤 2/6 前置闸门 (只读)")
    if VOICE_CALL_RE.search(info["clcc"]):
        log("模块正在语音通话, 拒绝写入 USB 配置.")
        return 6
    log("  通话闸门: 通过 (无 mode=0 的语音呼叫)")
    backup_path = save_backup(info["usbcfg"], *current, info["gmr"], original_usbnet)
    log(f"  已备份原始配置 -> {backup_path}")

    if not args.write:
        log("预检完成, 未写入任何内容. 加 --write 才会真正写入.")
        log(f"计划写入: {fmt(TARGET_VID, TARGET_PID, TARGET_FLAGS)} 且 usbnet={TARGET_USBNET} (ECM)")
        # 给上层脚本 (bootstrap.ps1 -Action flash) 的机器可读状态行: 纯 ASCII,
        # 不经过控制台代码页, 换台机器也不会因为编码差异而解析失败.
        print(
            f"DJONEHUB_USBCFG current={fmt(*current)} "
            f"target={fmt(TARGET_VID, TARGET_PID, TARGET_FLAGS)} "
            f"already={1 if current == (TARGET_VID, TARGET_PID, TARGET_FLAGS) else 0} "
            f"usbnet={original_usbnet if original_usbnet is not None else -1} "
            f"usbnet_target={TARGET_USBNET}",
            flush=True,
        )
        return 0

    # ---- 写入 + 回读 + 回滚 ----
    log("步骤 3/6 QADBKEY 解锁 (Baiwang 固件需要)")
    try:
        with AtPort(name) as port:
            challenge_raw = port.at("AT+QADBKEY?", 1.0)
            log("  " + challenge_raw.strip().replace("\r\n", " | "))
            match = re.search(r"\+QADBKEY:\s*(\d{8})", challenge_raw)
            if match:
                challenge = match.group(1)
                key = md5crypt_unlock_key(challenge)
                response = port.at(f'AT+QADBKEY="{key}"', 1.5)
                log("  " + response.strip().replace("\r\n", " | "))
                if "OK" not in response.upper():
                    log("QADBKEY 解锁未被接受, 停止写入.")
                    return 7
                log("  QADBKEY 解锁已确认.")
            else:
                log("  模块未返回挑战码, 跳过解锁 (可能已解锁或固件无锁).")

            log("步骤 4/6 写入目标 USB 组合并立即回读")
            log(f"  {fmt(*current)}  ->  {fmt(TARGET_VID, TARGET_PID, TARGET_FLAGS)}")
            write_response = write_composition(port, TARGET_VID, TARGET_PID, TARGET_FLAGS)
            log("  " + write_response.strip().replace("\r\n", " | "))
            readback_raw = port.read_usbcfg(2.0)
            log("  回读: " + readback_raw.strip().replace("\r\n", " | "))
            readback = parse_usbcfg(readback_raw)
            if readback != (TARGET_VID, TARGET_PID, TARGET_FLAGS):
                return rollback(port, current, original_usbnet, "回读与目标不一致")

            if original_usbnet is not None and original_usbnet != TARGET_USBNET:
                log('步骤 4b/6 写入 USB 网络模式 (AT+QCFG="usbnet",1) 并回读')
                ok, previous = apply_usbnet(port, TARGET_USBNET)
                if previous is not None:
                    original_usbnet = previous
                if not ok:
                    return rollback(port, current, original_usbnet, "usbnet 回读与目标不一致")

            if args.no_reboot:
                log("已确认写入, 按 --no-reboot 跳过重启; 重启后才会生效.")
                return 0

            log("步骤 5/6 重启模块 (AT+CFUN=1,1) 使新组合生效")
            port.at("AT+CFUN=1,1", 1.5)
    except Exception as error:
        log(f"串口会话异常: {error}")

    # ---- 重启后校验 ----
    log(f"步骤 6/6 等待重新枚举 (最多 {args.wait_reboot}s) 并校验")
    deadline = time.time() + args.wait_reboot
    found_name = None
    found_info = None
    while time.time() < deadline:
        time.sleep(5)
        found_name, found_info = find_module(args.port)
        if found_info:
            break
    if not found_info:
        log("模块未在超时内重新枚举. 请重新插拔后执行 --restore 恢复原配置.")
        return 3

    log(f"AT 串口重新出现 = {found_name}")
    after = parse_usbcfg(found_info["usbcfg"])
    after_usbnet = parse_usbnet(found_info["usbnet"])
    log("  回读: " + found_info["usbcfg"].replace("\r\n", " | "))
    log(f"  回读 usbnet = {after_usbnet}")

    if after == (TARGET_VID, TARGET_PID, TARGET_FLAGS) and (
        original_usbnet is None or after_usbnet == TARGET_USBNET
    ):
        adb = usb_adb_present()
        if adb is True:
            log("成功: 目标组合已生效, 且 adb 已看到模块设备.")
            return 0
        if adb is False:
            log("写入生效, 但 adb 未看到设备; 可能驱动未加载, 请重新插拔后复查.")
            return 0
        log("成功: 目标组合已生效 (未找到 adb.exe, 跳过 ADB 复查).")
        return 0

    if after != (TARGET_VID, TARGET_PID, TARGET_FLAGS):
        log(f"重启后组合不是目标值: {fmt(*after) if after else found_info['usbcfg']!r}")
    else:
        log(f"重启后 usbnet 不是目标值: {after_usbnet}")
    log("尝试自动恢复原始配置 ...")
    try:
        with AtPort(found_name) as port:
            return rollback(port, current, original_usbnet, "重启后校验失败")
    except Exception as error:
        log(f"自动恢复失败: {error}; 请重新插拔后执行 --restore.")
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
