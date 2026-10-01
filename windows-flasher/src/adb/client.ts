import precleanV1 from "../assets/preclean-v1.sh?raw";
import { diagnostic } from "../diagnostics";
import { FlashError } from "../domain";
import {
  ADB_AUTH,
  ADB_CLSE,
  ADB_CNXN,
  ADB_OKAY,
  ADB_OPEN,
  ADB_WRTE,
  ascii,
  decodeAdbHeader,
  encodeAdbMessage,
  type AdbMessage,
  validateAdbPayload,
} from "./codec";

export interface AdbPacketIO {
  write(packet: Uint8Array): Promise<void>;
  readExact(length: number, signal?: AbortSignal, timeoutMs?: number): Promise<Uint8Array>;
}

export type FixedShellCommand =
  | { readonly kind: "identity" }
  | { readonly kind: "preflight" }
  | { readonly kind: "health" }
  | { readonly kind: "verify-health"; readonly expectedVersion: string; readonly expectedInitSha256: string }
  | { readonly kind: "install"; readonly stagingPath: string }
  | { readonly kind: "install-status"; readonly stagingPath: string }
  | { readonly kind: "payload-hashes" }
  | { readonly kind: "payload-sizes" }
  | { readonly kind: "preclean" }
  | { readonly kind: "remove-payloads"; readonly entries: readonly PayloadEntry[]; readonly discardRecovery?: boolean }
  | { readonly kind: "maintain-log" }
  | { readonly kind: "prepare-agent-restore"; readonly stagingPath: string }
  | { readonly kind: "restore-agent"; readonly sha256: string }
  | { readonly kind: "bootstrap-inspect" }
  | { readonly kind: "bootstrap-call-agent" }
  | { readonly kind: "bootstrap-call-qmi" }
  | { readonly kind: "bootstrap-prepare-write" }
  | { readonly kind: "bootstrap-prepare-rollback" }
  | { readonly kind: "bootstrap-remove-target"; readonly name: BootstrapTargetName }
  | { readonly kind: "bootstrap-commit-target"; readonly name: BootstrapTargetName; readonly sha256: string }
  | { readonly kind: "bootstrap-restore-target"; readonly name: BootstrapTargetName; readonly sha256: string }
  | { readonly kind: "bootstrap-finalize"; readonly restoreAgent: boolean }
  | { readonly kind: "bootstrap-finalize-rollback"; readonly linkTarget: string | null; readonly restoreAgent: boolean }
  | { readonly kind: "bootstrap-verify" };

export type PayloadName = "qdc507-agent" | "qdc507_data11_bridge.ko" | "qdc507_aprv3.ko" | "qdc507_voice.ko" | "mavo-pcm-bridge.armv7";
export type PayloadEntry = { readonly name: PayloadName; readonly sha256: string };
export type RestorePayloadEntry = PayloadEntry & { readonly mode: 0o644 | 0o755 };
export type BootstrapTargetName = "djonehub-bootstrap.json" | "djonehub_agent" | "djonehub_bootstrap" | "qdc507_data11_bridge.ko" | "djonehub-bootstrap";

export interface AdbServiceStream {
  write(payload: Uint8Array, signal?: AbortSignal): Promise<void>;
  read(signal?: AbortSignal, timeoutMs?: number): Promise<Uint8Array | null>;
  close(signal?: AbortSignal, timeoutMs?: number): Promise<void>;
}

