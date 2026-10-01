#!/usr/bin/env python3
"""构建可分享的 QDC507 模块 Windows 首次部署包.

与 build-share-package.py (macOS 版) 的差别:
  - 入口是 .bat + bootstrap.ps1, 不是 install.command
  - 运行时依赖 adb.exe (首次运行自动从 dl.google.com 下载), 不打包 libusb dylib
  - 不生成 module-update.djupdate: 该更新包只给 App 自更新用, 首次刷写不需要,
    而且签名私钥属于发布者, 不应出现在 Windows 分享包的构建流程里

用法:
    python build-share-package-windows.py
    python build-share-package-windows.py --bundle-platform-tools
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

RELEASE_TOOLS = Path(__file__).resolve().parent
MODULE_AGENT = RELEASE_TOOLS.parent
MODULE_ROOT = MODULE_AGENT.parent
ROOT = MODULE_ROOT.parent
LAUNCHER = RELEASE_TOOLS / "windows"

AGENT = MODULE_AGENT / "qdc507-agent"
BRIDGE = MODULE_ROOT / "kernel-bridge/qdc507_data11_bridge.ko"
PROBE = MODULE_ROOT / "qdc507-adb-probe.py"
PCM_BRIDGE = MODULE_AGENT / "pcm-bridge/mavo-pcm-bridge.armv7"

# 与 deploy-qdc507-agent.py 中的 EXPECTED_FILES 保持一致, 构建时就先拦一次.
EXPECTED_FILES = {
    "qdc507_aprv3.ko": "3d82d3dec4f1e323201bba87156df9d41438e08314097353f2607f9117211d4a",
    "qdc507_voice.ko": "ed3821682d5309969a01c764192c83feff9669c61ef237c69475cd1619cf296c",
    "mavo-pcm-bridge.armv7": "2236ae9a6b3e9e1b01c5ffbd4ae033e5812befbaa3f74d524ad1e1eaf1b9f476",
}

VOICE_SOURCE = os.environ.get("DJONEHUB_VOICE_RUNTIME", "")
PLATFORM_TOOLS = Path(os.environ.get("DJONEHUB_PLATFORM_TOOLS", "C:/platform-tools"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_agent_version() -> str:
    source = (MODULE_AGENT / "main.go").read_text(encoding="utf-8")
    match = re.search(r'agentVersion\s*=\s*"([0-9]+(?:\.[0-9]+)+)"', source)
    if not match:
        raise RuntimeError("无法从 module-agent/main.go 读取 Agent 版本")
    return match.group(1)


def resolve_voice_source() -> Path:
    if VOICE_SOURCE:
        return Path(VOICE_SOURCE)
    candidates = [
        Path.home() / "Library/Application Support/DJOneHub/voice-runtime/mavo-0443dfd",
        MODULE_AGENT / "voice-runtime",
    ]
    for candidate in candidates:
        if (candidate / "qdc507_aprv3.ko").is_file():
            return candidate
    raise RuntimeError(
        "找不到语音运行时目录; 请用 DJONEHUB_VOICE_RUNTIME 指向含 "
        "qdc507_aprv3.ko / qdc507_voice.ko 的目录"
    )


def require_files(voice_source: Path) -> None:
    required = [
        AGENT,
        MODULE_AGENT / "deploy-qdc507-agent.py",
        BRIDGE,
        PROBE,
        PCM_BRIDGE,
        voice_source / "qdc507_aprv3.ko",
        voice_source / "qdc507_voice.ko",
    ]
    required += sorted(LAUNCHER.iterdir())
    missing = [path for path in required if not path.exists()]
    if missing:
        raise RuntimeError("分享包缺少文件:\n" + "\n".join(str(path) for path in missing))

    for name, expected in EXPECTED_FILES.items():
        if name == "mavo-pcm-bridge.armv7":
            path = PCM_BRIDGE
        elif name.startswith("qdc507_") and name.endswith(".ko"):
            path = voice_source / name
        else:
            continue
        actual = sha256(path)
        if actual != expected:
            raise RuntimeError(f"{name} 摘要不匹配: {actual} != {expected}")


def write_package(voice_source: Path, bundle_platform_tools: bool) -> Path:
    version = read_agent_version()
    output = ROOT / "dist" / f"DJOneHub-QDC507-Module-Windows-v{version}"
    if output.exists():
        shutil.rmtree(output)
    (output / "module-agent/pcm-bridge").mkdir(parents=True, exist_ok=True)
    (output / "module-agent/voice-runtime").mkdir(parents=True, exist_ok=True)
    (output / "kernel-bridge").mkdir(parents=True, exist_ok=True)

    for item in sorted(LAUNCHER.iterdir()):
        shutil.copy2(item, output / item.name)
    shutil.copy2(AGENT, output / "module-agent/qdc507-agent")
    shutil.copy2(MODULE_AGENT / "deploy-qdc507-agent.py", output / "module-agent/deploy-qdc507-agent.py")
    shutil.copy2(PCM_BRIDGE, output / "module-agent/pcm-bridge/mavo-pcm-bridge.armv7")
    shutil.copy2(voice_source / "qdc507_aprv3.ko", output / "module-agent/voice-runtime/qdc507_aprv3.ko")
    shutil.copy2(voice_source / "qdc507_voice.ko", output / "module-agent/voice-runtime/qdc507_voice.ko")
    shutil.copy2(BRIDGE, output / "kernel-bridge/qdc507_data11_bridge.ko")
    shutil.copy2(PROBE, output / "qdc507-adb-probe.py")

    if bundle_platform_tools:
        if not (PLATFORM_TOOLS / "adb.exe").is_file():
            raise RuntimeError(
                f"--bundle-platform-tools 需要 {PLATFORM_TOOLS}\\adb.exe; "
                "可用 DJONEHUB_PLATFORM_TOOLS 指定其他目录"
            )
        shutil.copytree(PLATFORM_TOOLS, output / "platform-tools")

    checksum_lines = []
    for path in sorted(item for item in output.rglob("*") if item.is_file() and item.name != "SHA256SUMS"):
        checksum_lines.append(f"{sha256(path)}  {path.relative_to(output).as_posix()}")
    (output / "SHA256SUMS").write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")

    archive = ROOT / "dist" / f"{output.name}.zip"
    if archive.exists():
        archive.unlink()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for path in sorted(output.rglob("*")):
            if path.is_file():
                bundle.write(path, f"{output.name}/{path.relative_to(output).as_posix()}")
    return archive


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建 QDC507 Windows 首次部署分享包")
    parser.add_argument(
        "--bundle-platform-tools",
        action="store_true",
        help="把本机 C:/platform-tools 一并打进分享包 (默认不打, 由 .bat 首次运行时自动下载)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        voice_source = resolve_voice_source()
        require_files(voice_source)
        archive = write_package(voice_source, args.bundle_platform_tools)
    except RuntimeError as error:
        print(f"构建失败: {error}", file=sys.stderr)
        return 1
    print(f"已生成分享包: {archive}")
    print("解压后双击 Deploy-Module.bat 即可; platform-tools 会在首次运行时自动下载。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())