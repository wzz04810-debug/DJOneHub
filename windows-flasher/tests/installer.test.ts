import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import installerSource from "../src/assets/install-webflash.sh?raw";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function embeddedLauncher(): string {
  const startMarker = "cat > \"$INIT.webflash-new\" <<'INIT_SCRIPT'\n";
  const start = installerSource.indexOf(startMarker);
  const bodyStart = start + startMarker.length;
  const end = installerSource.indexOf("\nINIT_SCRIPT\n", bodyStart);
  if (start < 0 || end < 0) throw new Error("embedded launcher not found");
  return `${installerSource.slice(bodyStart, end)}\n`;
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function runInstallerFixture(options: { readonly agentExit?: number; readonly helperExit?: number; readonly helperWhitelist?: string; readonly launcherHash?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "djonehub-installer-"));
  roots.push(root);
  const staging = `/data/local/tmp/djonehub-webflash-${"a".repeat(32)}`;
  const stageRoot = join(root, staging.slice(1));
  const payload = join(stageRoot, "payload");
  const dataRoot = join(root, "data/djonehub");
  mkdirSync(payload, { recursive: true });
  mkdirSync(join(dataRoot, "bin"), { recursive: true });

  const helper = `#!/bin/sh\ntest \"$1\" = --check || exit 64\nexit ${options.helperExit ?? 0}\n`;
  const helperHash = sha256(helper);
  const stagedAgent = `#!/bin/sh\nif test \"$1\" = --startup-probe; then\n  echo '启动探针通过: runtime'\n  echo '__VOICE_HELPER_SHA256__${options.helperWhitelist ?? helperHash}'\n  exit ${options.agentExit ?? 0}\nfi\nexit 0\n`;
  const files = new Map<string, { readonly body: string; readonly mode: "755" | "644" }>([
    ["qdc507-agent", { body: stagedAgent, mode: "755" }],
    ["qdc507_data11_bridge.ko", { body: "data11-fixture\n", mode: "644" }],
    ["qdc507_aprv3.ko", { body: "aprv3-fixture\n", mode: "644" }],
    ["qdc507_voice.ko", { body: "voice-fixture\n", mode: "644" }],
    ["mavo-pcm-bridge.armv7", { body: helper, mode: "755" }],
  ]);
  for (const [name, file] of files) {
    const path = join(payload, name);
    writeFileSync(path, file.body);
    chmodSync(path, Number.parseInt(file.mode, 8));
  }
  const installerPath = join(payload, "install-webflash.sh");
  executable(installerPath, installerSource);
  const oldAgent = "#!/bin/sh\necho old-agent\n";
  const installedAgent = join(dataRoot, "bin/qdc507-agent");
  executable(installedAgent, oldAgent);
  writeFileSync(join(stageRoot, "install.meta"), [
    "VERSION=0.3.53",
    `INIT_SHA256=${options.launcherHash ?? sha256(embeddedLauncher())}`,
    ...[...files].map(([name, file]) => `${sha256(file.body)} ${name} ${file.mode}`),
    "",
  ].join("\n"));

  const result = spawnSync("/bin/sh", [installerPath, staging], {
    env: {
      ...process.env,
      DJWEBFLASH_TEST_ROOT: root,
      DJWEBFLASH_TEST_UID: "0",
      DJWEBFLASH_TEST_ARCH: "armv7l",
      DJWEBFLASH_TEST_KERNEL: "3.18.44",
      DJWEBFLASH_TEST_USB_ID: "2c7c:0125",
      DJWEBFLASH_TEST_CALL_STATE: "NONE",
      DJWEBFLASH_TEST_FACTORY_PID: "721",
      DJWEBFLASH_TEST_FREE_BYTES: "20971520",
    },
    encoding: "utf8",
    timeout: 5_000,
  });
  return { result, output: `${result.stdout}\n${result.stderr}`, installedAgent, oldAgent };
}

describe("transactional module installer", () => {
  it("commits a compatible staged runtime and reports completion", () => {
    const fixture = runInstallerFixture();

    expect(fixture.result.status, fixture.output).toBe(0);
    expect(fixture.output).toContain("DJWEBFLASH probe 35 checking staged runtime compatibility");
    expect(fixture.output).toContain("DJWEBFLASH complete 100 module version 0.3.53 installed");
    expect(fixture.result.stderr).toContain("DJWEBFLASH rebooting 68 keeping current USB profile after commit");
    expect(readFileSync(fixture.installedAgent, "utf8")).not.toBe(fixture.oldAgent);
  });

  it("rejects a staged Agent that fails its runtime probe before replacing the installed Agent", () => {
    const fixture = runInstallerFixture({ agentExit: 23 });

    expect(fixture.result.status, fixture.output).not.toBe(0);
    expect(fixture.output).toContain("staged Agent runtime probe failed");
    expect(readFileSync(fixture.installedAgent, "utf8")).toBe(fixture.oldAgent);
  });

  it("rejects an Agent whose embedded PCM helper whitelist does not match the staged helper", () => {
    const fixture = runInstallerFixture({ helperWhitelist: "0".repeat(64) });

    expect(fixture.result.status, fixture.output).not.toBe(0);
    expect(fixture.output).toContain("staged Agent PCM helper whitelist mismatch");
    expect(readFileSync(fixture.installedAgent, "utf8")).toBe(fixture.oldAgent);
  });

  it("rejects a staged PCM helper that fails its own check", () => {
    const fixture = runInstallerFixture({ helperExit: 9 });

    expect(fixture.result.status, fixture.output).not.toBe(0);
    expect(fixture.output).toContain("staged PCM helper check failed");
    expect(readFileSync(fixture.installedAgent, "utf8")).toBe(fixture.oldAgent);
  });

  it("rejects a launcher whose generated bytes do not match the signed install metadata before commit", () => {
    const fixture = runInstallerFixture({ launcherHash: "0".repeat(64) });

    expect(fixture.result.status, fixture.output).not.toBe(0);
    expect(fixture.output).toContain("launcher hash mismatch");
    expect(fixture.output).not.toContain("DJWEBFLASH rebooting");
    expect(readFileSync(fixture.installedAgent, "utf8")).toBe(fixture.oldAgent);
  });
});