const decoder = new TextDecoder();
const STAGING_DIRECTORY = /^\/data\/local\/tmp\/djonehub-webflash-[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ADB_CONNECT_TIMEOUT_MS = 8_000;
const ADB_ACK_TIMEOUT_MS = 10_000;
const ADB_CLOSE_TIMEOUT_MS = 5_000;
const MAX_STALE_STREAMS = 64;
const BOOTSTRAP_LINK = "/etc/rc5.d/S99zzz_djonehub_bootstrap";
const BOOTSTRAP_LINK_TARGET = "../init.d/djonehub_bootstrap";
const SAFE_LINK_TARGET = /^\.\.\/init\.d\/[A-Za-z0-9._-]{1,80}$/;
const BOOTSTRAP_TARGETS: Readonly<Record<BootstrapTargetName, { readonly path: string; readonly mode: 0o644 | 0o755 }>> = {
  "djonehub-bootstrap.json": { path: "/etc/djonehub-bootstrap.json", mode: 0o644 },
  "djonehub_agent": { path: "/etc/init.d/djonehub_agent", mode: 0o755 },
  "djonehub_bootstrap": { path: "/etc/init.d/djonehub_bootstrap", mode: 0o755 },
  "qdc507_data11_bridge.ko": { path: "/usr/lib/djonehub/qdc507_data11_bridge.ko", mode: 0o644 },
  "djonehub-bootstrap": { path: "/usr/sbin/djonehub-bootstrap", mode: 0o755 },
};
const PAYLOAD_TARGETS: Readonly<Record<PayloadName, string>> = {
  "qdc507-agent": "/data/djonehub/bin/qdc507-agent",
  "qdc507_data11_bridge.ko": "/data/djonehub/kernel/qdc507_data11_bridge.ko",
  "qdc507_aprv3.ko": "/data/djonehub/voice-runtime/qdc507_aprv3.ko",
  "qdc507_voice.ko": "/data/djonehub/voice-runtime/qdc507_voice.ko",
  "mavo-pcm-bridge.armv7": "/data/djonehub/voice-runtime/mavo-pcm-bridge.armv7",
};

function validatePayloadEntries(entries: readonly PayloadEntry[], allowEmpty = false): void {
  const names = new Set<string>();
  if ((!allowEmpty && entries.length === 0) || entries.length > Object.keys(PAYLOAD_TARGETS).length) throw new Error("PAYLOAD_ENTRIES_INVALID");
  for (const entry of entries) {
    if (!(entry.name in PAYLOAD_TARGETS) || !SHA256.test(entry.sha256) || names.has(entry.name)) throw new Error("PAYLOAD_ENTRIES_INVALID");
    names.add(entry.name);
  }
}

function commandLabel(command: number): string {
  switch (command) {
    case ADB_AUTH: return "AUTH";
    case ADB_CLSE: return "CLSE";
    case ADB_CNXN: return "CNXN";
    case ADB_OKAY: return "OKAY";
    case ADB_OPEN: return "OPEN";
    case ADB_WRTE: return "WRTE";
    default: return `0x${command.toString(16)}`;
  }
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Operation aborted", "AbortError");
  }
}

function bootstrapPrepareCommand(): string {
  return "set -e; if test -x /etc/init.d/djonehub_agent; then /etc/init.d/djonehub_agent stop; fi; attempt=0; while test \"$attempt\" -lt 10 && test -x /etc/init.d/djonehub_agent && /etc/init.d/djonehub_agent status >/dev/null 2>&1; do attempt=$((attempt+1)); sleep 1; done; if test -x /etc/init.d/djonehub_agent && /etc/init.d/djonehub_agent status >/dev/null 2>&1; then exit 75; fi; test ! -x /etc/init.d/djonehub_bootstrap || /etc/init.d/djonehub_bootstrap stop >/dev/null 2>&1 || true; killall djonehub-bootstrap >/dev/null 2>&1 || true; mount -o remount,rw /; mount | grep -Fq 'ubi0:rootfs on / type ubifs (rw,'; mkdir -p /usr/sbin /usr/lib/djonehub /etc/init.d /etc/rc5.d; printf 'prepared=rw\\n'";
}

function bootstrapRemountReadOnlyCommand(): string {
  return "cd /data; sync; attempt=0; remount_ok=0; while test \"$attempt\" -lt 10; do attempt=$((attempt+1)); if mount -o remount,ro / >/dev/null 2>&1 && mount | grep -Fq 'ubi0:rootfs on / type ubifs (ro,'; then remount_ok=1; break; fi; sync; sleep 1; done; test \"$remount_ok\" = 1";
}

