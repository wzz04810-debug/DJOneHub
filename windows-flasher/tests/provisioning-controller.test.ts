import { afterEach, describe, expect, it } from "vitest";
import { clearDiagnostics, subscribeDiagnostics } from "../src/diagnostics";
import { FlashError, MODULE_PLATFORM, type WebflashManifest } from "../src/domain";
import {
  ProvisioningController,
  authorizeRecovery,
  type ProvisioningDependencies,
} from "../src/provisioning/controller";
import installerSource from "../src/assets/install-webflash.sh?raw";
import type { BootstrapBundle } from "../src/bootstrap/package";

const INIT_HASH = "4b5a181c447513b84005a633715ba3f253c825b2ac209df93ade740dac0a8550";
const encoder = new TextEncoder();

function rig(options: { signatureInvalid?: boolean; disconnectDuringInstall?: boolean; disconnectBeforeReboot?: boolean; disconnectAfterCommit?: boolean; disconnectAsDomException?: boolean; health?: string; reconnectError?: FlashError; installOutput?: string; installStatus?: string; availableBytes?: number; installerBytes?: Uint8Array; initHash?: string; verifyFactoryPid?: string; usbFunctions?: string } = {}) {
  let requests = 0;
  let pushes = 0;
  let reclaims = 0;
  const pushedFiles: { path: string; bytes: Uint8Array }[] = [];
  const installerBytes = options.installerBytes ?? encoder.encode(installerSource);
  const manifest: WebflashManifest = {
    format_version: 1, version: "0.3.5", platform: MODULE_PLATFORM,
    files: [{ name: "install-webflash.sh", archive_path: "payload/install-webflash.sh", target: "/data/local/tmp/install-webflash.sh", sha256: "a".repeat(64), size: installerBytes.byteLength, mode: 493 }],
  };
  const clients = [{
    runShell: async (_command: unknown, _signal?: AbortSignal, onChunk?: (value: string) => void) => {
      if (options.disconnectAfterCommit) onChunk?.("DJWEBFLASH commit 45 committing verified payload\n");
      else if (!options.disconnectBeforeReboot) onChunk?.("DJWEBFLASH rebooting 68 keeping current USB profile after commit\n");
      if (options.disconnectBeforeReboot || options.disconnectDuringInstall || options.disconnectAfterCommit) {
        if (options.disconnectAsDomException) {
          throw new DOMException("Failed to execute 'transferIn' on 'USBDevice': The device was disconnected.", "NetworkError");
        }
        throw new FlashError("USB_DISCONNECTED", options.disconnectBeforeReboot ? "too early" : "expected");
      }
      return options.installOutput ?? "DJWEBFLASH complete 100 done\n";
    },
  }, {
    runShell: async (command: { kind?: string } = {}, _signal?: AbortSignal, onChunk?: (value: string) => void) => {
      if (command.kind === "install-status") {
        const status = options.installStatus ?? "";
        onChunk?.(status);
        return status;
      }
      return `health=${options.health ?? '{"ok":true,"version":"0.3.5"}'}\ninit_sha256=${options.initHash ?? INIT_HASH}\nfactory_pid=${options.verifyFactoryPid ?? "721"}\n`;
    },
  }];
  const dependencies = {
    checkEnvironment: () => undefined,
    acquire: async () => ({ client: clients[Math.min(requests++, 1)] as never, close: async () => undefined }),
    reconnect: async () => {
      if (options.reconnectError) throw options.reconnectError;
      return { client: clients[1] as never, close: async () => undefined };
    },
    release: {
      fetchStableChannel: async () => ({ format_version: 1, channel: "stable", version: "0.3.5", platform: MODULE_PLATFORM, asset_url: "https://github.com/x", sha256: "0".repeat(64), size: 1, published_at: "2026-08-18T00:00:00Z" }),
      fetchPackage: async () => new Uint8Array([1]),
    },
    verifyArchive: async () => {
      if (options.signatureInvalid) throw new FlashError("SIGNATURE_INVALID", "bad");
      return { manifest, files: new Map([["payload/install-webflash.sh", { bytes: installerBytes, mode: 493 as const, target: "/data/local/tmp/install-webflash.sh" }]]) };
    },
    verifyLocalArchive: async (_archive: Uint8Array) => ({ manifest, files: new Map() }),
    installerBytes,
    preflight: async () => ({ platform: MODULE_PLATFORM, availableBytes: options.availableBytes ?? 20_000_000, factoryPid: 721, callState: "NONE" as const, installedVersion: undefined, usbFunctions: options.usbFunctions ?? "adb", agentPid: undefined, port7575Listening: false, serialConnected: false, capabilities: { busybox: true, sha256: true, wget: true } }),
    syncFor: () => ({ push: async (path: string, bytes: Uint8Array) => { pushes += 1; pushedFiles.push({ path, bytes }); }, pull: async () => new Uint8Array() }),
    inspectInstalled: async () => new Map(),
    reclaimSpace: async (_client, _sync, _directory, _replacements, available, required) => {
      reclaims += 1;
      if (available >= required) return [];
      throw new FlashError("INSUFFICIENT_SPACE", `需要 ${required}，实际 ${available}`);
    },
    restoreBackups: async () => undefined,
    bootstrap: {
      fetchPackage: async () => new Uint8Array([1]),
      verifyArchive: async () => ({ version: "0.1.0", files: [] }) as BootstrapBundle,
      install: async () => ({ version: "0.1.0" }),
    },
    randomBytes: () => new Uint8Array(16).fill(10),
  } satisfies ProvisioningDependencies;
  return { controller: new ProvisioningController(dependencies), dependencies, pushedFiles, get requests() { return requests; }, get pushes() { return pushes; }, get reclaims() { return reclaims; } };
}

