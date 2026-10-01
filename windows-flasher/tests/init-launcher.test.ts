import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import installerSource from "../src/assets/install-webflash.sh?raw";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function embeddedLauncher(): string {
  const startMarker = "cat > \"$INIT.webflash-new\" <<'INIT_SCRIPT'\n";
  const start = installerSource.indexOf(startMarker);
  const bodyStart = start + startMarker.length;
  const end = installerSource.indexOf("\nINIT_SCRIPT\n", bodyStart);
  if (start < 0 || end < 0) throw new Error("embedded launcher not found");
  return installerSource.slice(bodyStart, end) + "\n";
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("embedded module launcher", () => {
  it("converges an iPhone ECM+audio profile to mobile functions instead of silently exiting", () => {
    const root = mkdtempSync(join(tmpdir(), "djonehub-launcher-"));
    roots.push(root);
    const data = join(root, "data/djonehub");
    const gadget = join(root, "gadget");
    const fakeBin = join(root, "bin");
    for (const directory of [join(data, "bin"), join(data, "kernel"), join(data, "log"), join(gadget, "f_serial"), join(root, "run"), join(root, "proc"), join(root, "dev"), fakeBin]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(gadget, "functions"), "diag,serial,ecm,ffs,audio\n");
    writeFileSync(join(gadget, "enable"), "1\n");
    writeFileSync(join(gadget, "f_serial/transports"), "tty\n");
    writeFileSync(join(root, "proc/modules"), "qdc507_data11_bridge 1 0 - Live 0x0\n");
    writeFileSync(join(root, "proc/misc"), "42 djonehub_data11\n");
    executable(join(data, "bin/qdc507-agent"), "exit 0");
    writeFileSync(join(data, "kernel/qdc507_data11_bridge.ko"), "fixture");
    executable(join(fakeBin, "pidof"), "test \"$1\" = ql_manager_server && echo 321");
    executable(join(fakeBin, "sleep"), "exit 0");
    executable(join(fakeBin, "mknod"), "touch \"$1\"");

    const launcherPath = join(root, "djonehub_agent");
    const launcher = embeddedLauncher()
      .replaceAll("/data/djonehub", data)
      .replaceAll("/run/djonehub", join(root, "run/djonehub"))
      .replaceAll("/dev/djonehub_data11", join(root, "dev/djonehub_data11"))
      .replaceAll("/sys/devices/virtual/android_usb/android0", gadget)
      .replaceAll("/proc/modules", join(root, "proc/modules"))
      .replaceAll("/proc/misc", join(root, "proc/misc"));
    writeFileSync(launcherPath, launcher);
    chmodSync(launcherPath, 0o755);

    const result = spawnSync("/bin/sh", [launcherPath, "start"], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      timeout: 8_000,
    });

    const startupLog = join(data, "log/startup.log");
    const evidence = `status=${result.status} signal=${result.signal} stderr=${result.stderr.toString()} startup=${existsSync(startupLog) ? readFileSync(startupLog, "utf8") : "missing"}`;
    expect(readFileSync(join(gadget, "functions"), "utf8").trim(), evidence).toBe("diag,ecm,ffs");
  });

  it("keeps the current USB gadget combination during a WebFlash install", () => {
    const root = mkdtempSync(join(tmpdir(), "djonehub-launcher-keep-usb-"));
    roots.push(root);
    const data = join(root, "data/djonehub");
    const gadget = join(root, "gadget");
    const fakeBin = join(root, "bin");
    const runDir = join(root, "run");
    for (const directory of [join(data, "bin"), join(data, "kernel"), join(data, "log"), join(gadget, "f_serial"), runDir, join(root, "proc"), join(root, "dev"), fakeBin]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(gadget, "functions"), "diag,serial,ecm,ffs,audio\n");
    writeFileSync(join(gadget, "enable"), "1\n");
    writeFileSync(join(gadget, "f_serial/transports"), "tty\n");
    writeFileSync(join(root, "proc/modules"), "qdc507_data11_bridge 1 0 - Live 0x0\n");
    writeFileSync(join(root, "proc/misc"), "42 djonehub_data11\n");
    writeFileSync(join(runDir, "djonehub-webflash-keep-usb"), "");
    executable(join(data, "bin/qdc507-agent"), "exit 0");
    writeFileSync(join(data, "kernel/qdc507_data11_bridge.ko"), "fixture");
    executable(join(fakeBin, "pidof"), "test \"$1\" = ql_manager_server && echo 321");
    executable(join(fakeBin, "sleep"), "exit 0");
    executable(join(fakeBin, "mknod"), "touch \"$1\"");

    const launcherPath = join(root, "djonehub_agent");
    const launcher = embeddedLauncher()
      .replaceAll("/data/djonehub", data)
      .replaceAll("/run/djonehub", join(root, "run/djonehub"))
      .replaceAll("/dev/djonehub_data11", join(root, "dev/djonehub_data11"))
      .replaceAll("/sys/devices/virtual/android_usb/android0", gadget)
      .replaceAll("/proc/modules", join(root, "proc/modules"))
      .replaceAll("/proc/misc", join(root, "proc/misc"));
    writeFileSync(launcherPath, launcher);
    chmodSync(launcherPath, 0o755);

    const result = spawnSync("/bin/sh", [launcherPath, "start"], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      timeout: 8_000,
    });

    const startupLog = join(data, "log/startup.log");
    const evidence = `status=${result.status} signal=${result.signal} stderr=${result.stderr.toString()} startup=${existsSync(startupLog) ? readFileSync(startupLog, "utf8") : "missing"}`;
    expect(readFileSync(join(gadget, "functions"), "utf8").trim(), evidence).toBe("diag,serial,ecm,ffs,audio");
    expect(readFileSync(startupLog, "utf8"), evidence).toContain("webflash-keep-usb skip-rebind");
  });
});