function bootstrapAgentRestoreCommand(restoreAgent: boolean): string {
  return restoreAgent
    ? "test -x /etc/init.d/djonehub_agent; /etc/init.d/djonehub_agent start; attempt=0; while test \"$attempt\" -lt 10 && ! /etc/init.d/djonehub_agent status >/dev/null 2>&1; do attempt=$((attempt+1)); sleep 1; done; /etc/init.d/djonehub_agent status >/dev/null 2>&1; agent_running=1"
    : "agent_running=0";
}

function buildUnframedFixedShellCommand(command: FixedShellCommand): string {
  switch (command.kind) {
    case "identity":
      return "uname -m";
    case "preflight":
      return "uid=$(id -u); arch=$(uname -m); kernel=$(uname -r); vendor=$(cat /sys/devices/virtual/android_usb/android0/idVendor 2>/dev/null); product=$(cat /sys/devices/virtual/android_usb/android0/idProduct 2>/dev/null); factory=$(pidof ql_manager_server 2>/dev/null); call_result=$( (sleep 1; printf 'block_check_condition call_state NONE\\n'; sleep 1; printf 'quit\\n') | timeout -t 8 /usr/bin/qmi_simple_ril_test 2>&1 | tail -n 40); case \"$call_result\" in *TRUE*) call=NONE;; *) call=ACTIVE;; esac; available=$(df -Pk /data | awk 'NR==2 {print $4 * 1024}'); functions=$(cat /sys/devices/virtual/android_usb/android0/functions 2>/dev/null); serial_connected=$(cat /sys/devices/virtual/android_usb/android0/f_serial/connected 2>/dev/null); test \"$serial_connected\" = 1 || serial_connected=0; agent=$(cat /data/djonehub/version 2>/dev/null || echo none); agent_pid=$(pidof qdc507-agent 2>/dev/null | awk '{print $1}'); test -n \"$agent_pid\" || agent_pid=none; port_7575=$(awk '$2 ~ /:1D97$/ && $4 == \"0A\" {found=1} END {print found ? 1 : 0}' /proc/net/tcp 2>/dev/null); test \"$port_7575\" = 1 || port_7575=0; command -v busybox >/dev/null 2>&1 && cb=1 || cb=0; busybox sha256sum --help >/dev/null 2>&1 && cs=1 || cs=0; busybox wget --help >/dev/null 2>&1 && cw=1 || cw=0; printf 'uid=%s\\narch=%s\\nkernel=%s\\nusb=%s:%s\\nfactory_pid=%s\\ncall=%s\\navailable=%s\\nfunctions=%s\\nagent=%s\\nagent_pid=%s\\nport_7575=%s\\nserial_connected=%s\\ncap_busybox=%s\\ncap_sha256=%s\\ncap_wget=%s\\n' \"$uid\" \"$arch\" \"$kernel\" \"$vendor\" \"$product\" \"$factory\" \"$call\" \"$available\" \"$functions\" \"$agent\" \"$agent_pid\" \"$port_7575\" \"$serial_connected\" \"$cb\" \"$cs\" \"$cw\"";
    case "health":
      return "busybox wget -q -T 8 -O - http://127.0.0.1:7575/api/health";
    case "verify-health":
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(command.expectedVersion) || !/^[a-f0-9]{64}$/.test(command.expectedInitSha256)) {
        throw new Error("HEALTH_EXPECTATION_INVALID");
      }
      return `health=$(busybox wget -q -T 8 -O - http://127.0.0.1:7575/api/health); init_sha256=$(busybox sha256sum /etc/init.d/djonehub_agent | awk '{print $1}'); factory_pid=$(pidof ql_manager_server 2>/dev/null); printf 'health=%s\\ninit_sha256=%s\\nfactory_pid=%s\\n' "$health" "$init_sha256" "$factory_pid"`;
    case "install":
      if (!STAGING_DIRECTORY.test(command.stagingPath)) {
        throw new Error("STAGING_PATH_INVALID");
      }
      return `${command.stagingPath}/payload/install-webflash.sh ${command.stagingPath}`;
    case "install-status":
      if (!STAGING_DIRECTORY.test(command.stagingPath)) {
        throw new Error("STAGING_PATH_INVALID");
      }
      return `tail -n 120 ${command.stagingPath}/install.log`;
    case "payload-hashes":
      return Object.entries(PAYLOAD_TARGETS).map(([name, target]) => `if test -f ${target}; then hash=$(busybox sha256sum ${target} | awk '{print $1}'); else hash=missing; fi; printf '${name}=%s\\n' "$hash"`).join("; ");
    case "payload-sizes":
      return [
        ...Object.entries(PAYLOAD_TARGETS).map(([name, target]) => `if test -f ${target}; then size=$(wc -c < ${target}); else size=missing; fi; printf '${name}=%s\\n' "$size"`),
        "if test -f /data/djonehub/bin/qdc507-agent.recovery; then size=$(wc -c < /data/djonehub/bin/qdc507-agent.recovery); else size=missing; fi; printf 'qdc507-agent.recovery=%s\\n' \"$size\"",
      ].join("; ");
    case "preclean":
      return precleanV1;
    case "maintain-log":
      return "set -e; log=/data/djonehub/log/agent.log; if test -f $log; then size=$(wc -c < $log); if test \"$size\" -gt 1048576; then : > /data/djonehub/log/agent.log; sync; available=$(df -Pk /data | awk 'NR==2 {print $4 * 1024}'); printf 'cleared %s %s\\n' \"$size\" \"$available\"; else available=$(df -Pk /data | awk 'NR==2 {print $4 * 1024}'); printf 'kept %s %s\\n' \"$size\" \"$available\"; fi; else available=$(df -Pk /data | awk 'NR==2 {print $4 * 1024}'); printf 'missing 0 %s\\n' \"$available\"; fi";
    case "prepare-agent-restore":
      if (!STAGING_DIRECTORY.test(command.stagingPath)) throw new Error("STAGING_PATH_INVALID");
      return `set -e; rm -rf ${command.stagingPath}; rm -f /data/djonehub/bin/qdc507-agent.webflash-restore; sync; df -Pk /data | awk 'NR==2 {print $4 * 1024}'`;
    case "restore-agent":
      if (!SHA256.test(command.sha256)) throw new Error("SHA256_INVALID");
      return `set -e; restore=/data/djonehub/bin/qdc507-agent.webflash-restore; target=/data/djonehub/bin/qdc507-agent; test "$(busybox sha256sum $restore | awk '{print $1}')" = ${command.sha256}; test ! -x /etc/init.d/djonehub_agent || /etc/init.d/djonehub_agent stop >/dev/null 2>&1 || true; rm -f $target /data/djonehub/bin/qdc507-agent.recovery; mv $restore $target; chmod 755 $target; ln $target /data/djonehub/bin/qdc507-agent.recovery; sync; echo restored`;
    case "bootstrap-inspect": {
      const files = Object.entries(BOOTSTRAP_TARGETS).map(([name, spec]) => `if test -f ${spec.path}; then size=$(wc -c < ${spec.path}); hash=$(busybox sha256sum ${spec.path} | awk '{print $1}'); printf 'file.${name}=%s,%s\\n' \"$size\" \"$hash\"; else printf 'file.${name}=missing\\n'; fi`).join("; ");
      return `printf 'DJONEHUB_BOOTSTRAP_INSPECT_BEGIN\\n'; uid=$(id -u); arch=$(uname -m); kernel=$(uname -r); vendor=$(cat /sys/devices/virtual/android_usb/android0/idVendor 2>/dev/null); product=$(cat /sys/devices/virtual/android_usb/android0/idProduct 2>/dev/null); factory=$(pidof ql_manager_server 2>/dev/null); functions=$(cat /sys/devices/virtual/android_usb/android0/functions 2>/dev/null); mount_line=$(mount | grep 'ubi0:rootfs on /' 2>/dev/null); root_free=$(df -Pk / | awk 'NR==2 {print $4 * 1024}'); test -x /usr/sbin/djonehub-bootstrap && installed=1 || installed=0; if test -x /etc/init.d/djonehub_agent && /etc/init.d/djonehub_agent status >/dev/null 2>&1; then agent_running=1; else agent_running=0; fi; link=$(readlink ${BOOTSTRAP_LINK} 2>/dev/null || echo missing); printf 'uid=%s\\narch=%s\\nkernel=%s\\nusb=%s:%s\\nfactory_pid=%s\\nfunctions=%s\\nmount=%s\\nroot_free=%s\\ninstalled=%s\\nagent_running=%s\\n' \"$uid\" \"$arch\" \"$kernel\" \"$vendor\" \"$product\" \"$factory\" \"$functions\" \"$mount_line\" \"$root_free\" \"$installed\" \"$agent_running\"; ${files}; printf 'link=%s\\nDJONEHUB_BOOTSTRAP_INSPECT_END\\n' \"$link\"`;
    }
    case "bootstrap-call-agent":
      return "busybox wget -q -T 3 -O - http://127.0.0.1:7575/api/calls/status";
    case "bootstrap-call-qmi":
      return "(sleep 1; printf 'block_check_condition call_state NONE\\n'; sleep 1; printf 'quit\\n') | timeout -t 8 /usr/bin/qmi_simple_ril_test 2>&1 | tail -n 40";
    case "bootstrap-prepare-write":
    case "bootstrap-prepare-rollback":
      return bootstrapPrepareCommand();
    case "bootstrap-remove-target": {
      const target = BOOTSTRAP_TARGETS[command.name]?.path;
      if (!target) throw new Error("BOOTSTRAP_TARGET_INVALID");
      return `set -e; rm -f ${target} ${target}.webflash-next ${target}.webflash-restore; sync; printf 'removed=${command.name}\\n'`;
    }
    case "bootstrap-commit-target":
    case "bootstrap-restore-target": {
      if (!SHA256.test(command.sha256)) throw new Error("SHA256_INVALID");
      const target = BOOTSTRAP_TARGETS[command.name];
      if (!target) throw new Error("BOOTSTRAP_TARGET_INVALID");
      const suffix = command.kind === "bootstrap-commit-target" ? "next" : "restore";
      const verb = command.kind === "bootstrap-commit-target" ? "committed" : "restored";
      return `set -e; source=${target.path}.webflash-${suffix}; test "$(busybox sha256sum $source | awk '{print $1}')" = ${command.sha256}; mv $source ${target.path}; chmod ${target.mode.toString(8)} ${target.path}; sync; printf '${verb}=${command.sha256}\\n'`;
    }
    case "bootstrap-finalize": {
      const restore = bootstrapAgentRestoreCommand(command.restoreAgent);
      return `set -e; rm -f ${BOOTSTRAP_LINK}; ln -s ${BOOTSTRAP_LINK_TARGET} ${BOOTSTRAP_LINK}; ${bootstrapRemountReadOnlyCommand()}; ${restore}; printf 'rootfs=ro\\nagent_running=%s\\n' \"$agent_running\"`;
    }
    case "bootstrap-finalize-rollback": {
      if (command.linkTarget !== null && !SAFE_LINK_TARGET.test(command.linkTarget)) throw new Error("BOOTSTRAP_LINK_TARGET_INVALID");
      const link = command.linkTarget === null ? `rm -f ${BOOTSTRAP_LINK}` : `rm -f ${BOOTSTRAP_LINK}; ln -s ${command.linkTarget} ${BOOTSTRAP_LINK}`;
      const restore = bootstrapAgentRestoreCommand(command.restoreAgent);
      return `set -e; ${link}; ${bootstrapRemountReadOnlyCommand()}; ${restore}; printf 'rootfs=ro\\nagent_running=%s\\n' \"$agent_running\"`;
    }
    case "bootstrap-verify": {
      const hashes = Object.entries(BOOTSTRAP_TARGETS).map(([name, spec]) => `hash=$(busybox sha256sum ${spec.path} | awk '{print $1}'); printf 'sha.${name}=%s\\n' \"$hash\"`).join("; ");
      return `set -e; ${hashes}; link=$(readlink ${BOOTSTRAP_LINK}); mount | grep -Fq 'ubi0:rootfs on / type ubifs (ro,'; /usr/sbin/djonehub-bootstrap -h >/dev/null 2>&1; if test -x /etc/init.d/djonehub_agent && /etc/init.d/djonehub_agent status >/dev/null 2>&1; then agent_running=1; else agent_running=0; fi; printf 'link=%s\\nrootfs=ro\\nexecutable=1\\nagent_running=%s\\n' \"$link\" \"$agent_running\"`;
    }
    case "remove-payloads": {
      validatePayloadEntries(command.entries, command.discardRecovery === true);
      const checks = command.entries.map(({ name, sha256 }) => `test "$(busybox sha256sum ${PAYLOAD_TARGETS[name]} | awk '{print $1}')" = ${sha256}`).join("; ");
      const removals = command.entries.map(({ name, sha256 }) => {
        const target = PAYLOAD_TARGETS[name];
        if (name !== "qdc507-agent") return `rm -f ${target}`;
        const recovery = "/data/djonehub/bin/qdc507-agent.recovery";
        if (command.discardRecovery) return `rm -f ${target}`;
        return `if test -f ${recovery} && test "$(busybox sha256sum ${recovery} | awk '{print $1}')" = ${sha256}; then rm -f ${recovery}; fi; rm -f ${target}`;
      }).join("; ");
      const stop = command.entries.some(({ name }) => name === "qdc507-agent") ? "test ! -x /etc/init.d/djonehub_agent || /etc/init.d/djonehub_agent stop >/dev/null 2>&1 || true" : "";
      const discardRecovery = command.discardRecovery ? "rm -f /data/djonehub/bin/qdc507-agent.recovery" : "";
      return ["set -e", checks, stop, discardRecovery, removals, "sync", "df -Pk /data | awk 'NR==2 {print $4 * 1024}'"].filter(Boolean).join("; ");
    }
  }
}

