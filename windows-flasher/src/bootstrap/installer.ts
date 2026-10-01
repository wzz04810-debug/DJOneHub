import type { AdbClient, BootstrapTargetName, FixedShellCommand } from "../adb/client";
import { rootfsPath, rootfsWritePath, type AdbSync } from "../adb/sync";
import { diagnostic } from "../diagnostics";
import { FlashError } from "../domain";
import type { BootstrapBundle, BootstrapFile } from "./package";

const INSPECT_BEGIN = "DJONEHUB_BOOTSTRAP_INSPECT_BEGIN";
const INSPECT_END = "DJONEHUB_BOOTSTRAP_INSPECT_END";
const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL = /^(0|[1-9]\d*)$/;
const SAFE_LINK_TARGET = /^\.\.\/init\.d\/[A-Za-z0-9._-]{1,80}$/;
const TRANSACTION_MARGIN_BYTES = 128 * 1024;

type BootstrapClient = Pick<AdbClient, "runShell">;
type BootstrapSync = Pick<AdbSync, "pull" | "push">;
type ExistingFile = { readonly size: number; readonly sha256: string } | undefined;
type HostBackup = { readonly file: BootstrapFile; readonly bytes?: Uint8Array; readonly sha256?: string };

export type BootstrapProgress = {
  readonly step: number;
  readonly detail: string;
};

type BootstrapInspection = {
  readonly rootFreeBytes: number;
  readonly installed: boolean;
  readonly agentRunning: boolean;
  readonly linkTarget: string | null;
  readonly files: ReadonlyMap<BootstrapTargetName, ExistingFile>;
};

function parseRecords(output: string, begin: string, end: string): Map<string, string> {
  const normalized = output.replaceAll("\r", "");
  const start = normalized.indexOf(`${begin}\n`);
  const finish = normalized.indexOf(`\n${end}`, start + begin.length + 1);
  if (start < 0 || finish < 0 || normalized.indexOf(begin, start + begin.length) >= 0 || normalized.indexOf(end, finish + end.length) >= 0) {
    throw new FlashError("UNSUPPORTED_DEVICE", "Bootstrap 预检输出边界无效");
  }
  const records = new Map<string, string>();
  for (const line of normalized.slice(start + begin.length + 1, finish).split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1 || records.has(line.slice(0, separator))) throw new FlashError("UNSUPPORTED_DEVICE", "Bootstrap 预检字段无效");
    records.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return records;
}

function parseInspection(output: string, bundle: BootstrapBundle): BootstrapInspection {
  const records = parseRecords(output, INSPECT_BEGIN, INSPECT_END);
  const expected = new Set(["uid", "arch", "kernel", "usb", "factory_pid", "functions", "mount", "root_free", "installed", "agent_running", "link", ...bundle.files.map((file) => `file.${file.name}`)]);
  if (records.size !== expected.size || [...records.keys()].some((key) => !expected.has(key))) throw new FlashError("UNSUPPORTED_DEVICE", "Bootstrap 预检字段不完整或包含未知字段");
  if (records.get("uid") !== "0" || records.get("usb")?.toLowerCase() !== "2c7c:0125") throw new FlashError("UNSUPPORTED_DEVICE", "Bootstrap 仅支持已验证的 QDC507 root 设备");
  if (records.get("arch") !== "armv7l" || records.get("kernel") !== "3.18.44") throw new FlashError("UNSUPPORTED_PLATFORM", "Bootstrap 仅支持 armv7l Linux 3.18.44");
  const factory = records.get("factory_pid")!;
  if (!DECIMAL.test(factory) || factory === "0") throw new FlashError("FACTORY_SERVICE_UNHEALTHY", "Bootstrap 刷写前原厂服务未运行");
  if (!records.get("mount")?.includes("ubi0:rootfs on / type ubifs")) throw new FlashError("UNSUPPORTED_DEVICE", "根文件系统不是预期的 UBIFS");
  const rootFree = records.get("root_free")!;
  if (!DECIMAL.test(rootFree) || !Number.isSafeInteger(Number(rootFree))) throw new FlashError("SPACE_CHECK_FAILED", "无法读取 rootfs 可用空间");
  const installed = records.get("installed");
  const agentRunning = records.get("agent_running");
  if ((installed !== "0" && installed !== "1") || (agentRunning !== "0" && agentRunning !== "1")) throw new FlashError("UNSUPPORTED_DEVICE", "Bootstrap 运行状态无效");
  const files = new Map<BootstrapTargetName, ExistingFile>();
  for (const file of bundle.files) {
    const state = records.get(`file.${file.name}`)!;
    if (state === "missing") {
      files.set(file.name as BootstrapTargetName, undefined);
      continue;
    }
    const match = /^((?:0|[1-9]\d*)),([a-f0-9]{64})$/.exec(state);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new FlashError("UNSUPPORTED_DEVICE", `rootfs 文件状态无效：${file.name}`);
    files.set(file.name as BootstrapTargetName, { size: Number(match[1]), sha256: match[2]! });
  }
  const link = records.get("link")!;
  if (link !== "missing" && !SAFE_LINK_TARGET.test(link)) throw new FlashError("UNSUPPORTED_DEVICE", "Bootstrap 旧启动链接目标不安全");
  return { rootFreeBytes: Number(rootFree), installed: installed === "1", agentRunning: agentRunning === "1", linkTarget: link === "missing" ? null : link, files };
}

