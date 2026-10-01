import { describe, expect, it } from "vitest";
import { installBootstrap } from "../src/bootstrap/installer";
import type { BootstrapBundle } from "../src/bootstrap/package";
import { bootstrapFixture } from "./bootstrap-fixture";

async function bundle(): Promise<BootstrapBundle> {
  const { archive, policy } = await bootstrapFixture();
  const { verifyBootstrapArchive } = await import("../src/bootstrap/package");
  return verifyBootstrapArchive(archive, policy);
}

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function rig(options: { agentRunning?: boolean; callStatus?: string; failCommitAt?: string } = {}) {
  const verified = await bundle();
  const commands: Array<{ kind: string; [key: string]: unknown }> = [];
  const pushes: string[] = [];
  const old = new Map<string, Uint8Array>();
  for (const file of verified.files) old.set(file.remotePath, new TextEncoder().encode(`old:${file.remotePath}`));
  const oldHashes = new Map<string, string>();
  for (const [path, bytes] of old) oldHashes.set(path, await hash(bytes));
  const agentRunning = options.agentRunning ?? true;
  const client = {
    runShell: async (command: { kind: string; [key: string]: unknown }) => {
      commands.push(command);
      if (command.kind === "bootstrap-inspect") {
        return [
          "DJONEHUB_BOOTSTRAP_INSPECT_BEGIN", "uid=0", "arch=armv7l", "kernel=3.18.44",
          "usb=2c7c:0125", "factory_pid=721", "functions=diag,serial,ecm,ffs,audio",
          "mount=ubi0:rootfs on / type ubifs (ro,relatime)", "root_free=131300", "installed=0",
          `agent_running=${agentRunning ? 1 : 0}`,
          ...verified.files.map((file) => `file.${file.name}=${old.get(file.remotePath)!.byteLength},${oldHashes.get(file.remotePath)}`),
          "link=../init.d/old_bootstrap", "DJONEHUB_BOOTSTRAP_INSPECT_END", "",
        ].join("\n");
      }
      if (command.kind === "bootstrap-call-agent") return options.callStatus ?? '{"polling":true,"last_poll_error":"","active":null}';
      if (command.kind === "bootstrap-call-qmi") return "block_check_condition call_state NONE TRUE";
      if (command.kind === "preclean") return "v1 1 1 0";
      if (command.kind === "bootstrap-prepare-write" || command.kind === "bootstrap-prepare-rollback") return "prepared=rw";
      if (command.kind === "bootstrap-remove-target") return `removed=${command.name}`;
      if (command.kind === "bootstrap-commit-target") {
        if (command.name === options.failCommitAt) throw new Error("injected commit failure");
        return `committed=${command.sha256}`;
      }
      if (command.kind === "bootstrap-restore-target") return `restored=${command.sha256}`;
      if (command.kind === "bootstrap-finalize" || command.kind === "bootstrap-finalize-rollback") {
        return `rootfs=ro\nagent_running=${agentRunning ? 1 : 0}`;
      }
      if (command.kind === "bootstrap-verify") {
        return [
          ...verified.files.map((file) => `sha.${file.name}=${file.sha256}`),
          "link=../init.d/djonehub_bootstrap", "rootfs=ro", "executable=1",
          `agent_running=${agentRunning ? 1 : 0}`, "",
        ].join("\n");
      }
      throw new Error(`unexpected command ${command.kind}`);
    },
  };
  const sync = {
    pull: async (path: string) => old.get(path)!,
    push: async (path: string) => { pushes.push(path); },
  };
  return { verified, client, sync, commands, pushes };
}

describe("Bootstrap rootfs installer", () => {
  it("uses Agent call safety only, backs up in host memory, replaces old files, remounts ro and restores Agent", async () => {
    const testRig = await rig({ agentRunning: true });
    const steps: number[] = [];

    await expect(installBootstrap(testRig.client as never, testRig.sync as never, testRig.verified, ({ step }) => {
      if (steps.at(-1) !== step) steps.push(step);
    })).resolves.toMatchObject({ version: "0.1.0" });

    expect(testRig.commands.some((command) => command.kind === "bootstrap-call-agent")).toBe(true);
    expect(testRig.commands.some((command) => command.kind === "bootstrap-call-qmi")).toBe(false);
    expect(testRig.pushes).toHaveLength(5);
    expect(testRig.pushes.every((path) => path.endsWith(".webflash-next"))).toBe(true);
    expect(testRig.commands).toContainEqual({ kind: "bootstrap-finalize", restoreAgent: true });
    expect(steps).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("rejects an untrusted Agent call state without falling back to QMI or modifying rootfs", async () => {
    const testRig = await rig({ agentRunning: true, callStatus: '{"polling":false,"last_poll_error":"timeout","active":null,"number":"13800138000"}' });

    await expect(installBootstrap(testRig.client as never, testRig.sync as never, testRig.verified)).rejects.toMatchObject({ code: "CALL_ACTIVE" });

    expect(testRig.commands.some((command) => command.kind === "bootstrap-call-qmi")).toBe(false);
    expect(testRig.commands.some((command) => command.kind === "bootstrap-prepare-write")).toBe(false);
    expect(testRig.pushes).toHaveLength(0);
  });

  it("uses original QMI only when Agent was not running", async () => {
    const testRig = await rig({ agentRunning: false });
    await installBootstrap(testRig.client as never, testRig.sync as never, testRig.verified);
    expect(testRig.commands.some((command) => command.kind === "bootstrap-call-agent")).toBe(false);
    expect(testRig.commands.some((command) => command.kind === "bootstrap-call-qmi")).toBe(true);
    expect(testRig.commands).toContainEqual({ kind: "bootstrap-finalize", restoreAgent: false });
  });

  it("rolls every modified rootfs target back from browser memory and confirms ro after a commit failure", async () => {
    const testRig = await rig({ failCommitAt: "djonehub_agent" });

    await expect(installBootstrap(testRig.client as never, testRig.sync as never, testRig.verified)).rejects.toThrow("injected commit failure");

    expect(testRig.commands.some((command) => command.kind === "bootstrap-prepare-rollback")).toBe(true);
    expect(testRig.pushes.some((path) => path.endsWith(".webflash-restore"))).toBe(true);
    expect(testRig.commands).toContainEqual({
      kind: "bootstrap-finalize-rollback",
      linkTarget: "../init.d/old_bootstrap",
      restoreAgent: true,
    });
  });
});
