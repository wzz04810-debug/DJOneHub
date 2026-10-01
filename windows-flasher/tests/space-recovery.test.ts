import { afterEach, describe, expect, it } from "vitest";
import { clearDiagnostics, subscribeDiagnostics } from "../src/diagnostics";
import { MODULE_PLATFORM, type WebflashManifest } from "../src/domain";
import {
  inspectInstalledPayloads,
  reclaimSpaceWithBackups,
  restoreExternalBackups,
  selectPayloadUploads,
  type RecoverySync,
} from "../src/provisioning/space-recovery";

const OLD_HASH = "235876678c894d464bb819de79dbbdd062af9fbbae5ed63ec8c54a3a0b0d6088";
const NEW_HASH = "4a4afd9115fd6cf19d40de4d46862b9ce7f27d0a0d5c414b54ff5c75e2b711da";

afterEach(clearDiagnostics);
function manifest(): WebflashManifest {
  return {
    format_version: 1,
    version: "0.3.10",
    platform: MODULE_PLATFORM,
    files: [{
      name: "qdc507-agent", archive_path: "payload/qdc507-agent",
      target: "/data/djonehub/bin/qdc507-agent", sha256: NEW_HASH,
      size: 9, mode: 0o755,
    }],
  };
}

describe("low-space payload recovery", () => {
  it("parses the complete fixed installed payload inventory", async () => {
    const output = [
      `qdc507-agent=${OLD_HASH}`,
      "qdc507_data11_bridge.ko=missing",
      "qdc507_aprv3.ko=missing",
      "qdc507_voice.ko=missing",
      "mavo-pcm-bridge.armv7=missing",
      "",
    ].join("\n");
    const values = await inspectInstalledPayloads({ runShell: async () => output } as never);
    expect(values.get("qdc507-agent")).toBe(OLD_HASH);
    expect(values.get("qdc507_voice.ko")).toBeUndefined();
  });

  it("omits an installed payload only when its hash matches the signed manifest", () => {
    const file = { bytes: new TextEncoder().encode("new-agent"), mode: 0o755 as const, target: "/data/djonehub/bin/qdc507-agent" };
    const pkg = { manifest: manifest(), files: new Map([["payload/qdc507-agent", file]]) };
    expect(selectPayloadUploads(pkg, new Map([["qdc507-agent", NEW_HASH]])).uploads.size).toBe(0);
    expect(selectPayloadUploads(pkg, new Map([["qdc507-agent", OLD_HASH]])).uploads.size).toBe(1);
  });

  it("verifies a Mac-memory backup before deleting the old payload", async () => {
    const commands: unknown[] = [];
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "missing 0 1";
        if (command.kind === "preclean") return "v1 1 5 4";
        return "64";
      },
    };
    const sync = {
      pull: async () => new TextEncoder().encode("old-agent"),
      push: async () => undefined,
    } satisfies RecoverySync;
    const file = { bytes: new TextEncoder().encode("new-agent"), mode: 0o755 as const, target: "/data/djonehub/bin/qdc507-agent" };
    const replacements = [{ archivePath: "payload/qdc507-agent", file, name: "qdc507-agent" as const, newSha256: NEW_HASH, installedSha256: OLD_HASH }];

    const backups = await reclaimSpaceWithBackups(client as never, sync, "/data/local/tmp/djonehub-webflash-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", replacements, 1, 10);
    expect(backups[0]).toMatchObject({ name: "qdc507-agent", sha256: OLD_HASH });
    expect(commands.map((command) => (command as { kind: string }).kind)).toEqual([
      "maintain-log",
      "preclean",
      "remove-payloads",
    ]);
    expect(commands).toContainEqual({
      kind: "remove-payloads",
      entries: [{ name: "qdc507-agent", sha256: OLD_HASH }],
      discardRecovery: true,
    });
  });

  it("backs up and removes only the Agent when other payloads also change", async () => {
    const commands: unknown[] = [];
    const pulled: string[] = [];
    const oldAgent = new TextEncoder().encode("old-agent");
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "missing 0 1";
        if (command.kind === "preclean") return "v1 1 1 0";
        if (command.kind === "remove-payloads") return "64";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };
    const file = { bytes: new TextEncoder().encode("new"), mode: 0o755 as const, target: "/data/djonehub/bin/qdc507-agent" };
    const voiceFile = { bytes: new TextEncoder().encode("voice"), mode: 0o644 as const, target: "/data/djonehub/voice-runtime/qdc507_voice.ko" };

    const backups = await reclaimSpaceWithBackups(
      client as never,
      {
        pull: async (path) => { pulled.push(path); return oldAgent; },
        push: async () => undefined,
      },
      "/data/local/tmp/djonehub-webflash-acacacacacacacacacacacacacacacac",
      [
        { archivePath: "payload/qdc507-agent", file, name: "qdc507-agent", newSha256: NEW_HASH, installedSha256: OLD_HASH },
        { archivePath: "payload/qdc507_voice.ko", file: voiceFile, name: "qdc507_voice.ko", newSha256: NEW_HASH, installedSha256: OLD_HASH },
      ],
      1,
      10,
    );

    expect(pulled).toEqual(["/data/djonehub/bin/qdc507-agent"]);
    expect(backups.map((backup) => backup.name)).toEqual(["qdc507-agent"]);
    expect(commands).toContainEqual({
      kind: "remove-payloads",
      entries: [{ name: "qdc507-agent", sha256: OLD_HASH }],
      discardRecovery: true,
    });
  });

  it("matches the native Mac flow by precleaning before a low-space host-memory backup", async () => {
    const commands: unknown[] = [];
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "missing 0 2";
        if (command.kind === "preclean") return "v1 2 12 10";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };
    const sync = {
      pull: async () => { throw new Error("preclean made enough space, backup must be skipped"); },
      push: async () => undefined,
    } satisfies RecoverySync;
    const file = { bytes: new TextEncoder().encode("new-agent"), mode: 0o755 as const, target: "/data/djonehub/bin/qdc507-agent" };

    await expect(reclaimSpaceWithBackups(
      client as never,
      sync,
      "/data/local/tmp/djonehub-webflash-abababababababababababababababab",
      [{ archivePath: "payload/qdc507-agent", file, name: "qdc507-agent", newSha256: NEW_HASH, installedSha256: OLD_HASH }],
      2,
      10,
    )).resolves.toEqual([]);

    expect(commands.map((command) => (command as { kind: string }).kind)).toEqual([
      "maintain-log",
      "preclean",
    ]);
  });

  it("removes verified old payloads without pulling a backup for a direct downgrade", async () => {
    const commands: unknown[] = [];
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "missing 0 1";
        if (command.kind === "payload-sizes") return [
          "qdc507-agent=9",
          "qdc507-agent.recovery=missing",
          "qdc507_data11_bridge.ko=missing",
          "qdc507_aprv3.ko=missing",
          "qdc507_voice.ko=missing",
          "mavo-pcm-bridge.armv7=missing",
          "",
        ].join("\n");
        if (command.kind === "remove-payloads") return "64";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };
    const sync = {
      pull: async () => { throw new Error("direct downgrade must not pull an old payload"); },
      push: async () => undefined,
    } satisfies RecoverySync;
    const file = { bytes: new TextEncoder().encode("new-agent"), mode: 0o755 as const, target: "/data/djonehub/bin/qdc507-agent" };
    const replacements = [{ archivePath: "payload/qdc507-agent", file, name: "qdc507-agent" as const, newSha256: NEW_HASH, installedSha256: OLD_HASH }];

    const backups = await reclaimSpaceWithBackups(
      client as never,
      sync,
      "/data/local/tmp/djonehub-webflash-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      replacements,
      1,
      10,
      undefined,
      undefined,
      "direct",
    );

    expect(backups).toEqual([]);
    expect(commands).toEqual([
      { kind: "maintain-log" },
      { kind: "payload-sizes" },
      { kind: "remove-payloads", entries: [{ name: "qdc507-agent", sha256: OLD_HASH }], discardRecovery: true },
    ]);
  });

  it("accepts a framed post-removal space result surrounded by reconnect shell banners", async () => {
    const client = {
      runShell: async (command: { kind: string }) => {
        if (command.kind === "maintain-log") return "missing 0 1";
        if (command.kind === "payload-sizes") return [
          "qdc507-agent=9",
          "qdc507-agent.recovery=missing",
          "qdc507_data11_bridge.ko=missing",
          "qdc507_aprv3.ko=missing",
          "qdc507_voice.ko=missing",
          "mavo-pcm-bridge.armv7=missing",
          "",
        ].join("\n");
        if (command.kind === "remove-payloads") {
          return "shell reconnecting\r\nDJONEHUB_SPACE_RECHECK_BEGIN\r\n64\r\nDJONEHUB_SPACE_RECHECK_END\r\nroot@qdc507:/ # ";
        }
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };
    const file = { bytes: new TextEncoder().encode("new-agent"), mode: 0o755 as const, target: "/data/djonehub/bin/qdc507-agent" };

    await expect(reclaimSpaceWithBackups(
      client as never,
      { pull: async () => { throw new Error("must not pull"); }, push: async () => undefined },
      "/data/local/tmp/djonehub-webflash-55555555555555555555555555555555",
      [{ archivePath: "payload/qdc507-agent", file, name: "qdc507-agent", newSha256: NEW_HASH, installedSha256: OLD_HASH }],
      1,
      10,
      undefined,
      undefined,
      "direct",
    )).resolves.toEqual([]);
  });

  it("reports a space-check failure instead of a USB identity error for a malformed recheck", async () => {
    const client = {
      runShell: async (command: { kind: string }) => {
        if (command.kind === "maintain-log") return "missing 0 1";
        if (command.kind === "payload-sizes") return [
          "qdc507-agent=missing",
          "qdc507-agent.recovery=9",
          "qdc507_data11_bridge.ko=missing",
          "qdc507_aprv3.ko=missing",
          "qdc507_voice.ko=missing",
          "mavo-pcm-bridge.armv7=missing",
          "",
        ].join("\n");
        if (command.kind === "remove-payloads") return "shell closed before df completed";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };

    await expect(reclaimSpaceWithBackups(
      client as never,
      { pull: async () => { throw new Error("must not pull"); }, push: async () => undefined },
      "/data/local/tmp/djonehub-webflash-66666666666666666666666666666666",
      [],
      1,
      10,
      undefined,
      undefined,
      "direct",
    )).rejects.toMatchObject({ code: "SPACE_CHECK_FAILED", message: "模块空间复检结果无效" });
  });

  it("counts and discards the Agent recovery copy during a direct downgrade", async () => {
    const commands: unknown[] = [];
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "missing 0 1";
        if (command.kind === "payload-sizes") return [
          "qdc507-agent=9",
          "qdc507-agent.recovery=9",
          "qdc507_data11_bridge.ko=missing",
          "qdc507_aprv3.ko=missing",
          "qdc507_voice.ko=missing",
          "mavo-pcm-bridge.armv7=missing",
          "",
        ].join("\n");
        if (command.kind === "remove-payloads") return "10";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };
    const file = { bytes: new TextEncoder().encode("new-voice"), mode: 0o644 as const, target: "/data/djonehub/voice-runtime/qdc507_voice.ko" };
    const replacements = [{ archivePath: "payload/qdc507_voice.ko", file, name: "qdc507_voice.ko" as const, newSha256: NEW_HASH, installedSha256: OLD_HASH }];

    await reclaimSpaceWithBackups(
      client as never,
      { pull: async () => { throw new Error("must not pull"); }, push: async () => undefined },
      "/data/local/tmp/djonehub-webflash-22222222222222222222222222222222",
      replacements,
      1,
      10,
      undefined,
      undefined,
      "direct",
    );

    expect(commands).toContainEqual({
      kind: "remove-payloads",
      entries: [{ name: "qdc507_voice.ko", sha256: OLD_HASH }],
      discardRecovery: true,
    });
  });

  it("reclaims only the Agent recovery copy when same-version payloads are missing", async () => {
    const commands: unknown[] = [];
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "missing 0 1";
        if (command.kind === "payload-sizes") return [
          "qdc507-agent=missing",
          "qdc507-agent.recovery=9",
          "qdc507_data11_bridge.ko=missing",
          "qdc507_aprv3.ko=missing",
          "qdc507_voice.ko=missing",
          "mavo-pcm-bridge.armv7=missing",
          "",
        ].join("\n");
        if (command.kind === "remove-payloads") return "10";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };

    await reclaimSpaceWithBackups(
      client as never,
      { pull: async () => { throw new Error("must not pull"); }, push: async () => undefined },
      "/data/local/tmp/djonehub-webflash-33333333333333333333333333333333",
      [],
      1,
      10,
      undefined,
      undefined,
      "direct",
    );

    expect(commands).toContainEqual({ kind: "remove-payloads", entries: [], discardRecovery: true });
  });

  it("uses preclean space before rejecting a recovery with no installed payloads", async () => {
    const commands: unknown[] = [];
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "missing 0 1";
        if (command.kind === "preclean") return "v1 1 10 9";
        if (command.kind === "payload-sizes") return [
          "qdc507-agent=missing",
          "qdc507-agent.recovery=missing",
          "qdc507_data11_bridge.ko=missing",
          "qdc507_aprv3.ko=missing",
          "qdc507_voice.ko=missing",
          "mavo-pcm-bridge.armv7=missing",
          "",
        ].join("\n");
        if (command.kind === "remove-payloads") return "10";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };

    await reclaimSpaceWithBackups(
      client as never,
      { pull: async () => { throw new Error("must not pull"); }, push: async () => undefined },
      "/data/local/tmp/djonehub-webflash-44444444444444444444444444444444",
      [],
      1,
      10,
      undefined,
      undefined,
      "direct",
    );

    expect(commands.map((command) => (command as { kind: string }).kind)).toEqual([
      "maintain-log",
      "payload-sizes",
      "preclean",
      "remove-payloads",
    ]);
  });

  it("still removes the old payload in direct mode when free space is already sufficient", async () => {
    const commands: unknown[] = [];
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "missing 0 100";
        if (command.kind === "payload-sizes") return [
          "qdc507-agent=9",
          "qdc507-agent.recovery=missing",
          "qdc507_data11_bridge.ko=missing",
          "qdc507_aprv3.ko=missing",
          "qdc507_voice.ko=missing",
          "mavo-pcm-bridge.armv7=missing",
          "",
        ].join("\n");
        if (command.kind === "remove-payloads") return "109";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };
    const file = { bytes: new TextEncoder().encode("new-agent"), mode: 0o755 as const, target: "/data/djonehub/bin/qdc507-agent" };
    const replacements = [{ archivePath: "payload/qdc507-agent", file, name: "qdc507-agent" as const, newSha256: NEW_HASH, installedSha256: OLD_HASH }];

    await reclaimSpaceWithBackups(
      client as never,
      { pull: async () => { throw new Error("must not pull"); }, push: async () => undefined },
      "/data/local/tmp/djonehub-webflash-ffffffffffffffffffffffffffffffff",
      replacements,
      100,
      10,
      undefined,
      undefined,
      "direct",
    );

    expect(commands.map((command) => (command as { kind: string }).kind)).toEqual([
      "maintain-log",
      "payload-sizes",
      "remove-payloads",
    ]);
  });

  it("does not delete anything when direct reclaim cannot make enough space", async () => {
    const commands: unknown[] = [];
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "missing 0 1";
        if (command.kind === "payload-sizes") return [
          "qdc507-agent=8",
          "qdc507-agent.recovery=missing",
          "qdc507_data11_bridge.ko=missing",
          "qdc507_aprv3.ko=missing",
          "qdc507_voice.ko=missing",
          "mavo-pcm-bridge.armv7=missing",
          "",
        ].join("\n");
        if (command.kind === "preclean") return "v1 1 1 0";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };
    const file = { bytes: new TextEncoder().encode("new-agent"), mode: 0o755 as const, target: "/data/djonehub/bin/qdc507-agent" };
    const replacements = [{ archivePath: "payload/qdc507-agent", file, name: "qdc507-agent" as const, newSha256: NEW_HASH, installedSha256: OLD_HASH }];

    await expect(reclaimSpaceWithBackups(
      client as never,
      { pull: async () => { throw new Error("must not pull"); }, push: async () => undefined },
      "/data/local/tmp/djonehub-webflash-11111111111111111111111111111111",
      replacements,
      1,
      10,
      undefined,
      undefined,
      "direct",
    )).rejects.toMatchObject({ code: "INSUFFICIENT_SPACE" });
    expect(commands.map((command) => (command as { kind: string }).kind)).toEqual([
      "maintain-log",
      "payload-sizes",
      "preclean",
    ]);
  });

  it("clears a live log over 1 MiB without trying to hash a moving snapshot", async () => {
    const commands: unknown[] = [];
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));
    const client = {
      runShell: async (command: { kind: string }) => {
        commands.push(command);
        if (command.kind === "maintain-log") return "cleared 1048577 2000000";
        throw new Error(`unexpected command: ${command.kind}`);
      },
    };
    const sync = {
      pull: async () => { throw new Error("live log must not be pulled for hashing"); },
      push: async () => undefined,
    } satisfies RecoverySync;

    const backups = await reclaimSpaceWithBackups(
      client as never,
      sync,
      "/data/local/tmp/djonehub-webflash-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      [],
      2_000_000,
      1_000_000,
    );

    expect(backups).toEqual([]);
    expect(commands).toEqual([{ kind: "maintain-log" }]);
    expect(entries).toContain("LOG_MAINTENANCE status=cleared size_kib=1024 available_kib=1953");
    expect(entries).toContain("SPACE_CHECK available_kib=1953 required_kib=976 replacements=0");
    unsubscribe();
  });

  it("keeps a log of exactly 1 MiB when upload space is sufficient", async () => {
    const commands: unknown[] = [];
    const sync = {
      pull: async () => { throw new Error("1 MiB log must not be pulled"); },
      push: async () => undefined,
    } satisfies RecoverySync;

    const backups = await reclaimSpaceWithBackups(
      { runShell: async (command: { kind: string }) => {
        commands.push(command);
        return "kept 1048576 2000000";
      } } as never,
      sync,
      "/data/local/tmp/djonehub-webflash-dddddddddddddddddddddddddddddddd",
      [],
      2_000_000,
      1_000_000,
    );

    expect(backups).toEqual([]);
    expect(commands).toEqual([{ kind: "maintain-log" }]);
  });

  it("restores the host Agent directly without rebuilding a transaction staging tree", async () => {
    const commands: unknown[] = [];
    const pushed: string[] = [];
    const directory = "/data/local/tmp/djonehub-webflash-cccccccccccccccccccccccccccccccc";
    await restoreExternalBackups(
      { runShell: async (command: unknown) => { commands.push(command); return "restored"; } } as never,
      {
        pull: async () => new Uint8Array(),
        push: async (path) => { pushed.push(path); },
      },
      directory,
      [{
        name: "qdc507-agent",
        path: "/data/djonehub/bin/qdc507-agent",
        mode: 0o755,
        sha256: OLD_HASH,
        bytes: new TextEncoder().encode("old-agent"),
      }],
    );

    expect(commands[0]).toEqual({ kind: "prepare-agent-restore", stagingPath: directory });
    expect(pushed).toEqual(["/data/djonehub/bin/qdc507-agent.webflash-restore"]);
    expect(commands).toContainEqual({ kind: "restore-agent", sha256: OLD_HASH });
  });
});
