import { AdbClient, type PayloadName } from "../adb/client";
import { AdbSync, stagingPath, type SyncClient } from "../adb/sync";
import { WebUsbAdbDevice, isUsbDisconnectError, requestQdc507 } from "../adb/webusb-device";
import { diagnostic } from "../diagnostics";
import {
  FlashError,
  USB_PRODUCT_ID,
  USB_VENDOR_ID,
  type FlashState,
  type ProvisioningEvent,
  type WorkflowStep,
} from "../domain";
import { ReleaseClient, type DownloadProgress } from "../release/client";
import type { VerifiedChannel, VerifiedPackage } from "../release/schema";
import { verifyDjupdateArchive, verifyWebflashArchive } from "../release/verifier";
import { runPreflight, type PreflightResult } from "./preflight";
import {
  inspectInstalledPayloads,
  reclaimSpaceWithBackups,
  restoreExternalBackups,
  selectPayloadUploads,
  type ExternalBackup,
  type RecoverySync,
} from "./space-recovery";
import installerSource from "../assets/install-webflash.sh?raw";
import { installBootstrap, type BootstrapProgress } from "../bootstrap/installer";
import { verifyBootstrapArchive, type BootstrapBundle } from "../bootstrap/package";
import { BootstrapReleaseClient } from "../bootstrap/release";

const TRANSACTION_MARGIN_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RECOVERY = Symbol("RecoveryAuthorization");
const PAYLOAD_WORKFLOW: readonly { readonly name: PayloadName; readonly step: WorkflowStep; readonly label: string }[] = [
  { name: "qdc507-agent", step: 14, label: "qdc507-agent" },
  { name: "qdc507_data11_bridge.ko", step: 15, label: "DATA11 桥" },
  { name: "qdc507_aprv3.ko", step: 16, label: "APRv3 驱动" },
  { name: "qdc507_voice.ko", step: 17, label: "语音驱动" },
  { name: "mavo-pcm-bridge.armv7", step: 18, label: "PCM helper" },
];

export type RecoveryAuthorization = {
  readonly [RECOVERY]: true;
  readonly targetVersion: string;
  consumed: boolean;
};

export function authorizeRecovery(
  acknowledgedRisk: boolean,
  typedConfirmation: string,
  targetVersion: string,
): RecoveryAuthorization {
  if (!acknowledgedRisk || typedConfirmation !== `RECOVER ${targetVersion}`) {
    throw new Error("RECOVERY_CONFIRMATION_INVALID");
  }
  return { [RECOVERY]: true, targetVersion, consumed: false };
}

export function authorizeRepair(
  acknowledgedRisk: boolean,
  typedConfirmation: string,
  targetVersion: string,
): RecoveryAuthorization {
  if (!acknowledgedRisk || typedConfirmation !== `REPAIR ${targetVersion}`) {
    throw new Error("REPAIR_CONFIRMATION_INVALID");
  }
  return { [RECOVERY]: true, targetVersion, consumed: false };
}

type Session = { readonly client: AdbClient; close(): Promise<void> };
type SyncTransfer = RecoverySync;

export type ProvisioningDependencies = {
  readonly checkEnvironment: () => void;
  readonly acquire: (signal: AbortSignal) => Promise<Session>;
  readonly reconnect: (signal: AbortSignal, timeoutMs: number) => Promise<Session>;
  readonly release: {
    fetchStableChannel(onProgress?: DownloadProgress): Promise<VerifiedChannel>;
    fetchPackage(channel: VerifiedChannel, onProgress: DownloadProgress): Promise<Uint8Array>;
  };
  readonly verifyArchive: typeof verifyWebflashArchive;
  readonly verifyLocalArchive: typeof verifyDjupdateArchive;
  readonly installerBytes: Uint8Array;
  readonly preflight: (client: AdbClient) => Promise<PreflightResult>;
  readonly syncFor: (client: SyncClient) => SyncTransfer;
  readonly inspectInstalled: typeof inspectInstalledPayloads;
  readonly reclaimSpace: typeof reclaimSpaceWithBackups;
  readonly restoreBackups: typeof restoreExternalBackups;
  readonly bootstrap: {
    fetchPackage(onProgress?: (received: number, total: number) => void, signal?: AbortSignal): Promise<Uint8Array>;
    verifyArchive(bytes: Uint8Array): Promise<BootstrapBundle>;
    install(client: AdbClient, sync: SyncTransfer, bundle: BootstrapBundle, onProgress?: (progress: BootstrapProgress) => void, signal?: AbortSignal): Promise<{ readonly version: string }>;
  };
  readonly randomBytes: () => Uint8Array;
};

