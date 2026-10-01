import { FlashError, MODULE_PLATFORM } from "../domain";
import type { AdbClient } from "../adb/client";
import { diagnostic } from "../diagnostics";

const EXPECTED_KEYS = [
  "agent", "agent_pid", "arch", "available", "call", "cap_busybox", "cap_sha256",
  "cap_wget", "factory_pid", "functions", "kernel", "port_7575", "serial_connected",
  "uid", "usb",
] as const;
const DECIMAL = /^(0|[1-9]\d*)$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const PREFLIGHT_BEGIN = "DJONEHUB_PREFLIGHT_BEGIN";
const PREFLIGHT_END = "DJONEHUB_PREFLIGHT_END";
const encoder = new TextEncoder();

export type PreflightResult = {
  readonly platform: typeof MODULE_PLATFORM;
  readonly availableBytes: number;
  readonly factoryPid: number;
  readonly callState: "NONE";
  readonly installedVersion: string | undefined;
  readonly usbFunctions: string;
  readonly agentPid: number | undefined;
  readonly port7575Listening: boolean;
  readonly serialConnected: boolean;
  readonly capabilities: {
    readonly busybox: boolean;
    readonly sha256: boolean;
    readonly wget: boolean;
  };
};

export function parsePreflight(output: string): PreflightResult {
  const begin = output.indexOf(PREFLIGHT_BEGIN);
  const end = output.indexOf(PREFLIGHT_END, begin + PREFLIGHT_BEGIN.length);
  const beginLineEnd = output.indexOf("\n", begin + PREFLIGHT_BEGIN.length);
  const beginAtLineStart = begin === 0 || output[begin - 1] === "\n";
  const endAtLineStart = end > 0 && output[end - 1] === "\n";
  if (
    begin < 0 || end < 0 || beginLineEnd < 0 || beginLineEnd >= end
    || !beginAtLineStart || !endAtLineStart
    || output.indexOf(PREFLIGHT_BEGIN, begin + PREFLIGHT_BEGIN.length) >= 0
    || output.indexOf(PREFLIGHT_END, end + PREFLIGHT_END.length) >= 0
  ) {
    throw new FlashError("UNSUPPORTED_DEVICE", "模块预检输出边界无效");
  }
  let suffixStart = end + PREFLIGHT_END.length;
  if (output.slice(suffixStart, suffixStart + 2) === "\r\n") suffixStart += 2;
  else if (output[suffixStart] === "\n") suffixStart += 1;
  diagnostic(
    "PREFLIGHT_ENVELOPE",
    `prefix_bytes=${encoder.encode(output.slice(0, begin)).byteLength} suffix_bytes=${encoder.encode(output.slice(suffixStart)).byteLength}`,
  );
  const framedOutput = output.slice(beginLineEnd + 1, end);
  const values = new Map<string, string>();
  let noiseLines = 0;
  let noiseBytes = 0;
  for (const rawLine of framedOutput.split("\n")) {
    const line = rawLine.replaceAll("\r", "");
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator < 1) {
      noiseLines += 1;
      noiseBytes += encoder.encode(`${rawLine}\n`).byteLength;
      continue;
    }
    const key = line.slice(0, separator);
    if (!EXPECTED_KEYS.includes(key as typeof EXPECTED_KEYS[number]) || values.has(key)) {
      throw new FlashError("UNSUPPORTED_DEVICE", "模块预检包含未知或重复字段");
    }
    values.set(key, line.slice(separator + 1));
  }
  if (noiseLines > 0) diagnostic("PREFLIGHT_NOISE", `lines=${noiseLines} bytes=${noiseBytes}`, "warn");
  if (values.size !== EXPECTED_KEYS.length || EXPECTED_KEYS.some((key) => !values.has(key))) {
    throw new FlashError("UNSUPPORTED_DEVICE", "模块预检字段不完整");
  }
  const uid = values.get("uid")!.trim();
  const usbIdentity = values.get("usb")!.trim();
  diagnostic(
    "PREFLIGHT_FIELDS",
    `uid=${uid} arch=${values.get("arch")} kernel=${values.get("kernel")} usb=${usbIdentity} functions=${values.get("functions")} serial_connected=${values.get("serial_connected")} agent=${values.get("agent")} agent_pid=${values.get("agent_pid")} port_7575=${values.get("port_7575")} availableKiB=${Math.floor(Number(values.get("available")) / 1024)} busybox=${values.get("cap_busybox")} sha256=${values.get("cap_sha256")} wget=${values.get("cap_wget")}`,
  );
  if (uid !== "0" || usbIdentity.toLowerCase() !== "2c7c:0125") {
    throw new FlashError("UNSUPPORTED_DEVICE", `USB 设备身份不符合 QDC507 刷写要求（uid=${uid}，usb=${usbIdentity || "missing"}）`);
  }
  if (values.get("arch") !== "armv7l" || !values.get("kernel")!.startsWith("3.18.44")) {
    throw new FlashError("UNSUPPORTED_PLATFORM", "模块 CPU 或内核版本不受支持");
  }
  if (values.get("call") !== "NONE") throw new FlashError("CALL_ACTIVE", "模块正在通话或无法确认通话状态");
  const factoryText = values.get("factory_pid")!;
  if (!DECIMAL.test(factoryText) || factoryText === "0") throw new FlashError("FACTORY_SERVICE_UNHEALTHY", "原厂服务未正常运行");
  const availableText = values.get("available")!;
  if (!DECIMAL.test(availableText)) throw new FlashError("INSUFFICIENT_SPACE", "模块可用空间数据无效");
  const availableBytes = Number(availableText);
  if (!Number.isSafeInteger(availableBytes)) throw new FlashError("INSUFFICIENT_SPACE", "模块可用空间数据无效");
  const agent = values.get("agent")!;
  if (agent !== "none" && !VERSION.test(agent)) throw new FlashError("UNSUPPORTED_DEVICE", "已安装 Agent 版本格式无效");
  const agentPidText = values.get("agent_pid")!;
  if (agentPidText !== "none" && (!DECIMAL.test(agentPidText) || agentPidText === "0")) {
    throw new FlashError("UNSUPPORTED_DEVICE", "Agent 进程状态格式无效");
  }
  const capability = (key: string): boolean => {
    const value = values.get(key);
    if (value !== "0" && value !== "1") throw new FlashError("UNSUPPORTED_DEVICE", `能力字段无效：${key}`);
    return value === "1";
  };
  const capabilities = {
    busybox: capability("cap_busybox"), sha256: capability("cap_sha256"), wget: capability("cap_wget"),
  };
  const port7575Listening = capability("port_7575");
  const serialConnected = capability("serial_connected");
  if (!capabilities.busybox || !capabilities.sha256 || !capabilities.wget) {
    throw new FlashError("UNSUPPORTED_DEVICE", "模块缺少刷写所需 BusyBox 能力");
  }
  return {
    platform: MODULE_PLATFORM,
    availableBytes,
    factoryPid: Number(factoryText),
    callState: "NONE",
    installedVersion: agent === "none" ? undefined : agent,
    usbFunctions: values.get("functions")!,
    agentPid: agentPidText === "none" ? undefined : Number(agentPidText),
    port7575Listening,
    serialConnected,
    capabilities,
  };
}

type PreflightClient = Pick<AdbClient, "runShell">;

export async function runPreflight(client: PreflightClient): Promise<PreflightResult> {
  const first = parsePreflight(await client.runShell({ kind: "preflight" }));
  const second = parsePreflight(await client.runShell({ kind: "preflight" }));
  if (first.factoryPid !== second.factoryPid) {
    throw new FlashError("FACTORY_SERVICE_UNHEALTHY", "两次预检之间原厂服务 PID 发生变化");
  }
  return second;
}
