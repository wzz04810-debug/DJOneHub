import type { AdbClient, PayloadEntry, PayloadName, RestorePayloadEntry } from "../adb/client";
import { agentRestorePath, installedPath, type AdbSync } from "../adb/sync";
import { diagnostic } from "../diagnostics";
import { FlashError } from "../domain";
import type { VerifiedFile, VerifiedPackage } from "../release/schema";

const DECIMAL = /^(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOG_CLEAR_THRESHOLD_BYTES = 1024 * 1024;
const AGENT_RECOVERY_NAME = "qdc507-agent.recovery";
const SPACE_RECHECK_BEGIN = "DJONEHUB_SPACE_RECHECK_BEGIN";
const SPACE_RECHECK_END = "DJONEHUB_SPACE_RECHECK_END";

const PAYLOADS: Readonly<Record<PayloadName, { readonly path: string; readonly mode: 0o644 | 0o755 }>> = {
  "qdc507-agent": { path: "/data/djonehub/bin/qdc507-agent", mode: 0o755 },
  "qdc507_data11_bridge.ko": { path: "/data/djonehub/kernel/qdc507_data11_bridge.ko", mode: 0o644 },
  "qdc507_aprv3.ko": { path: "/data/djonehub/voice-runtime/qdc507_aprv3.ko", mode: 0o644 },
  "qdc507_voice.ko": { path: "/data/djonehub/voice-runtime/qdc507_voice.ko", mode: 0o644 },
  "mavo-pcm-bridge.armv7": { path: "/data/djonehub/voice-runtime/mavo-pcm-bridge.armv7", mode: 0o755 },
};

type RecoveryClient = Pick<AdbClient, "runShell">;
export type RecoverySync = Pick<AdbSync, "pull" | "push">;

export type Replacement = {
  readonly archivePath: string;
  readonly file: VerifiedFile;
  readonly name: PayloadName;
  readonly newSha256: string;
  readonly installedSha256: string | undefined;
};

export type ExternalBackup = RestorePayloadEntry & {
  readonly bytes: Uint8Array;
  readonly path: string;
};

export type ReclaimStrategy = "backup" | "direct";

async function digest(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(value, (part) => part.toString(16).padStart(2, "0")).join("");
}

function parseSpaceRecheck(output: string): number {
  const normalized = output.replaceAll("\r", "");
  const beginToken = `${SPACE_RECHECK_BEGIN}\n`;
  const endToken = `\n${SPACE_RECHECK_END}`;
  const begin = normalized.indexOf(beginToken);
  const end = normalized.indexOf(endToken, begin + beginToken.length);
  let value = normalized.trim();

  if (begin >= 0 || normalized.includes(SPACE_RECHECK_END)) {
    const duplicateBegin = begin >= 0 && normalized.indexOf(beginToken, begin + beginToken.length) >= 0;
    const duplicateEnd = end >= 0 && normalized.indexOf(endToken, end + endToken.length) >= 0;
    if (begin < 0 || end < begin || duplicateBegin || duplicateEnd) {
      throw new FlashError("SPACE_CHECK_FAILED", "模块空间复检输出边界无效");
    }
    value = normalized.slice(begin + beginToken.length, end).trim();
    diagnostic(
      "SPACE_RECHECK_ENVELOPE",
      `prefix_bytes=${begin} payload_bytes=${value.length} suffix_bytes=${normalized.length - end - endToken.length}`,
    );
  }

  if (!DECIMAL.test(value)) throw new FlashError("SPACE_CHECK_FAILED", "模块空间复检结果无效");
  const available = Number(value);
  if (!Number.isSafeInteger(available)) throw new FlashError("SPACE_CHECK_FAILED", "模块空间复检数值无效");
  return available;
}

async function runPreclean(client: RecoveryClient): Promise<number> {
  const preclean = (await client.runShell({ kind: "preclean" })).trim();
  const match = /^v1 ((?:0|[1-9]\d*)) ((?:0|[1-9]\d*)) ((?:0|[1-9]\d*))$/.exec(preclean);
  if (!match) throw new FlashError("UNSUPPORTED_DEVICE", "模块 preclean 结果无效");
  const before = Number(match[1]);
  const after = Number(match[2]);
  const freed = Number(match[3]);
  if (
    !Number.isSafeInteger(before)
    || !Number.isSafeInteger(after)
    || !Number.isSafeInteger(freed)
    || freed !== Math.max(0, after - before)
  ) {
    throw new FlashError("UNSUPPORTED_DEVICE", "模块 preclean 数值无效");
  }
  diagnostic("PRECLEAN", `phase=precleaning before_kib=${Math.floor(before / 1024)} after_kib=${Math.floor(after / 1024)} freed_kib=${Math.floor(freed / 1024)}`, "warn");
  return after;
}

export async function inspectInstalledPayloads(client: RecoveryClient): Promise<ReadonlyMap<PayloadName, string | undefined>> {
  const output = (await client.runShell({ kind: "payload-hashes" })).replaceAll("\r", "");
  const values = new Map<PayloadName, string | undefined>();
  for (const line of output.trim().split("\n")) {
    const separator = line.indexOf("=");
    const name = line.slice(0, separator) as PayloadName;
    const value = line.slice(separator + 1);
    if (separator < 1 || !(name in PAYLOADS) || values.has(name) || (value !== "missing" && !SHA256.test(value))) {
      throw new FlashError("UNSUPPORTED_DEVICE", "模块 payload 清单格式无效");
    }
    values.set(name, value === "missing" ? undefined : value);
  }
  if (values.size !== Object.keys(PAYLOADS).length) throw new FlashError("UNSUPPORTED_DEVICE", "模块 payload 清单不完整");
  return values;
}

export function selectPayloadUploads(
  pkg: VerifiedPackage,
  installed: ReadonlyMap<PayloadName, string | undefined>,
): { readonly uploads: Map<string, VerifiedFile>; readonly replacements: readonly Replacement[] } {
  const declared = new Map(pkg.manifest.files.map((file) => [file.archive_path, file]));
  const uploads = new Map<string, VerifiedFile>();
  const replacements: Replacement[] = [];
  for (const [archivePath, file] of pkg.files) {
    const declaration = declared.get(archivePath);
    const name = declaration?.name as PayloadName | undefined;
    if (!name || !(name in PAYLOADS) || !declaration || installed.get(name) !== declaration.sha256) {
      uploads.set(archivePath, file);
      if (name && name in PAYLOADS && declaration) {
        replacements.push({ archivePath, file, name, newSha256: declaration.sha256, installedSha256: installed.get(name) });
      }
    }
  }
  return { uploads, replacements };
}

export async function restoreExternalBackups(
  client: RecoveryClient,
  sync: RecoverySync,
  directory: string,
  backups: readonly ExternalBackup[],
): Promise<void> {
  if (backups.length === 0) return;
  if (backups.length !== 1 || backups[0]?.name !== "qdc507-agent") {
    throw new FlashError("ROLLBACK_UNCONFIRMED", "外部回滚只允许恢复已验证的 Agent");
  }
  const backup = backups[0];
  diagnostic("ROLLBACK_RESTORE_START", "files=1 mode=direct-agent");
  await client.runShell({ kind: "prepare-agent-restore", stagingPath: directory });
  await sync.push(agentRestorePath(), backup.bytes, 0o755);
  await client.runShell({ kind: "restore-agent", sha256: backup.sha256 });
  diagnostic("ROLLBACK_RESTORE_OK", "files=1 mode=direct-agent");
}

export async function reclaimSpaceWithBackups(
  client: RecoveryClient,
  sync: RecoverySync,
  directory: string,
  replacements: readonly Replacement[],
  availableBytes: number,
  requiredBytes: number,
  signal?: AbortSignal,
  onBackupsReady?: (backups: readonly ExternalBackup[]) => void,
  strategy: ReclaimStrategy = "backup",
): Promise<readonly ExternalBackup[]> {
  const candidates = replacements.filter((replacement) => replacement.installedSha256 !== undefined);
  const backups: ExternalBackup[] = [];
  let currentAvailable = availableBytes;
  const maintenance = (await client.runShell({ kind: "maintain-log" })).trim();
  const logMatch = /^(missing|kept|cleared) ((?:0|[1-9]\d*)) ((?:0|[1-9]\d*))$/.exec(maintenance);
  if (!logMatch) throw new FlashError("UNSUPPORTED_DEVICE", "模块日志维护结果无效");
  const logStatus = logMatch[1]!;
  const logSize = Number(logMatch[2]);
  currentAvailable = Number(logMatch[3]);
  if (!Number.isSafeInteger(logSize) || !Number.isSafeInteger(currentAvailable)) {
    throw new FlashError("UNSUPPORTED_DEVICE", "模块日志维护数值无效");
  }
  if (
    (logStatus === "cleared") !== (logSize > LOG_CLEAR_THRESHOLD_BYTES)
    || (logStatus === "missing" && logSize !== 0)
  ) {
    throw new FlashError("UNSUPPORTED_DEVICE", "模块日志维护状态无效");
  }
  diagnostic("LOG_MAINTENANCE", `status=${logStatus} size_kib=${Math.floor(logSize / 1024)} available_kib=${Math.floor(currentAvailable / 1024)}`);
  diagnostic("SPACE_CHECK", `available_kib=${Math.floor(currentAvailable / 1024)} required_kib=${Math.floor(requiredBytes / 1024)} replacements=${candidates.length}`);

  if (strategy === "direct") {
    const output = (await client.runShell({ kind: "payload-sizes" })).replaceAll("\r", "");
    const sizes = new Map<PayloadName | typeof AGENT_RECOVERY_NAME, number | undefined>();
    for (const line of output.trim().split("\n")) {
      const separator = line.indexOf("=");
      const name = line.slice(0, separator) as PayloadName | typeof AGENT_RECOVERY_NAME;
      const value = line.slice(separator + 1);
      if (
        separator < 1
        || (!(name in PAYLOADS) && name !== AGENT_RECOVERY_NAME)
        || sizes.has(name)
        || (value !== "missing" && !DECIMAL.test(value))
      ) {
        throw new FlashError("UNSUPPORTED_DEVICE", "模块 payload 大小清单格式无效");
      }
      const size = value === "missing" ? undefined : Number(value);
      if (size !== undefined && !Number.isSafeInteger(size)) {
        throw new FlashError("UNSUPPORTED_DEVICE", "模块 payload 大小数值无效");
      }
      sizes.set(name, size);
    }
    if (sizes.size !== Object.keys(PAYLOADS).length + 1 || !sizes.has(AGENT_RECOVERY_NAME)) {
      throw new FlashError("UNSUPPORTED_DEVICE", "模块 payload 大小清单不完整");
    }
    const payloadBytes = candidates.reduce((total, replacement) => total + (sizes.get(replacement.name) ?? 0), 0);
    const agentBytes = candidates.some((replacement) => replacement.name === "qdc507-agent")
      ? (sizes.get("qdc507-agent") ?? 0)
      : 0;
    const recoveryBytes = sizes.get(AGENT_RECOVERY_NAME) ?? 0;
    const recoverableBytes = payloadBytes + Math.max(0, recoveryBytes - agentBytes);
    diagnostic("DIRECT_RECLAIM_PLAN", `recoverable_kib=${Math.floor(recoverableBytes / 1024)} recovery_kib=${Math.floor(recoveryBytes / 1024)} files=${candidates.length}`);
    if (currentAvailable + recoverableBytes < requiredBytes) {
      currentAvailable = await runPreclean(client);
      if (currentAvailable + recoverableBytes < requiredBytes) {
        throw new FlashError("INSUFFICIENT_SPACE", "preclean 后模块空间仍不足");
      }
    }

    const entries: PayloadEntry[] = candidates.map(({ name, installedSha256 }) => ({ name, sha256: installedSha256! }));
    currentAvailable = parseSpaceRecheck(await client.runShell({ kind: "remove-payloads", entries, discardRecovery: true }));
    diagnostic("SPACE_RECLAIM", `mode=direct removed=${entries.length} available_kib=${Math.floor(currentAvailable / 1024)} required_kib=${Math.floor(requiredBytes / 1024)}`);
    if (currentAvailable < requiredBytes) {
      throw new FlashError("ROLLBACK_UNCONFIRMED", "旧文件已直接移除，但释放空间仍不足；请保持供电并重新刷写");
    }
    return [];
  }

  if (currentAvailable >= requiredBytes) return [];

  // Match the native Mac installer: clear only safe, rebuildable artifacts
  // before deciding whether an old payload must be held in host memory.
  currentAvailable = await runPreclean(client);
  if (currentAvailable >= requiredBytes) return [];

  const agent = candidates.find((replacement) => replacement.name === "qdc507-agent");
  if (agent?.installedSha256) {
    const spec = PAYLOADS[agent.name];
    const bytes = await sync.pull(installedPath(spec.path), undefined, signal);
    if (await digest(bytes) !== agent.installedSha256) {
      throw new FlashError("ROLLBACK_UNCONFIRMED", "旧文件备份校验失败：qdc507-agent");
    }
    backups.push({ name: agent.name, path: spec.path, mode: spec.mode, sha256: agent.installedSha256, bytes });
    diagnostic("ROLLBACK_BACKUP_OK", `file=${agent.name} size_kib=${Math.floor(bytes.byteLength / 1024)}`);
  }
  const recoverableBytes = backups.reduce((total, backup) => total + backup.bytes.byteLength, 0);
  if (currentAvailable + recoverableBytes < requiredBytes) {
    throw new FlashError("INSUFFICIENT_SPACE", "即使备份并移除旧文件，模块空间仍不足");
  }
  if (backups.length === 0) throw new FlashError("INSUFFICIENT_SPACE", "模块没有可安全备份并释放的旧文件");

  const removed: ExternalBackup[] = [];
  onBackupsReady?.(backups);
  const entries: PayloadEntry[] = backups.map(({ name, sha256 }) => ({ name, sha256 }));
  currentAvailable = parseSpaceRecheck(await client.runShell({ kind: "remove-payloads", entries, discardRecovery: true }));
  diagnostic("SPACE_RECLAIM", `removed=${backups.length} available_kib=${Math.floor(currentAvailable / 1024)} required_kib=${Math.floor(requiredBytes / 1024)}`);
  removed.push(...backups);
  if (currentAvailable < requiredBytes) {
    await restoreExternalBackups(client, sync, directory, removed);
    throw new FlashError("INSUFFICIENT_SPACE", "移除已备份文件后空间仍不足，已恢复原文件");
  }
  return removed;
}