function waitForUsbReconnect(usb: USB, milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      usb.removeEventListener("connect", onConnect);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onConnect = () => finish(resolve);
    const onAbort = () => finish(() => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError")));
    const timer = setTimeout(() => finish(resolve), milliseconds);
    usb.addEventListener("connect", onConnect);
    signal.addEventListener("abort", onAbort);
  });
}

async function openDevice(device: USBDevice, signal: AbortSignal): Promise<Session> {
  const transport = new WebUsbAdbDevice(device);
  await transport.open();
  const client = new AdbClient(transport);
  await client.connect(signal);
  return { client, close: () => transport.close() };
}

function defaultDependencies(): ProvisioningDependencies {
  const release = new ReleaseClient();
  const bootstrapRelease = new BootstrapReleaseClient();
  return {
    checkEnvironment: () => {
      if (!globalThis.isSecureContext) throw new FlashError("INSECURE_CONTEXT", "在线刷写必须从 HTTPS 页面运行");
      if (!("usb" in navigator)) throw new FlashError("UNSUPPORTED_BROWSER", "请使用桌面版 Chrome 或 Edge");
    },
    acquire: async (signal) => {
      const transport = await requestQdc507(navigator.usb);
      try {
        await transport.open();
        const client = new AdbClient(transport);
        await client.connect(signal);
        return { client, close: () => transport.close() };
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }
    },
    reconnect: async (signal, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      const usb = navigator.usb;
      while (Date.now() < deadline) {
        const devices = await usb.getDevices();
        const device = devices.find((candidate) => candidate.vendorId === USB_VENDOR_ID && candidate.productId === USB_PRODUCT_ID);
        if (device) {
          try { return await openDevice(device, signal); } catch (error) {
            if (!isUsbDisconnectError(error) && (!(error instanceof FlashError) || error.code !== "USB_INTERFACE_BUSY")) {
              throw error;
            }
            diagnostic("USB_RECONNECT_RETRY", error instanceof Error ? error.message : "reopen failed", "warn");
          }
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await waitForUsbReconnect(usb, Math.min(1000, remaining), signal);
      }
      throw new FlashError("USB_DISCONNECTED", "等待模块重新连接超时");
    },
    release,
    verifyArchive: verifyWebflashArchive,
    verifyLocalArchive: verifyDjupdateArchive,
    installerBytes: encoder.encode(installerSource),
    preflight: runPreflight,
    syncFor: (client) => new AdbSync(client),
    inspectInstalled: inspectInstalledPayloads,
    reclaimSpace: reclaimSpaceWithBackups,
    restoreBackups: restoreExternalBackups,
    bootstrap: {
      fetchPackage: (onProgress, signal) => bootstrapRelease.fetchPackage(onProgress, signal),
      verifyArchive: verifyBootstrapArchive,
      install: installBootstrap,
    },
    randomBytes: () => crypto.getRandomValues(new Uint8Array(16)),
  };
}

function randomSuffix(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new Error("RANDOM_SUFFIX_INVALID");
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isOlderVersion(candidate: string, installed: string): boolean {
  const left = candidate.split("-", 1)[0]!.split(".").map(Number);
  const right = installed.split("-", 1)[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]!;
  }
  return false;
}

function installMetadata(pkg: VerifiedPackage, expectedInitSha256: string): Uint8Array {
  const lines = [`VERSION=${pkg.manifest.version}`, `INIT_SHA256=${expectedInitSha256}`];
  for (const file of [...pkg.manifest.files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (file.name === "install-webflash.sh") continue;
    lines.push(`${file.sha256} ${file.name} ${file.mode.toString(8)}`);
  }
  return encoder.encode(`${lines.join("\n")}\n`);
}

function embeddedInitScript(installer: Uint8Array): Uint8Array {
  const source = decoder.decode(installer);
  const startMarker = "cat > \"$INIT.webflash-new\" <<'INIT_SCRIPT'\n";
  const endMarker = "\nINIT_SCRIPT\n";
  const start = source.indexOf(startMarker);
  if (start < 0 || source.indexOf(startMarker, start + startMarker.length) >= 0) {
    throw new FlashError("INSTALL_FAILED", "安装器启动脚本边界无效");
  }
  const contentStart = start + startMarker.length;
  const end = source.indexOf(endMarker, contentStart);
  if (end < contentStart || source.indexOf(endMarker, end + endMarker.length) >= 0) {
    throw new FlashError("INSTALL_FAILED", "安装器启动脚本边界无效");
  }
  return encoder.encode(source.slice(contentStart, end + 1));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function parseVerification(
  output: string,
  version: string,
  factoryPid: number,
  expectedInitSha256: string,
  options: { readonly requireAgentHealth?: boolean } = {},
): void {
  const records = output.replaceAll("\r", "").trim().split("\n");
  const lines = new Map<string, string>();
  let formatValid = records.length === 3;
  for (const line of records) {
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (index < 1 || lines.has(key)) {
      formatValid = false;
      continue;
    }
    lines.set(key, line.slice(index + 1));
  }
  formatValid = formatValid
    && lines.size === 3
    && lines.has("health")
    && lines.has("init_sha256")
    && lines.has("factory_pid");

  const actualInitSha256 = lines.get("init_sha256");
  const actualFactoryPid = lines.get("factory_pid");
  const initMatches = actualInitSha256 === expectedInitSha256;
  const factoryMatches = actualFactoryPid === String(factoryPid);
  let healthParsed = false;
  let healthOk = false;
  let healthVersion = "invalid";
  try {
    const health = JSON.parse(lines.get("health") ?? "") as { ok?: unknown; version?: unknown };
    healthParsed = true;
    healthOk = health.ok === true;
    healthVersion = typeof health.version === "string" ? health.version : "invalid";
  } catch {
    // The structured diagnostic below records the parse failure without exposing raw output.
  }
  const hashLabel = (value: string | undefined): string => {
    if (!value) return "missing";
    return (value.slice(0, 16).match(/.{1,2}/g) ?? []).join(":");
  };
  diagnostic("POST_VERIFY_FIELDS", [
    `format_valid=${formatValid}`,
    `fields=${lines.size}`,
    `health_parse=${healthParsed}`,
    `health_ok=${healthOk}`,
    `health_version=${healthVersion}`,
    `expected_version=${version}`,
    `init_actual=${hashLabel(actualInitSha256)}`,
    `init_expected=${hashLabel(expectedInitSha256)}`,
    `init_match=${initMatches}`,
    `factory_actual=${actualFactoryPid ?? "missing"}`,
    `factory_expected=${factoryPid}`,
    `factory_match=${factoryMatches}`,
  ].join(" "));

  if (!formatValid) throw new FlashError("HEALTH_CHECK_FAILED", "安装后验证输出格式无效");
  if (!initMatches) throw new FlashError("HEALTH_CHECK_FAILED", "模块启动脚本校验失败");
  if (!factoryMatches) throw new FlashError("HEALTH_CHECK_FAILED", "原厂服务 PID 校验失败");
  if (options.requireAgentHealth === false) {
    diagnostic("POST_VERIFY_MAC_PROFILE", "agent health skipped for Mac USB profile", "warn");
    return;
  }
  if (!healthParsed || !healthOk || healthVersion !== version) {
    throw new FlashError("HEALTH_CHECK_FAILED", "模块 Agent 健康检查失败");
  }
}

export class ProvisioningController {
  private readonly dependencies: ProvisioningDependencies;
  private readonly listeners = new Set<(event: ProvisioningEvent) => void>();
  private abortController: AbortController | undefined;
  private session: Session | undefined;
  private currentState: FlashState = { phase: "environment" };

  constructor(dependencies: ProvisioningDependencies = defaultDependencies()) {
    this.dependencies = dependencies;
  }

  get state(): FlashState { return this.currentState; }

  subscribe(listener: (event: ProvisioningEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(options: { recovery?: RecoveryAuthorization; localPackage?: Uint8Array; mode?: "agent" | "bootstrap" } = {}): Promise<void> {
    if (this.abortController) throw new Error("PROVISIONING_ALREADY_RUNNING");
    const abortController = new AbortController();
    this.abortController = abortController;
    const signal = abortController.signal;
    let externalBackups: readonly ExternalBackup[] = [];
    let recoveryDirectory: string | undefined;
    let recoverySync: SyncTransfer | undefined;
    try {
      const mode = options.mode ?? "agent";
      this.dependencies.checkEnvironment();
      this.setState({ phase: "awaiting-device", step: 1, detail: mode === "bootstrap" ? "通过 WebUSB 扫描并选择 Bootstrap 目标 QDC507" : "通过 WebUSB 扫描并选择 QDC507" });
      this.session = await this.dependencies.acquire(signal);
      this.setState({ phase: "preflight", step: 2, detail: "USB ADB Shell 与文件传输通道已建立" });
      if (mode === "bootstrap") {
        this.setState({ phase: "downloading", step: 2, detail: "正在从同源私有端点载入固定 Bootstrap 0.1.0 包…", received: 0 });
        const archive = await this.dependencies.bootstrap.fetchPackage((received, total) => {
          this.setState({ phase: "downloading", step: 2, detail: "正在载入固定 Bootstrap 0.1.0 包…", received, total });
        }, signal);
        this.setState({ phase: "verifying-package", step: 2, detail: "正在验证 Bootstrap 顶层摘要、严格白名单、ARMv7 ELF、公钥与逐文件 SHA-256…" });
        const bundle = await this.dependencies.bootstrap.verifyArchive(archive);
        const sync = this.dependencies.syncFor(this.session.client);
        const completed = await this.dependencies.bootstrap.install(this.session.client, sync, bundle, ({ step, detail }) => {
          const workflowStep = step as WorkflowStep;
          if (step <= 6) this.setState({ phase: "preflight", step: workflowStep, detail });
          else if (step <= 9) this.setState({ phase: "planning", step: workflowStep, detail });
          else if (step <= 12) this.setState({ phase: "installing", step: workflowStep, detail, stage: `bootstrap ${step}/14` });
          else this.setState({ phase: "verifying-device", step: workflowStep, detail });
        }, signal);
        this.setState({ phase: "completed", version: `Bootstrap ${completed.version}` });
        return;
      }
      this.setState({ phase: "preflight", step: 3, detail: "正在读取 root、CPU 与内核身份…" });
      const preflight = await this.dependencies.preflight(this.session.client);
      this.setState({ phase: "preflight", step: 4, detail: `原厂服务 ql_manager_server PID=${preflight.factoryPid}` });
      this.setState({ phase: "preflight", step: 5, detail: `USB functions=${preflight.usbFunctions}${preflight.serialConnected ? " · serial 已连接" : ""}` });
      this.setState({
        phase: "preflight",
        step: 6,
        detail: preflight.agentPid === undefined
          ? `Agent 未运行，7575 ${preflight.port7575Listening ? "正在监听" : "未监听"}`
          : `Agent PID=${preflight.agentPid}，7575 ${preflight.port7575Listening ? "正在监听" : "未监听"}`,
      });
      diagnostic("RUNTIME_STATE", `agent_pid=${preflight.agentPid ?? "none"} port_7575=${preflight.port7575Listening ? 1 : 0} usb_functions=${preflight.usbFunctions}`);
      this.setState({
        phase: "planning",
        step: 7,
        detail: preflight.agentPid !== undefined && preflight.port7575Listening
          ? "标准运行时入口可达；WebFlash 将继续使用签名事务链路，避免跨版本能力差异"
          : "标准运行时入口不可用或当前为 Mac 模式，安全转入 WebFlash 事务链路",
      });
      diagnostic("STANDARD_UPDATE_ROUTE", `available=${preflight.agentPid !== undefined && preflight.port7575Listening} selected=webflash`);
      const recovery = options.recovery;
      let archive: Uint8Array;
      let verified: VerifiedPackage;
      if (options.localPackage) {
        archive = options.localPackage;
        this.setState({ phase: "verifying-package", step: 7, detail: "正在验证用户选择固件的 Ed25519 签名、平台与全部载荷摘要…" });
        verified = await this.dependencies.verifyLocalArchive(
          archive,
          preflight.installedVersion,
          { allowDowngrade: recovery !== undefined },
        );
      } else {
        this.setState({ phase: "downloading", step: 7, detail: "正在读取官方签名发布通道…", received: 0 });
        const channel = await this.dependencies.release.fetchStableChannel((progress) => this.setState({ phase: "downloading", step: 7, detail: "正在下载官方固件包…", ...progress }));
        archive = await this.dependencies.release.fetchPackage(channel, (progress) => this.setState({ phase: "downloading", step: 7, detail: "正在下载官方固件包…", ...progress }));
        this.setState({ phase: "verifying-package", step: 7, detail: "正在验证 Ed25519 签名、平台与全部载荷摘要…" });
        verified = await this.dependencies.verifyArchive(
          archive,
          preflight.installedVersion,
          { allowDowngrade: recovery !== undefined },
        );
      }
      if (recovery) {
        if (recovery[RECOVERY] !== true || recovery.consumed || recovery.targetVersion !== verified.manifest.version) throw new Error("RECOVERY_AUTHORIZATION_INVALID");
        recovery.consumed = true;
      }
      const installed = await this.dependencies.inspectInstalled(this.session.client);
      const selection = selectPayloadUploads(verified, installed);
      const missingPayloads = PAYLOAD_WORKFLOW.filter(({ name }) => installed.get(name) === undefined).map(({ name }) => name);
      const incomplete = preflight.installedVersion !== undefined && missingPayloads.length > 0;
      const uploadFiles = new Map(selection.uploads);
      if (!uploadFiles.has("payload/install-webflash.sh")) {
        uploadFiles.set("payload/install-webflash.sh", {
          bytes: this.dependencies.installerBytes,
          mode: 0o755,
          target: "/data/local/tmp/install-webflash.sh",
        });
      }
      const uploadedInstaller = uploadFiles.get("payload/install-webflash.sh");
      if (!uploadedInstaller) throw new FlashError("INSTALL_FAILED", "安装器载荷缺失");
      const expectedInitSha256 = await sha256Hex(embeddedInitScript(uploadedInstaller.bytes));
      this.setState({ phase: "planning", step: 8, detail: `双模式启动器摘要已验证，将随载荷原子提交：${expectedInitSha256.slice(0, 12)}…` });
      this.setState({ phase: "planning", step: 9, detail: `五项现有载荷清点完成；缺失 ${missingPayloads.length} 项` });
      this.setState({
        phase: "planning",
        step: 10,
        detail: incomplete
          ? `检测到不完整安装：版本标记为 ${preflight.installedVersion}，缺失 ${missingPayloads.length} 项关键载荷`
          : `安装状态一致；${selection.replacements.length} 项载荷需要替换`,
      });
      diagnostic("INSTALLATION_CONSISTENCY", `version=${preflight.installedVersion ?? "none"} incomplete=${incomplete} missing=${missingPayloads.join(",") || "none"} replacements=${selection.replacements.length}`);
      const metadata = installMetadata(verified, expectedInitSha256);
      const requiredBytes = [...uploadFiles.values()].reduce(
        (total, file) => total + file.bytes.byteLength,
        metadata.byteLength + TRANSACTION_MARGIN_BYTES,
      );
      diagnostic("PACKAGE_PLAN", [
        `version=${verified.manifest.version}`,
        `declared=${verified.manifest.files.length}`,
        `uploads=${uploadFiles.size}`,
        `replacements=${selection.replacements.length}`,
        `required_kib=${Math.floor(requiredBytes / 1024)}`,
        `available_kib=${Math.floor(preflight.availableBytes / 1024)}`,
      ].join(" "));
      this.setState({ phase: "planning", step: 11, detail: `规划事务空间：需要 ${Math.ceil(requiredBytes / 1024)} KiB，可用 ${Math.floor(preflight.availableBytes / 1024)} KiB` });
      this.setState({ phase: "planning", step: 12, detail: "通话安全门已通过；提交前模块安装器还会再次检查" });
      this.setState({ phase: "planning", step: 13, detail: `本地安装源已通过签名、平台、文件大小及 SHA-256 校验` });
      const directory = `/data/local/tmp/djonehub-webflash-${randomSuffix(this.dependencies.randomBytes())}`;
      const sync = this.dependencies.syncFor(this.session.client);
      recoveryDirectory = directory;
      recoverySync = sync;
      const sameVersionRepair = recovery && preflight.installedVersion === verified.manifest.version;
      const reclaimStrategy = recovery && preflight.installedVersion && (sameVersionRepair || isOlderVersion(verified.manifest.version, preflight.installedVersion))
        ? "direct"
        : "backup";
      if (reclaimStrategy === "direct") {
        diagnostic(sameVersionRepair ? "REPAIR_DIRECT_INSTALL" : "DOWNGRADE_DIRECT_INSTALL", `installed=${preflight.installedVersion} target=${verified.manifest.version} backup=disabled`, "warn");
      }
      try {
        externalBackups = await this.dependencies.reclaimSpace(
          this.session.client,
          sync,
          directory,
          selection.replacements,
          preflight.availableBytes,
          requiredBytes,
          signal,
          (backups) => { externalBackups = backups; },
          reclaimStrategy,
        );
      } catch (error) {
        if (
          !recovery
          && error instanceof FlashError
          && error.code === "INSUFFICIENT_SPACE"
          && preflight.installedVersion === verified.manifest.version
        ) {
          throw new FlashError("REPAIR_REQUIRED", `已安装 ${preflight.installedVersion}，目标版本 ${verified.manifest.version} 需要无备份修复`);
        }
        throw error;
      }
      const upload = async (archivePath: string, file: { readonly bytes: Uint8Array; readonly mode: 384 | 420 | 493 }, step: WorkflowStep, detail: string): Promise<void> => {
        const startedAt = performance.now();
        diagnostic("UPLOAD_FILE_START", `file=${archivePath} size_kib=${Math.floor(file.bytes.byteLength / 1024)}`);
        this.setState({ phase: "uploading", step, detail, file: archivePath, sent: 0, total: file.bytes.byteLength });
        await sync.push(stagingPath(`${directory}/${archivePath}`), file.bytes, file.mode, (sent, total) => this.setState({ phase: "uploading", step, detail, file: archivePath, sent, total }), signal);
        const elapsedMs = Math.max(1, Math.round(performance.now() - startedAt));
        const rateKibPerSecond = Math.round((file.bytes.byteLength / 1024) * 1000 / elapsedMs);
        diagnostic("UPLOAD_FILE_OK", `file=${archivePath} size_kib=${Math.floor(file.bytes.byteLength / 1024)} elapsed_ms=${elapsedMs} rate_kib_s=${rateKibPerSecond}`);
      };
      await upload("payload/install-webflash.sh", uploadedInstaller, 13, "正在暂存已验证的 WebFlash 安装器…");
      uploadFiles.delete("payload/install-webflash.sh");
      for (const { name, step, label } of PAYLOAD_WORKFLOW) {
        const declaration = verified.manifest.files.find((file) => file.name === name);
        const archivePath = declaration?.archive_path;
        const file = archivePath ? uploadFiles.get(archivePath) : undefined;
        if (!declaration) {
          this.setState({ phase: "planning", step, detail: `${label} 未包含在当前安装包中，跳过` });
        } else if (!file) {
          this.setState({ phase: "planning", step, detail: `${label} 摘要正确，直接复用` });
          diagnostic("PAYLOAD_REUSE", `file=${name} sha256=${declaration.sha256.slice(0, 16)}`);
        } else {
          await upload(archivePath!, file, step, `正在上传 ${label}…`);
          uploadFiles.delete(archivePath!);
        }
      }
      for (const [archivePath, file] of uploadFiles) await upload(archivePath, file, 19, `正在暂存 ${archivePath}…`);
      this.setState({ phase: "uploading", step: 19, detail: "正在写入受摘要约束的安装元数据…", file: "install.meta", sent: 0, total: metadata.byteLength });
      await sync.push(stagingPath(`${directory}/install.meta`), metadata, 0o600, (sent, total) => this.setState({ phase: "uploading", step: 19, detail: "正在写入受摘要约束的安装元数据…", file: "install.meta", sent, total }), signal);
      this.setState({ phase: "installing", step: 19, detail: "正在验证暂存 Agent、PCM helper 与原厂服务…", stage: "starting" });
      let progressBuffer = "";
      let installCommitted = false;
      let usbDropped = false;
      const consumeInstallerOutput = (chunk: string) => {
        progressBuffer += chunk.replaceAll("\r", "");
        const lines = progressBuffer.split("\n");
        progressBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^DJWEBFLASH ([a-z-]+) (\d+) (.*)$/.exec(line);
          if (!match) continue;
          if (["commit", "launcher", "rebooting", "startup", "health", "complete"].includes(match[1]!)) {
            installCommitted = true;
          }
          diagnostic("INSTALLER_PROGRESS", `stage=${match[1]} percent=${match[2]} detail=${match[3]}`);
          const nextStep: WorkflowStep = ["commit", "launcher"].includes(match[1]!)
            ? 20
            : ["rebooting", "startup", "health", "complete"].includes(match[1]!)
              ? 21
              : 19;
          if (nextStep === 21 && (this.currentState.step ?? 0) < 20) {
            this.setState({ phase: "installing", step: 20, detail: "载荷与双模式启动器已完成原子提交", stage: "commit complete" });
          }
          this.setState({ phase: "installing", step: nextStep, detail: match[3]!, stage: `${match[1]} ${match[2]}% ${match[3]}` });
        }
      };
      const failFromInstallerOutput = (output: string): void => {
        if (/DJWEBFLASH failed .*rollback unconfirmed/i.test(output)) throw new FlashError("ROLLBACK_UNCONFIRMED", "模块回滚无法确认");
        const installerFailure = /^DJWEBFLASH failed 0 ([^\r\n]{1,160})/m.exec(output);
        if (installerFailure) throw new FlashError("INSTALL_FAILED", `模块安装器失败：${installerFailure[1]}`);
      };
      try {
        const output = await this.session.client.runShell({ kind: "install", stagingPath: directory }, signal, consumeInstallerOutput);
        consumeInstallerOutput("\n");
        failFromInstallerOutput(output);
      } catch (error) {
        if (!isUsbDisconnectError(error)) throw error;
        usbDropped = true;
        diagnostic("INSTALL_USB_DROP", `committed=${installCommitted ? 1 : 0} ${error instanceof Error ? error.message : "usb disconnected"}`, "warn");
      }
      await this.session.close().catch(() => undefined);
      this.session = undefined;
      this.setState({ phase: "waiting-reconnect", step: 21, detail: "等待 USB 重新枚举并执行独立校验…", deadline: Date.now() + 90_000 });
      this.session = await this.dependencies.reconnect(signal, 90_000);
      if (usbDropped && !installCommitted) {
        try {
          const status = await this.session.client.runShell({ kind: "install-status", stagingPath: directory }, signal, consumeInstallerOutput);
          consumeInstallerOutput("\n");
          failFromInstallerOutput(status);
        } catch (error) {
          if (error instanceof FlashError && (error.code === "INSTALL_FAILED" || error.code === "ROLLBACK_UNCONFIRMED")) throw error;
          diagnostic("INSTALL_STATUS_UNAVAILABLE", error instanceof Error ? error.message : "install.log unread", "warn");
        }
        if (!installCommitted) {
          throw new FlashError("USB_DISCONNECTED", "模块 USB 在安装提交前断开");
        }
        diagnostic("INSTALL_USB_REBIND", "install.log confirmed payload commit after USB drop", "warn");
      } else if (usbDropped) {
        diagnostic("INSTALL_USB_REBIND", "USB dropped after payload commit; continuing with reconnect verification", "warn");
      }
      if ((this.currentState.step ?? 0) < 20) this.setState({ phase: "installing", step: 20, detail: "载荷与双模式启动器已完成原子提交", stage: "commit complete" });
      this.setState({ phase: "verifying-device", step: 21, detail: "正在校验五项载荷、启动器、Agent 健康和原厂服务…" });
      const after = await this.dependencies.preflight(this.session.client);
      const macUsbProfile = /(?:^|,)(?:audio|serial)(?:,|$)/.test(after.usbFunctions);
      const verification = await this.session.client.runShell({ kind: "verify-health", expectedVersion: verified.manifest.version, expectedInitSha256 }, signal);
      parseVerification(verification, verified.manifest.version, after.factoryPid, expectedInitSha256, { requireAgentHealth: !macUsbProfile });
      this.setState({ phase: "completed", version: verified.manifest.version });
    } catch (error) {
      let flashError = error instanceof FlashError
        ? error
        : signal.aborted
          ? new FlashError("CANCELLED", "刷写已取消", { cause: error })
          : isUsbDisconnectError(error)
            ? new FlashError("USB_DISCONNECTED", error instanceof Error ? error.message : "模块 USB 连接已断开", { cause: error })
            : new FlashError("INSTALL_FAILED", error instanceof Error ? error.message : "刷写失败", { cause: error });
      if (externalBackups.length > 0 && recoveryDirectory && recoverySync) {
        diagnostic("ROLLBACK_TRIGGER", `original_code=${flashError.code} original_message=${flashError.message}`, "warn");
        try {
          if (!this.session) {
            this.session = await this.dependencies.reconnect(new AbortController().signal, 30_000);
          }
          recoverySync = this.dependencies.syncFor(this.session.client);
          await this.dependencies.restoreBackups(this.session.client, recoverySync, recoveryDirectory, externalBackups);
        } catch (restoreError) {
          flashError = new FlashError("ROLLBACK_UNCONFIRMED", "Mac 端备份恢复失败，请保持模块连接并联系维护者", { cause: restoreError });
        }
      }
      const failedStep = this.currentState.step;
      this.setState({
        phase: "failed",
        ...(failedStep === undefined ? {} : { step: failedStep }),
        code: flashError.code,
        message: flashError.message,
      });
    } finally {
      await this.session?.close().catch(() => undefined);
      this.session = undefined;
      this.abortController = undefined;
    }
  }

  async cancel(): Promise<void> {
    this.abortController?.abort(new DOMException("Cancelled", "AbortError"));
    await this.session?.close().catch(() => undefined);
  }

  private setState(state: FlashState): void {
    this.currentState = state;
    const event = { state, timestamp: Date.now() };
    for (const listener of this.listeners) listener(event);
  }
}