afterEach(clearDiagnostics);

describe("provisioning controller", () => {
  it("preflights, verifies, uploads, installs, reconnects, and verifies health", async () => {
    const testRig = rig({ disconnectDuringInstall: true });
    const phases: string[] = [];
    testRig.controller.subscribe((event) => phases.push(event.state.phase));
    await testRig.controller.start();
    expect(phases).toEqual(expect.arrayContaining(["preflight", "downloading", "verifying-package", "uploading", "installing", "waiting-reconnect", "verifying-device", "completed"]));
    expect(testRig.controller.state).toEqual({ phase: "completed", version: "0.3.5" });
    expect(testRig.reclaims).toBe(1);
  });

  it("records elapsed time and throughput for each completed upload", async () => {
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));
    const testRig = rig();

    await testRig.controller.start();
    unsubscribe();

    expect(entries).toContainEqual(expect.stringMatching(
      /^UPLOAD_FILE_OK file=payload\/install-webflash\.sh size_kib=\d+ elapsed_ms=\d+ rate_kib_s=\d+$/,
    ));
  });

  it("reports every optimized WebFlash step in order", async () => {
    const testRig = rig();
    const steps: number[] = [];
    testRig.controller.subscribe((event) => {
      if (event.state.step !== undefined && steps.at(-1) !== event.state.step) steps.push(event.state.step);
    });

    await testRig.controller.start();

    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  });

  it("binds the verified dual-mode launcher digest into install metadata", async () => {
    const testRig = rig();

    await testRig.controller.start();

    const metadata = testRig.pushedFiles.find(({ path }) => path.endsWith("/install.meta"));
    expect(metadata).toBeDefined();
    expect(new TextDecoder().decode(metadata!.bytes)).toContain(`INIT_SHA256=${INIT_HASH}\n`);
  });

  it("verifies the init script embedded in the installer used for this flash", async () => {
    const customInstaller = encoder.encode([
      "#!/bin/sh",
      "cat > \"$INIT.webflash-new\" <<'INIT_SCRIPT'",
      "#!/bin/sh",
      "echo custom",
      "INIT_SCRIPT",
      "",
    ].join("\n"));
    const testRig = rig({
      installerBytes: customInstaller,
      initHash: "d3d3248485c1647c78364c46e2f5932e689e7d0e6e1d9159617f3df098db5b8d",
    });

    await testRig.controller.start();

    expect(testRig.controller.state).toEqual({ phase: "completed", version: "0.3.5" });
  });

  it("logs each post-install verification result before reporting an init mismatch", async () => {
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));
    const testRig = rig({ initHash: "f".repeat(64) });

    await testRig.controller.start();
    unsubscribe();

    expect(testRig.controller.state).toMatchObject({
      phase: "failed",
      code: "HEALTH_CHECK_FAILED",
      message: "模块启动脚本校验失败",
    });
    expect(entries).toContainEqual(expect.stringMatching(
      /^POST_VERIFY_FIELDS .*health_ok=true .*health_version=0\.3\.5 .*expected_version=0\.3\.5 .*init_match=false .*factory_match=true/,
    ));
  });

  it("reports the expected and actual factory service PID comparison", async () => {
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));
    const testRig = rig({ verifyFactoryPid: "999" });

    await testRig.controller.start();
    unsubscribe();

    expect(testRig.controller.state).toMatchObject({
      phase: "failed",
      code: "HEALTH_CHECK_FAILED",
      message: "原厂服务 PID 校验失败",
    });
    expect(entries).toContainEqual(expect.stringMatching(/POST_VERIFY_FIELDS .*factory_actual=999 .*factory_expected=721 .*factory_match=false/));
  });

  it("logs recognized installer progress with its stage and detail", async () => {
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));

    await rig().controller.start();
    unsubscribe();

    expect(entries).toContain("INSTALLER_PROGRESS stage=rebooting percent=68 detail=keeping current USB profile after commit");
  });

  it("never uploads when signature verification fails", async () => {
    const testRig = rig({ signatureInvalid: true });
    await testRig.controller.start();
    expect(testRig.pushes).toBe(0);
    expect(testRig.controller.state).toMatchObject({ phase: "failed", code: "SIGNATURE_INVALID" });
  });

  it("checks free space against the verified upload size before pushing", async () => {
    const testRig = rig({ availableBytes: 5 });
    await testRig.controller.start();
    expect(testRig.pushes).toBe(0);
    expect(testRig.controller.state).toMatchObject({ phase: "failed", code: "INSUFFICIENT_SPACE" });
    expect(testRig.controller.state).toHaveProperty("message", expect.stringContaining("实际"));
  });

  it("restores Mac-memory backups when a reclaimed-space install fails", async () => {
    const testRig = rig({ availableBytes: 1, installOutput: "DJWEBFLASH failed 0 startup failed\n" });
    const oldHash = "235876678c894d464bb819de79dbbdd062af9fbbae5ed63ec8c54a3a0b0d6088";
    const newHash = "4a4afd9115fd6cf19d40de4d46862b9ce7f27d0a0d5c414b54ff5c75e2b711da";
    const agentManifest: WebflashManifest = {
      format_version: 1, version: "0.3.5", platform: MODULE_PLATFORM,
      files: [{ name: "qdc507-agent", archive_path: "payload/qdc507-agent", target: "/data/djonehub/bin/qdc507-agent", sha256: newHash, size: 9, mode: 0o755 }],
    };
    let restores = 0;
    const controller = new ProvisioningController({
      ...testRig.dependencies,
      verifyLocalArchive: async () => ({
        manifest: agentManifest,
        files: new Map([["payload/qdc507-agent", { bytes: new TextEncoder().encode("new-agent"), mode: 0o755 as const, target: "/data/djonehub/bin/qdc507-agent" }]]),
      }),
      inspectInstalled: async () => new Map([["qdc507-agent", oldHash]]),
      reclaimSpace: async () => [{ name: "qdc507-agent", path: "/data/djonehub/bin/qdc507-agent", mode: 0o755, sha256: oldHash, bytes: new TextEncoder().encode("old-agent") }],
      restoreBackups: async () => { restores += 1; },
    });
    await controller.start({ localPackage: new Uint8Array([1]) });
    expect(restores).toBe(1);
    expect(controller.state).toMatchObject({
      phase: "failed",
      code: "INSTALL_FAILED",
      message: "模块安装器失败：startup failed",
    });
  });

  it("uses direct no-backup reclaim only for an explicitly authorized downgrade", async () => {
    const testRig = rig({ availableBytes: 1 });
    let reclaimStrategy: unknown;
    const controller = new ProvisioningController({
      ...testRig.dependencies,
      preflight: async () => ({ ...(await testRig.dependencies.preflight()), installedVersion: "0.3.53" }),
      reclaimSpace: async (...args: unknown[]) => {
        reclaimStrategy = args[8];
        return [];
      },
    } as unknown as ProvisioningDependencies);

    await controller.start({
      localPackage: new Uint8Array([1]),
      recovery: authorizeRecovery(true, "RECOVER 0.3.5", "0.3.5"),
    });

    expect(reclaimStrategy).toBe("direct");
    expect(controller.state).toEqual({ phase: "completed", version: "0.3.5" });
  });

  it("requires explicit repair authorization when a same-version install lacks safe space", async () => {
    const testRig = rig({ availableBytes: 1 });
    const controller = new ProvisioningController({
      ...testRig.dependencies,
      preflight: async () => ({ ...(await testRig.dependencies.preflight()), installedVersion: "0.3.5" }),
    });

    await controller.start({ localPackage: new Uint8Array([1]) });

    expect(controller.state).toMatchObject({ phase: "failed", code: "REPAIR_REQUIRED" });
  });

  it("uses direct no-backup reclaim for an explicitly authorized same-version repair", async () => {
    const testRig = rig({ availableBytes: 1 });
    let reclaimStrategy: unknown;
    const controller = new ProvisioningController({
      ...testRig.dependencies,
      preflight: async () => ({ ...(await testRig.dependencies.preflight()), installedVersion: "0.3.5" }),
      reclaimSpace: async (...args: unknown[]) => {
        reclaimStrategy = args[8];
        return [];
      },
    } as unknown as ProvisioningDependencies);

    await controller.start({
      localPackage: new Uint8Array([1]),
      recovery: authorizeRecovery(true, "RECOVER 0.3.5", "0.3.5"),
    });

    expect(reclaimStrategy).toBe("direct");
  });

  it("rebinds rollback uploads to the reconnected ADB session", async () => {
    const testRig = rig();
    const syncs = [
      { push: async () => undefined, pull: async () => new Uint8Array() },
      { push: async () => undefined, pull: async () => new Uint8Array() },
    ];
    let syncCalls = 0;
    let preflightCalls = 0;
    let restoredWith: unknown;
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));
    const controller = new ProvisioningController({
      ...testRig.dependencies,
      preflight: async () => {
        preflightCalls += 1;
        if (preflightCalls === 1) return testRig.dependencies.preflight();
        throw new FlashError("UNSUPPORTED_DEVICE", "模块预检输出格式无效");
      },
      syncFor: () => syncs[syncCalls++]!,
      reclaimSpace: async () => [{
        name: "qdc507-agent",
        path: "/data/djonehub/bin/qdc507-agent",
        mode: 0o755,
        sha256: "2".repeat(64),
        bytes: encoder.encode("old-agent"),
      }],
      restoreBackups: async (_client, sync) => { restoredWith = sync; },
    });

    await controller.start({ localPackage: new Uint8Array([1]) });
    unsubscribe();

    expect(syncCalls).toBe(2);
    expect(restoredWith).toBe(syncs[1]);
    expect(entries).toContain("ROLLBACK_TRIGGER original_code=UNSUPPORTED_DEVICE original_message=模块预检输出格式无效");
    expect(controller.state).toMatchObject({ phase: "failed", code: "UNSUPPORTED_DEVICE" });
  });

  it("requires exact one-shot recovery authorization", () => {
    expect(() => authorizeRecovery(false, "RECOVER 0.3.4", "0.3.4")).toThrow();
    expect(() => authorizeRecovery(true, "recover 0.3.4", "0.3.4")).toThrow();
    expect(authorizeRecovery(true, "RECOVER 0.3.4", "0.3.4")).toBeTruthy();
  });

  it("fails an install disconnect before the reboot marker", async () => {
    const testRig = rig({ disconnectBeforeReboot: true });
    await testRig.controller.start();
    expect(testRig.controller.state).toMatchObject({ phase: "failed", code: "USB_DISCONNECTED" });
  });

  it("treats a Chrome transferIn disconnect after payload commit as a reconnect, not INSTALL_FAILED", async () => {
    const testRig = rig({ disconnectAfterCommit: true, disconnectAsDomException: true });
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));
    await testRig.controller.start();
    unsubscribe();
    expect(testRig.controller.state).toEqual({ phase: "completed", version: "0.3.5" });
    expect(entries).toContain("INSTALL_USB_REBIND USB dropped after payload commit; continuing with reconnect verification");
  });

  it("maps a Chrome USB disconnect before commit to USB_DISCONNECTED instead of INSTALL_FAILED", async () => {
    const testRig = rig({ disconnectBeforeReboot: true, disconnectAsDomException: true });
    await testRig.controller.start();
    expect(testRig.controller.state).toMatchObject({
      phase: "failed",
      code: "USB_DISCONNECTED",
      message: "模块 USB 在安装提交前断开",
    });
  });

  it("recovers a buffered USB drop by reading install.log after reconnect", async () => {
    const testRig = rig({
      disconnectBeforeReboot: true,
      disconnectAsDomException: true,
      installStatus: "DJWEBFLASH commit 45 committing verified payload\nDJWEBFLASH launcher 60 dual-mode launcher verified and committed\n",
    });
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));
    await testRig.controller.start();
    unsubscribe();
    expect(testRig.controller.state).toEqual({ phase: "completed", version: "0.3.5" });
    expect(entries).toContain("INSTALL_USB_REBIND install.log confirmed payload commit after USB drop");
  });

  it("skips Agent health verification on a Mac USB profile", async () => {
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));
    const testRig = rig({
      usbFunctions: "diag,serial,ecm,ffs,audio",
      health: "not-json",
    });
    await testRig.controller.start();
    unsubscribe();
    expect(testRig.controller.state).toEqual({ phase: "completed", version: "0.3.5" });
    expect(entries).toContain("POST_VERIFY_MAC_PROFILE agent health skipped for Mac USB profile");
  });

  it("maps reconnect timeout, health failure, and unconfirmed rollback", async () => {
    const timeout = rig({ disconnectDuringInstall: true, reconnectError: new FlashError("USB_DISCONNECTED", "timeout") });
    await timeout.controller.start();
    expect(timeout.controller.state).toMatchObject({ phase: "failed", code: "USB_DISCONNECTED" });

    const unhealthy = rig({ health: '{"ok":false,"version":"0.3.5"}' });
    await unhealthy.controller.start();
    expect(unhealthy.controller.state).toMatchObject({ phase: "failed", code: "HEALTH_CHECK_FAILED" });

    const rollback = rig({ installOutput: "DJWEBFLASH failed 0 rollback unconfirmed\n" });
    await rollback.controller.start();
    expect(rollback.controller.state).toMatchObject({ phase: "failed", code: "ROLLBACK_UNCONFIRMED" });
  });

  it("cancels an in-flight device request", async () => {
    const testRig = rig();
    const controller = new ProvisioningController({
      ...testRig.dependencies,
      acquire: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });
    const running = controller.start();
    await controller.cancel();
    await running;
    expect(controller.state).toMatchObject({ phase: "failed", code: "CANCELLED" });
  });

  it("uses a selected signed djupdate without contacting the release channel", async () => {
    const testRig = rig();
    let localVerifications = 0;
    let channelFetches = 0;
    const controller = new ProvisioningController({
      ...testRig.dependencies,
      release: {
        ...testRig.dependencies.release,
        fetchStableChannel: async () => { channelFetches += 1; return testRig.dependencies.release.fetchStableChannel(); },
      },
      verifyLocalArchive: async () => {
        localVerifications += 1;
        return testRig.dependencies.verifyLocalArchive(new Uint8Array());
      },
    });
    await controller.start({ localPackage: new Uint8Array([1, 2, 3]) });
    expect(localVerifications).toBe(1);
    expect(channelFetches).toBe(0);
    expect(controller.state).toMatchObject({ phase: "completed", version: "0.3.5" });
  });

  it("runs Bootstrap through its pinned package and installer without invoking Agent preflight or release", async () => {
    const testRig = rig();
    let agentPreflights = 0;
    let agentReleases = 0;
    let bootstrapFetches = 0;
    let bootstrapInstalls = 0;
    const controller = new ProvisioningController({
      ...testRig.dependencies,
      preflight: async () => { agentPreflights += 1; return testRig.dependencies.preflight(); },
      release: {
        ...testRig.dependencies.release,
        fetchStableChannel: async () => { agentReleases += 1; return testRig.dependencies.release.fetchStableChannel(); },
      },
      bootstrap: {
        fetchPackage: async () => { bootstrapFetches += 1; return new Uint8Array([1]); },
        verifyArchive: async () => ({ version: "0.1.0", files: [] }),
        install: async (_client, _sync, _bundle, onProgress) => {
          bootstrapInstalls += 1;
          for (let step = 3; step <= 14; step += 1) onProgress?.({ step, detail: `bootstrap-${step}` });
          return { version: "0.1.0" };
        },
      },
    });
    const steps: number[] = [];
    controller.subscribe(({ state }) => { if (state.step !== undefined && steps.at(-1) !== state.step) steps.push(state.step); });

    await controller.start({ mode: "bootstrap" });

    expect(agentPreflights).toBe(0);
    expect(agentReleases).toBe(0);
    expect(bootstrapFetches).toBe(1);
    expect(bootstrapInstalls).toBe(1);
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(controller.state).toEqual({ phase: "completed", version: "Bootstrap 0.1.0" });
  });
});
