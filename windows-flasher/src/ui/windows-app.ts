import type { FlashErrorCode, FlashState, ProvisioningEvent } from "../domain";
import { diagnostic, formatDiagnosticLog, subscribeDiagnostics } from "../diagnostics";
import { mountFirmwareLibrary } from "../firmware/library";
import type { ProvisioningController } from "../provisioning/controller";

/** Windows 发行版只保留受控的首次刷写流程，不向普通用户暴露维护级功能。 */
export type WindowsFlasherEnvironment = {
  readonly secure: boolean;
  readonly webUsb: boolean;
  readonly os: "macOS" | "Windows" | "Other";
  readonly browser: string;
};

type ControllerSurface = Pick<ProvisioningController, "state" | "start" | "cancel" | "subscribe">;

const STAGES = [
  "连接 QDC507",
  "核验模块身份",
  "检查原厂服务与空间",
  "验证正式刷机包",
  "上传并暂存文件",
  "原子提交安装",
  "等待 USB 重连",
  "验证安装结果",
] as const;

const GUIDANCE: Partial<Record<FlashErrorCode, string>> = {
  USB_PERMISSION_CANCELLED: "没有选择模块，请重新连接后再试。",
  USB_INTERFACE_BUSY: "ADB 接口被占用；退出 ADB、串口工具和 DJOneHub 后重新插拔模块。",
  USB_DISCONNECTED: "刷写中 USB 可能会重枚举。保持供电与数据线连接，等待程序完成重连检查。",
  UNSUPPORTED_DEVICE: "只支持 USB ID 为 2c7c:0125 的 QDC507 模块，不能强行继续。",
  UNSUPPORTED_PLATFORM: "模块平台不匹配，不能继续刷写。",
  SIGNATURE_INVALID: "内置刷机包未通过签名验证，已阻止操作。",
  PACKAGE_INVALID: "内置刷机包的清单或摘要异常，已阻止操作。",
  CALL_ACTIVE: "检测到通话，结束通话后才能修改模块运行文件。",
  INSUFFICIENT_SPACE: "模块可用空间不足，不能安全刷写。",
  ROLLBACK_UNCONFIRMED: "无法确认安全回滚，请保持供电并导出日志后处理。",
};

function statusText(state: FlashState): string {
  if (state.phase === "failed") return state.message;
  if (state.phase === "completed") return `模块 ${state.version} 已完成首次部署并通过验证`;
  return state.detail ?? {
    environment: "等待选择已验证刷机包",
    "awaiting-device": "请选择 QDC507 模块",
    preflight: "正在核验模块身份与安全状态",
    planning: "正在规划安全安装步骤",
    downloading: "正在载入内置刷机包",
    "verifying-package": "正在验证签名与文件摘要",
    uploading: "正在上传模块文件",
    installing: "正在原子提交安装，请勿断电",
    "waiting-reconnect": "模块正在重枚举，等待 USB 重连",
    "verifying-device": "正在验证 Agent 与运行状态",
  }[state.phase];
}

