import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdbClient, buildFixedShellCommand, type AdbPacketIO } from "../src/adb/client";
import {
  adbCommand,
  ascii,
  decodeAdbHeader,
  encodeAdbMessage,
} from "../src/adb/codec";

class ScriptedIO implements AdbPacketIO {
  readonly writes: Uint8Array[] = [];
  readonly readTimeouts: (number | undefined)[] = [];
  private readonly reads: number[];

  constructor(packets: Uint8Array[]) {
    this.reads = Array.from(concat(packets));
  }

  async write(packet: Uint8Array): Promise<void> {
    this.writes.push(packet.slice());
  }

  async readExact(length: number, _signal?: AbortSignal, timeoutMs?: number): Promise<Uint8Array> {
    this.readTimeouts.push(timeoutMs);
    if (this.reads.length < length) {
      throw new Error("test stream exhausted");
    }
    return new Uint8Array(this.reads.splice(0, length));
  }

  writtenCommands(): string[] {
    return this.writes.map((packet) => {
      const command = decodeAdbHeader(packet.subarray(0, 24)).command;
      return String.fromCharCode(
        command & 0xff,
        (command >>> 8) & 0xff,
        (command >>> 16) & 0xff,
        (command >>> 24) & 0xff,
      );
    });
  }

  writtenHeaders() {
    return this.writes.map((packet) => decodeAdbHeader(packet.subarray(0, 24)));
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function packet(
  command: "CNXN" | "AUTH" | "OKAY" | "WRTE" | "CLSE",
  arg0: number,
  arg1: number,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): Uint8Array {
  return encodeAdbMessage({ command: adbCommand(command), arg0, arg1, payload });
}

describe("ADB client", () => {
  it("keeps every Bootstrap shell service request within the negotiated 4096-byte ADB payload", () => {
    const hash = "a".repeat(64);
    const commands = [
      buildFixedShellCommand({ kind: "bootstrap-inspect" }),
      buildFixedShellCommand({ kind: "bootstrap-call-agent" }),
      buildFixedShellCommand({ kind: "bootstrap-call-qmi" }),
      buildFixedShellCommand({ kind: "bootstrap-prepare-write" }),
      buildFixedShellCommand({ kind: "bootstrap-prepare-rollback" }),
      buildFixedShellCommand({ kind: "bootstrap-remove-target", name: "djonehub-bootstrap" }),
      buildFixedShellCommand({ kind: "bootstrap-commit-target", name: "djonehub-bootstrap", sha256: hash }),
      buildFixedShellCommand({ kind: "bootstrap-restore-target", name: "djonehub-bootstrap", sha256: hash }),
      buildFixedShellCommand({ kind: "bootstrap-finalize", restoreAgent: true }),
      buildFixedShellCommand({ kind: "bootstrap-finalize-rollback", linkTarget: "../init.d/djonehub_bootstrap", restoreAgent: true }),
      buildFixedShellCommand({ kind: "bootstrap-verify" }),
    ];

    expect(Math.max(...commands.map((command) => new TextEncoder().encode(`shell:${command}\0`).byteLength))).toBeLessThanOrEqual(4096);
  });

  it("frames preflight output so reconnect shell banners cannot corrupt fields", () => {
    const command = buildFixedShellCommand({ kind: "preflight" });

    expect(command).toContain("printf 'DJONEHUB_PREFLIGHT_BEGIN\\n'");
    expect(command).toContain("printf 'DJONEHUB_PREFLIGHT_END\\n'");
  });

  it("reclaims and directly restores the verified Agent recovery hard link", () => {
    const hash = "a".repeat(64);
    const stagingPath = "/data/local/tmp/djonehub-webflash-" + "b".repeat(32);

    const remove = buildFixedShellCommand({
      kind: "remove-payloads",
      entries: [{ name: "qdc507-agent", sha256: hash }],
    });
    expect(remove).toContain("qdc507-agent.recovery");
    expect(remove).toContain(`sha256sum /data/djonehub/bin/qdc507-agent.recovery`);
    expect(remove).toContain(`= ${hash}`);
    expect(remove).toContain("rm -f /data/djonehub/bin/qdc507-agent.recovery");

    const prepare = buildFixedShellCommand({ kind: "prepare-agent-restore", stagingPath });
    const restore = buildFixedShellCommand({ kind: "restore-agent", sha256: hash });
    expect(prepare).toContain("qdc507-agent.webflash-restore");
    expect(restore).toContain("mv $restore $target");
    expect(restore).toContain("ln $target /data/djonehub/bin/qdc507-agent.recovery");
    expect(restore).not.toContain("/etc/init.d/djonehub_agent start");
  });

  it("reports fixed payload sizes before a no-backup reclaim", () => {
    const command = buildFixedShellCommand({ kind: "payload-sizes" } as never);

    expect(command).toContain("qdc507-agent=%s\\n");
    expect(command).toContain("qdc507-agent.recovery=%s\\n");
    expect(command).toContain("qdc507_voice.ko=%s\\n");
    expect(command).toContain("wc -c < /data/djonehub/bin/qdc507-agent");
    expect(command).toContain("size=missing");
  });

  it("discards the Agent recovery copy even when the Agent itself is not replaced", () => {
    const command = buildFixedShellCommand({
      kind: "remove-payloads",
      entries: [{ name: "qdc507_voice.ko", sha256: "a".repeat(64) }],
      discardRecovery: true,
    });

    expect(command).toContain("rm -f /data/djonehub/bin/qdc507-agent.recovery");
  });

  it("supports an authorized recovery-only reclaim", () => {
    const command = buildFixedShellCommand({
      kind: "remove-payloads",
      entries: [],
      discardRecovery: true,
    });

    expect(command).toContain("rm -f /data/djonehub/bin/qdc507-agent.recovery");
    expect(command).toContain("df -Pk /data");
  });

  it("frames the post-removal space result so shell banners cannot corrupt it", () => {
    const command = buildFixedShellCommand({
      kind: "remove-payloads",
      entries: [],
      discardRecovery: true,
    });

    expect(command).toContain("printf 'DJONEHUB_SPACE_RECHECK_BEGIN\\n'");
    expect(command).toContain("printf 'DJONEHUB_SPACE_RECHECK_END\\n'");
  });

  it("builds a syntactically valid direct-downgrade removal command", () => {
    const command = buildFixedShellCommand({
      kind: "remove-payloads",
      entries: [{ name: "qdc507-agent", sha256: "a".repeat(64) }],
      discardRecovery: true,
    });

    expect(() => execFileSync("/bin/sh", ["-n"], { input: command, encoding: "utf8" })).not.toThrow();
  });

  it("precleans only the fixed disposable updater and diagnostic paths", () => {
    const fixture = mkdtempSync(join(tmpdir(), "djonehub-preclean-"));
    try {
      const root = join(fixture, "djonehub");
      const temporary = join(fixture, "tmp");
      for (const directory of [
        join(root, "log"), join(root, "bin"), join(root, "backup/app-update-stale"),
        join(root, "backup/app-update-pending"), join(root, "backup/mac-flash-stale"),
        join(root, ".update-stage-stale"), join(root, ".mac-flash-stage-stale"),
        join(root, "config"), temporary,
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      for (const name of ["voice-route.log", "voice-route.log.1", "agent.log", "startup.log"]) writeFileSync(join(root, "log", name), "log");
      for (const name of ["qdc507-agent.failed", "qdc507-agent.next"]) writeFileSync(join(root, "bin", name), "stale");
      writeFileSync(join(root, "bin/qdc507-agent"), "current-agent");
      writeFileSync(join(root, "config/settings.json"), "business-data");
      writeFileSync(join(root, "update-pending"), `${join(root, "backup/app-update-pending")}\n`);
      writeFileSync(join(temporary, "djonehub-update-stale.tar.gz"), "stale");
      mkdirSync(join(temporary, "djonehub-webflash-stale"));
      writeFileSync(join(temporary, "djonehub-webflash-stale/payload"), "stale");

      const command = buildFixedShellCommand({ kind: "preclean" })
        .replaceAll("df -Pk /data", `df -Pk ${fixture}`)
        .replaceAll("/data/djonehub", root)
        .replaceAll("/data/local/tmp", temporary);
      const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }).trim();

      expect(output).toMatch(/^v1 \d+ \d+ \d+$/);
      expect(existsSync(join(root, "log/voice-route.log"))).toBe(false);
      expect(existsSync(join(root, "bin/qdc507-agent.failed"))).toBe(false);
      expect(existsSync(join(root, "backup/app-update-stale"))).toBe(false);
      expect(existsSync(join(root, "backup/app-update-pending"))).toBe(true);
      expect(existsSync(join(root, "backup/mac-flash-stale"))).toBe(false);
      expect(existsSync(join(root, ".update-stage-stale"))).toBe(false);
      expect(existsSync(join(root, ".mac-flash-stage-stale"))).toBe(false);
      expect(existsSync(join(temporary, "djonehub-update-stale.tar.gz"))).toBe(false);
      expect(existsSync(join(temporary, "djonehub-webflash-stale"))).toBe(false);
      expect(existsSync(join(root, "bin/qdc507-agent"))).toBe(true);
      expect(existsSync(join(root, "config/settings.json"))).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("atomically truncates only an oversized fixed Agent log", () => {
    const command = buildFixedShellCommand({ kind: "maintain-log" });

    expect(command).toContain("/data/djonehub/log/agent.log");
    expect(command).toContain('test "$size" -gt 1048576');
    expect(command).toContain(': > /data/djonehub/log/agent.log');
    expect(command).toContain("printf 'cleared %s %s\\n'");
    expect(command).toContain("printf 'kept %s %s\\n'");
  });

  it("refuses authenticated ADB instead of bypassing it", async () => {
    const io = new ScriptedIO([packet("AUTH", 1, 0, new Uint8Array(20))]);
    await expect(new AdbClient(io).connect()).rejects.toMatchObject({
      code: "ADB_AUTH_REQUIRED",
    });
  });

  it("cleans stale ADB streams and retries CNXN before accepting the module", async () => {
    const io = new ScriptedIO([
      packet("WRTE", 41, 7, ascii("stale")),
      packet("OKAY", 42, 8),
      packet("CLSE", 43, 9),
      packet("CNXN", 0x01000001, 4096, ascii("device::\0")),
    ]);

    await expect(new AdbClient(io).connect()).resolves.toBeUndefined();

    expect(io.writtenCommands()).toEqual(["CNXN", "CLSE", "CNXN", "CLSE", "CNXN", "CLSE", "CNXN"]);
    expect(io.writtenHeaders()[0]!.arg0).toBe(0x01000001);
  });

  it("stops after cleaning 64 stale ADB streams", async () => {
    const stale = Array.from({ length: 65 }, (_, index) => packet("CLSE", 100 + index, 200 + index));
    const io = new ScriptedIO(stale);

    await expect(new AdbClient(io).connect()).rejects.toThrow("ADB_STALE_STREAM_LIMIT");
    expect(io.writtenCommands().filter((command) => command === "CLSE")).toHaveLength(64);
  });

  it("uses stage-specific deadlines for shell and stream acknowledgements", async () => {
    const io = new ScriptedIO([
      packet("CNXN", 0x01000001, 4096, ascii("device::\0")),
      packet("OKAY", 7, 1),
      packet("WRTE", 7, 1, ascii("armv7l\n")),
      packet("CLSE", 7, 1),
      packet("OKAY", 8, 2),
      packet("OKAY", 8, 2),
      packet("CLSE", 8, 2),
    ]);
    const client = new AdbClient(io);
    await client.connect();
    await client.runShell({ kind: "identity" });
    const stream = await client.openSync();
    await stream.write(ascii("DATA"));
    await stream.close();

    expect(io.readTimeouts).toContain(8_000);
    expect(io.readTimeouts).toContain(10_000);
    expect(io.readTimeouts).toContain(5_000);
  });

  it("acks WRTE and returns fixed shell output", async () => {
    const io = new ScriptedIO([
      packet("CNXN", 0x01000000, 4096, ascii("device::\0")),
      packet("OKAY", 7, 1),
      packet("WRTE", 7, 1, ascii("armv7l\n")),
      packet("CLSE", 7, 1),
    ]);
    const client = new AdbClient(io);
    await client.connect();
    await expect(client.runShell({ kind: "identity" })).resolves.toBe("armv7l\n");
    expect(io.writtenCommands()).toContain("OKAY");
  });

  it("ignores a delayed close reply from the previous service stream", async () => {
    const io = new ScriptedIO([
      packet("CNXN", 0x01000000, 4096, ascii("device::\0")),
      packet("OKAY", 7, 1),
      packet("CLSE", 7, 1),
      packet("OKAY", 8, 2),
      packet("WRTE", 8, 2, ascii("armv7l\n")),
      packet("CLSE", 8, 2),
    ]);
    const client = new AdbClient(io);
    await client.connect();
    const previous = await client.openSync();
    await previous.close();

    await expect(client.runShell({ kind: "identity" })).resolves.toBe("armv7l\n");
  });

  it("rejects unknown packets in a shell stream", async () => {
    const io = new ScriptedIO([
      packet("CNXN", 0x01000000, 4096),
      packet("OKAY", 7, 1),
      packet("AUTH", 1, 0),
    ]);
    const client = new AdbClient(io);
    await client.connect();
    await expect(client.runShell({ kind: "identity" })).rejects.toThrow(
      "ADB_STREAM_PACKET_UNEXPECTED",
    );
  });
});