function shellTimeoutMs(command: FixedShellCommand): number {
  switch (command.kind) {
    case "identity":
    case "health":
    case "install-status":
    case "payload-sizes":
      return 10_000;
    case "preflight":
    case "verify-health":
    case "maintain-log":
      return 15_000;
    case "prepare-agent-restore":
      return 20_000;
    case "preclean":
    case "remove-payloads":
      return 45_000;
    case "payload-hashes":
      return 60_000;
    case "install":
    case "restore-agent":
      return 90_000;
    case "bootstrap-inspect":
      return 60_000;
    case "bootstrap-call-agent":
      return 10_000;
    case "bootstrap-call-qmi":
      return 15_000;
    case "bootstrap-remove-target":
      return 20_000;
    case "bootstrap-commit-target":
    case "bootstrap-restore-target":
    case "bootstrap-verify":
      return 30_000;
    case "bootstrap-prepare-write":
    case "bootstrap-prepare-rollback":
    case "bootstrap-finalize":
    case "bootstrap-finalize-rollback":
      return 90_000;
  }
}

export function buildFixedShellCommand(command: FixedShellCommand): string {
  const shellCommand = buildUnframedFixedShellCommand(command);
  if (command.kind === "preflight") {
    return `printf 'DJONEHUB_PREFLIGHT_BEGIN\\n'; ${shellCommand}; printf 'DJONEHUB_PREFLIGHT_END\\n'`;
  }
  if (command.kind === "remove-payloads") {
    return `printf 'DJONEHUB_SPACE_RECHECK_BEGIN\\n'; ${shellCommand}; printf 'DJONEHUB_SPACE_RECHECK_END\\n'`;
  }
  return shellCommand;
}