/** 仅供 Windows 发行版调用的受控界面；固件来源固定为本地服务列出的基线包。 */
export function mountWindowsFlasher(
  root: HTMLElement,
  controller: ControllerSurface,
  environment: WindowsFlasherEnvironment,
): () => void {
  const events: ProvisioningEvent[] = [];
  let selectedPackage: Uint8Array | undefined;
  let running = false;
  root.innerHTML = `
    <header class="topbar"><span class="brand">DJOneHub Windows 刷机工具</span><nav><span>0.1.0 测试版</span><span>仅限 QDC507</span></nav></header>
    <main class="shell">
      <section class="intro"><p class="eyebrow">首次部署 · 受控流程</p><h1>连接模块，安全完成首次刷写</h1>
        <p>本工具只加载内置且经过摘要校验的 QDC507 首次部署包。它不会读取私钥、不会提供降级、不会接受任意固件。</p>
        <p class="power-warning">刷写前请确认模块不在通话中；过程中不得拔线、断电或关闭程序。</p>
        <button class="primary" id="connect" disabled>先选择已验证刷机包</button><button class="cancel" id="cancel" hidden>取消</button><p class="support" id="support"></p>
      </section>
      <div class="workspace">
        <section class="workflow"><h2>刷写进度</h2><ol id="stages" class="stages"></ol>
          <div class="live-panel"><div class="live-line"><span id="status">正在读取内置刷机包</span><strong id="percent">0%</strong></div><progress id="progress" max="100" value="0"></progress></div>
          <section class="result" id="result" hidden></section>
        </section>
        <aside class="diagnostics"><h2>设备检查</h2><dl><div><dt>运行环境</dt><dd>${environment.browser}</dd></div><div><dt>WebUSB</dt><dd>${environment.webUsb ? "可用" : "不可用"}</dd></div><div><dt>安全上下文</dt><dd>${environment.secure ? "符合要求" : "不可用"}</dd></div><div><dt>允许设备</dt><dd>QDC507 · 2c7c:0125</dd></div></dl>
          <details><summary>连接日志</summary><p>日志不包含 SIM、号码、短信或设备序列号。</p><pre class="debug-log" id="debug-log">等待连接操作…</pre><button class="text-button" id="copy-log">复制脱敏日志</button></details>
        </aside>
      </div>
      <section class="firmware-library"><div class="library-heading"><div><p class="eyebrow">内置正式基线</p><h2>选择已验证的首次部署包</h2></div><p>刷机包在程序内部校验，不从任意网址下载。</p></div><div class="release-track" id="firmware-list" aria-live="polite"></div></section>
    </main>`;

  const connect = root.querySelector<HTMLButtonElement>("#connect")!;
  const cancel = root.querySelector<HTMLButtonElement>("#cancel")!;
  const status = root.querySelector<HTMLElement>("#status")!;
  const percent = root.querySelector<HTMLElement>("#percent")!;
  const progress = root.querySelector<HTMLProgressElement>("#progress")!;
  const stages = root.querySelector<HTMLOListElement>("#stages")!;
  const result = root.querySelector<HTMLElement>("#result")!;
  const support = root.querySelector<HTMLElement>("#support")!;
  const log = root.querySelector<HTMLElement>("#debug-log")!;
  const copyLog = root.querySelector<HTMLButtonElement>("#copy-log")!;
  const supported = environment.secure && environment.webUsb && environment.os === "Windows";

  if (!supported) {
    support.textContent = "此测试版仅支持 Windows 桌面环境中的 WebUSB。";
  }

  const unsubscribeDiagnostics = subscribeDiagnostics((entry) => {
    const stamp = new Date(entry.timestamp).toISOString().slice(11, 23);
    const lines = `${log.textContent ?? ""}\n${stamp} ${entry.level.toUpperCase()} [${entry.code}] ${entry.message}`.trim().split("\n").slice(-600);
    log.textContent = lines.join("\n");
    log.scrollTop = log.scrollHeight;
  });

  void mountFirmwareLibrary(root.querySelector<HTMLElement>("#firmware-list")!, (release, bytes) => {
    selectedPackage = bytes;
    connect.disabled = !supported;
    connect.textContent = `连接 QDC507 并刷写 ${release.version}`;
    status.textContent = `已选择 ${release.version}，请确认供电与数据线后连接模块`;
    diagnostic("WINDOWS_BASELINE_SELECTED", `version=${release.version} bytes=${bytes.byteLength}`);
  });

  const render = (state: FlashState) => {
    const current = Math.max(0, Math.min(STAGES.length - 1, state.step ?? 0));
    const failed = state.phase === "failed";
    stages.innerHTML = STAGES.map((label, index) => `<li class="${!failed && (state.phase === "completed" || index < current) ? "complete" : !failed && index === current ? "active" : ""}"><span class="stage-icon">${index + 1}</span><span class="stage-copy"><b>${label}</b><small>${state.phase === "completed" || index < current ? "已完成" : index === current ? "进行中" : "等待中"}</small></span></li>`).join("");
    const value = state.phase === "completed" ? 100 : Math.round((current / STAGES.length) * 100);
    progress.value = value;
    percent.textContent = `${value}%`;
    status.textContent = statusText(state);
    running = !["environment", "completed", "failed"].includes(state.phase);
    cancel.hidden = !running;
    connect.hidden = running || state.phase === "completed";
    if (state.phase === "completed") {
      result.hidden = false;
      result.className = "result success";
      result.innerHTML = `<h2>首次刷写完成</h2><p>模块版本 <strong>${state.version}</strong> 已通过本地验证。接回 DJOneHub App 后，再进行后续正常更新。</p>`;
    } else if (state.phase === "failed") {
      result.hidden = false;
      result.className = "result error";
      result.innerHTML = `<h2>已停止刷写</h2><p>${GUIDANCE[state.code] ?? "请导出日志并核对模块、供电和数据线。"}</p>`;
      connect.hidden = false;
      connect.textContent = selectedPackage ? "重新连接 QDC507" : "先选择已验证刷机包";
      connect.disabled = !supported || !selectedPackage;
    }
  };

  const unsubscribe = controller.subscribe((event) => {
    events.push(event);
    diagnostic("WINDOWS_FLOW", event.state.phase === "failed" ? `${event.state.code}: ${event.state.message}` : event.state.phase, event.state.phase === "failed" ? "error" : "info");
    render(event.state);
  });
  connect.addEventListener("click", () => {
    if (!selectedPackage) return;
    void controller.start({ localPackage: selectedPackage });
  });
  cancel.addEventListener("click", () => { void controller.cancel(); });
  copyLog.addEventListener("click", () => {
    void navigator.clipboard?.writeText(`os=Windows\nvid_pid=2c7c:0125\n\n${formatDiagnosticLog()}\n\nFLOW_EVENTS\n${JSON.stringify(events)}`);
    copyLog.textContent = "已复制";
  });
  render(controller.state);
  return () => { unsubscribe(); unsubscribeDiagnostics(); root.replaceChildren(); };
}