function parseAgentCallSafety(output: string): boolean {
  let value: unknown;
  try { value = JSON.parse(output); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return status.polling === true
    && status.active === null
    && typeof status.last_poll_error === "string"
    && status.last_poll_error.trim() === "";
}

function parseSimpleResult(output: string, expected: string): void {
  if (output.replaceAll("\r", "").trim() !== expected) throw new FlashError("INSTALL_FAILED", `模块未确认 Bootstrap 操作：${expected}`);
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(value, (part) => part.toString(16).padStart(2, "0")).join("");
}

async function restore(
  client: BootstrapClient,
  sync: BootstrapSync,
  backups: readonly HostBackup[],
  inspection: BootstrapInspection,
): Promise<void> {
  parseSimpleResult(await client.runShell({ kind: "bootstrap-prepare-rollback" }), "prepared=rw");
  for (const backup of backups) {
    const name = backup.file.name as BootstrapTargetName;
    parseSimpleResult(await client.runShell({ kind: "bootstrap-remove-target", name }), `removed=${name}`);
    if (!backup.bytes || !backup.sha256) continue;
    await sync.push(rootfsWritePath(backup.file.remotePath, "restore"), backup.bytes, backup.file.mode);
    parseSimpleResult(await client.runShell({ kind: "bootstrap-restore-target", name, sha256: backup.sha256 }), `restored=${backup.sha256}`);
  }
  const result = (await client.runShell({ kind: "bootstrap-finalize-rollback", linkTarget: inspection.linkTarget, restoreAgent: inspection.agentRunning })).replaceAll("\r", "").trim();
  if (result !== `rootfs=ro\nagent_running=${inspection.agentRunning ? 1 : 0}`) throw new FlashError("ROLLBACK_UNCONFIRMED", "Bootstrap 回滚后 rootfs 或 Agent 状态无法确认");
}

function verifyFinal(output: string, bundle: BootstrapBundle, agentRunning: boolean): void {
  const records = new Map<string, string>();
  for (const line of output.replaceAll("\r", "").trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1 || records.has(line.slice(0, separator))) throw new FlashError("HEALTH_CHECK_FAILED", "Bootstrap 最终验证格式无效");
    records.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const expectedKeys = new Set([...bundle.files.map((file) => `sha.${file.name}`), "link", "rootfs", "executable", "agent_running"]);
  if (records.size !== expectedKeys.size || [...records.keys()].some((key) => !expectedKeys.has(key))) throw new FlashError("HEALTH_CHECK_FAILED", "Bootstrap 最终验证字段无效");
  for (const file of bundle.files) if (records.get(`sha.${file.name}`) !== file.sha256) throw new FlashError("HEALTH_CHECK_FAILED", `Bootstrap 最终摘要不匹配：${file.name}`);
  if (records.get("link") !== "../init.d/djonehub_bootstrap" || records.get("rootfs") !== "ro" || records.get("executable") !== "1" || records.get("agent_running") !== (agentRunning ? "1" : "0")) {
    throw new FlashError("HEALTH_CHECK_FAILED", "Bootstrap rootfs、启动链接或 Agent 最终状态无效");
  }
}

export async function installBootstrap(
  client: BootstrapClient,
  sync: BootstrapSync,
  bundle: BootstrapBundle,
  onProgress?: (progress: BootstrapProgress) => void,
  signal?: AbortSignal,
): Promise<{ readonly version: string }> {
  const step = (value: number, detail: string) => { onProgress?.({ step: value, detail }); diagnostic("BOOTSTRAP_STEP", `${value}/14 ${detail}`); };
  const run = (command: FixedShellCommand) => client.runShell(command, signal);
  step(3, "验证 QDC507 身份与 rootfs 状态");
  const inspection = parseInspection(await run({ kind: "bootstrap-inspect" }), bundle);
  step(4, "检查原厂服务与 USB profile");
  step(5, inspection.agentRunning ? "使用 Agent 检查通话安全门" : "使用原厂 QMI 检查通话安全门");
  if (inspection.agentRunning) {
    const callStatus = await run({ kind: "bootstrap-call-agent" });
    if (!parseAgentCallSafety(callStatus)) throw new FlashError("CALL_ACTIVE", "Agent 通话轮询未就绪或存在活动通话，拒绝写入 rootfs");
    diagnostic("BOOTSTRAP_CALL_SAFETY", "source=agent polling=true active=none");
  } else {
    const qmi = await run({ kind: "bootstrap-call-qmi" });
    if (!qmi.split(/\s+/).includes("TRUE")) throw new FlashError("CALL_ACTIVE", "原厂 QMI 无法确认当前无活动通话，拒绝写入 rootfs");
    diagnostic("BOOTSTRAP_CALL_SAFETY", "source=qmi safe=true");
  }
  step(6, "执行 preclean 并保护 update-pending");
  const preclean = (await run({ kind: "preclean" })).trim();
  if (!/^v1 (?:0|[1-9]\d*) (?:0|[1-9]\d*) (?:0|[1-9]\d*)$/.test(preclean)) throw new FlashError("INSTALL_FAILED", "Bootstrap preclean 结果无效");
  step(7, "将旧 rootfs 文件保存到浏览器内存");
  const backups: HostBackup[] = [];
  let reclaimableBytes = 0;
  for (const file of bundle.files) {
    const existing = inspection.files.get(file.name as BootstrapTargetName);
    if (!existing) {
      backups.push({ file });
      continue;
    }
    const bytes = await sync.pull(rootfsPath(file.remotePath), undefined, signal);
    if (bytes.byteLength !== existing.size || await digest(bytes) !== existing.sha256) throw new FlashError("ROLLBACK_UNCONFIRMED", `旧 rootfs 文件内存备份校验失败：${file.name}`);
    backups.push({ file, bytes, sha256: existing.sha256 });
    reclaimableBytes += bytes.byteLength;
  }
  const requiredBytes = bundle.files.reduce((total, file) => total + file.bytes.byteLength, TRANSACTION_MARGIN_BYTES);
  step(8, `规划 rootfs 替换空间：需要 ${requiredBytes} 字节`);
  if (inspection.rootFreeBytes + reclaimableBytes < requiredBytes) throw new FlashError("INSUFFICIENT_SPACE", `rootfs 可用及可替换空间 ${inspection.rootFreeBytes + reclaimableBytes}，需要 ${requiredBytes}`);
  let modified = false;
  try {
    modified = true;
    step(9, "优雅停止 Agent supervisor 并重挂 rootfs 为可写");
    parseSimpleResult(await run({ kind: "bootstrap-prepare-write" }), "prepared=rw");
    for (const file of bundle.files) {
      const name = file.name as BootstrapTargetName;
      step(10, `替换 ${file.remotePath}`);
      parseSimpleResult(await run({ kind: "bootstrap-remove-target", name }), `removed=${name}`);
      await sync.push(rootfsWritePath(file.remotePath, "next"), file.bytes, file.mode, undefined, signal);
      parseSimpleResult(await run({ kind: "bootstrap-commit-target", name, sha256: file.sha256 }), `committed=${file.sha256}`);
    }
    step(11, "写入 rc5 链接并有界重挂 rootfs 为只读");
    const finalized = (await run({ kind: "bootstrap-finalize", restoreAgent: inspection.agentRunning })).replaceAll("\r", "").trim();
    if (finalized !== `rootfs=ro\nagent_running=${inspection.agentRunning ? 1 : 0}`) throw new FlashError("INSTALL_FAILED", "Bootstrap 提交后 rootfs 或 Agent 状态未确认");
    step(12, inspection.agentRunning ? "恢复 Agent supervisor 原运行状态" : "保持 Agent 原停止状态");
    step(13, "最终校验逐文件摘要、rootfs、rc5 和 Agent 状态");
    verifyFinal(await run({ kind: "bootstrap-verify" }), bundle, inspection.agentRunning);
    modified = false;
    step(14, "Bootstrap 0.1.0 刷写并验证完成");
    return { version: bundle.version };
  } catch (error) {
    if (!modified) throw error;
    diagnostic("BOOTSTRAP_ROLLBACK", "starting browser-memory rollback", "warn");
    try {
      await restore(client, sync, backups, inspection);
      diagnostic("BOOTSTRAP_ROLLBACK", "completed rootfs=ro");
    } catch (rollbackError) {
      throw new FlashError("ROLLBACK_UNCONFIRMED", "Bootstrap 写入失败且自动回滚无法确认；请保持供电", { cause: rollbackError });
    }
    throw error;
  }
}