export class AdbClient {
  private readonly io: AdbPacketIO;
  private connected = false;
  private nextLocalId = 1;

  constructor(io: AdbPacketIO) {
    this.io = io;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    ensureNotAborted(signal);
    diagnostic("ADB_CONNECT_START", "sending host CNXN");
    const connect = () => this.send(ADB_CNXN, 0x01000001, 4096, ascii("host::\0"));
    await connect();
    diagnostic("ADB_CONNECT_WAIT", "waiting for CNXN or AUTH");
    let staleStreams = 0;
    while (true) {
      const response = await this.readMessage(signal, ADB_CONNECT_TIMEOUT_MS);
      if (response.command === ADB_AUTH) {
        diagnostic("ADB_AUTH_REQUIRED", `type=${response.arg0}`, "error");
        throw new FlashError("ADB_AUTH_REQUIRED", "模块要求 ADB 认证，在线刷写器不会绕过认证");
      }
      if (response.command === ADB_CNXN) {
        this.connected = true;
        diagnostic("ADB_CONNECT_OK", `version=0x${response.arg0.toString(16)} maxPayload=${response.arg1} stale=${staleStreams}`);
        return;
      }
      if (response.command === ADB_WRTE || response.command === ADB_OKAY || response.command === ADB_CLSE) {
        if (staleStreams >= MAX_STALE_STREAMS) throw new Error("ADB_STALE_STREAM_LIMIT");
        if (response.arg0 !== 0 && response.arg1 !== 0) {
          await this.send(ADB_CLSE, response.arg1, response.arg0);
        }
        staleStreams += 1;
        diagnostic("ADB_STALE_STREAM", `count=${staleStreams} command=${commandLabel(response.command)}`, "warn");
        await connect();
        continue;
      }
      diagnostic("ADB_CONNECT_UNEXPECTED", commandLabel(response.command), "error");
      throw new Error("ADB_CONNECT_PACKET_UNEXPECTED");
    }
  }

  async runShell(
    command: FixedShellCommand,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    if (!this.connected) {
      throw new Error("ADB_NOT_CONNECTED");
    }
    const localId = this.nextLocalId++;
    await this.send(
      ADB_OPEN,
      localId,
      0,
      ascii(`shell:${buildFixedShellCommand(command)}\0`),
    );

    let remoteId: number | undefined;
    const chunks: Uint8Array[] = [];
    while (true) {
      ensureNotAborted(signal);
      const message = await this.readMessage(signal, shellTimeoutMs(command));
      if (message.command === ADB_OKAY && message.arg1 === localId) {
        remoteId ??= message.arg0;
        continue;
      }
      if (message.command === ADB_WRTE && message.arg1 === localId) {
        remoteId = message.arg0;
        chunks.push(message.payload);
        onChunk?.(decoder.decode(message.payload, { stream: true }));
        await this.send(ADB_OKAY, localId, remoteId);
        continue;
      }
      if (message.command === ADB_CLSE && message.arg1 === localId) {
        if (remoteId !== undefined) {
          await this.send(ADB_CLSE, localId, remoteId);
        }
        return decoder.decode(concat(chunks));
      }
      throw new Error("ADB_STREAM_PACKET_UNEXPECTED");
    }
  }

  async openSync(signal?: AbortSignal): Promise<AdbServiceStream> {
    if (!this.connected) {
      throw new Error("ADB_NOT_CONNECTED");
    }
    const localId = this.nextLocalId++;
    await this.send(ADB_OPEN, localId, 0, ascii("sync:\0"));
    while (true) {
      const message = await this.readMessage(signal, ADB_CONNECT_TIMEOUT_MS);
      if (message.command === ADB_OKAY && message.arg1 === localId) {
        return new ClientServiceStream(this, localId, message.arg0);
      }
      if (message.command === ADB_CLSE && message.arg1 === localId) {
        throw new Error("ADB_SYNC_REJECTED");
      }
      await this.ackUnexpected(message);
    }
  }

  async sendStreamPayload(
    localId: number,
    remoteId: number,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    ensureNotAborted(signal);
    if (payload.byteLength > 4096) {
      throw new Error("ADB_STREAM_CHUNK_TOO_LARGE");
    }
    await this.send(ADB_WRTE, localId, remoteId, payload);
    while (true) {
      const message = await this.readMessage(signal, ADB_ACK_TIMEOUT_MS);
      if (
        message.command === ADB_OKAY &&
        message.arg0 === remoteId &&
        message.arg1 === localId
      ) {
        return;
      }
      if (message.command === ADB_CLSE && message.arg1 === localId) {
        throw new Error("ADB_STREAM_CLOSED");
      }
      await this.ackUnexpected(message);
    }
  }

  async readStreamPayload(
    localId: number,
    remoteId: number,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Uint8Array | null> {
    while (true) {
      const message = await this.readMessage(signal, timeoutMs);
      if (message.command === ADB_WRTE && message.arg1 === localId) {
        await this.send(ADB_OKAY, localId, message.arg0);
        return message.payload;
      }
      if (message.command === ADB_CLSE && message.arg1 === localId) {
        if (message.arg0 !== 0) {
          await this.send(ADB_CLSE, localId, remoteId);
        }
        return null;
      }
      await this.ackUnexpected(message);
    }
  }

  async closeStream(
    localId: number,
    remoteId: number,
    signal?: AbortSignal,
    timeoutMs = ADB_CLOSE_TIMEOUT_MS,
  ): Promise<void> {
    ensureNotAborted(signal);
    await this.send(ADB_CLSE, localId, remoteId);
    while (true) {
      const message = await this.readMessage(signal, timeoutMs);
      if (message.command === ADB_CLSE && message.arg1 === localId) {
        return;
      }
      await this.ackUnexpected(message);
    }
  }

  private async send(
    command: number,
    arg0: number,
    arg1: number,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  ): Promise<void> {
    diagnostic("ADB_TX", `${commandLabel(command)} arg0=${arg0} arg1=${arg1} bytes=${payload.byteLength}`);
    await this.io.write(encodeAdbMessage({ command, arg0, arg1, payload }));
  }

  private async readMessage(signal?: AbortSignal, timeoutMs?: number): Promise<AdbMessage> {
    const header = decodeAdbHeader(await this.io.readExact(24, signal, timeoutMs));
    const payload =
      header.length === 0
        ? new Uint8Array()
        : await this.io.readExact(header.length, signal, timeoutMs);
    validateAdbPayload(header, payload);
    diagnostic("ADB_RX", `${commandLabel(header.command)} arg0=${header.arg0} arg1=${header.arg1} bytes=${payload.byteLength}`);
    return { command: header.command, arg0: header.arg0, arg1: header.arg1, payload };
  }

  private async ackUnexpected(message: AdbMessage): Promise<void> {
    if (message.command === ADB_WRTE) {
      await this.send(ADB_OKAY, message.arg1, message.arg0);
      return;
    }
    if (message.command === ADB_CLSE && message.arg0 !== 0 && message.arg1 !== 0) {
      await this.send(ADB_CLSE, message.arg1, message.arg0);
    }
  }
}

class ClientServiceStream implements AdbServiceStream {
  private readonly client: AdbClient;
  private readonly localId: number;
  private readonly remoteId: number;
  private closed = false;

  constructor(client: AdbClient, localId: number, remoteId: number) {
    this.client = client;
    this.localId = localId;
    this.remoteId = remoteId;
  }

  async write(payload: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("ADB_STREAM_CLOSED");
    await this.client.sendStreamPayload(this.localId, this.remoteId, payload, signal);
  }

  async read(signal?: AbortSignal, timeoutMs?: number): Promise<Uint8Array | null> {
    if (this.closed) return null;
    const payload = await this.client.readStreamPayload(
      this.localId,
      this.remoteId,
      signal,
      timeoutMs,
    );
    if (payload === null) this.closed = true;
    return payload;
  }

  async close(signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.closeStream(this.localId, this.remoteId, signal, timeoutMs);
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
