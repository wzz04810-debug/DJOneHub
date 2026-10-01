import { describe, expect, it } from "vitest";
import type { AdbServiceStream } from "../src/adb/client";
import { AdbSync, installedPath, stagingPath } from "../src/adb/sync";

class FakeStream implements AdbServiceStream {
  readonly writes: Uint8Array[] = [];
  readonly readTimeouts: (number | undefined)[] = [];
  readonly closeTimeouts: (number | undefined)[] = [];
  closed = false;
  private readonly reads: (Uint8Array | null)[];

  constructor(reads: (Uint8Array | null)[] = [syncStatus("OKAY", 0)]) {
    this.reads = reads;
  }

  async write(payload: Uint8Array): Promise<void> {
    this.writes.push(payload.slice());
  }

  async read(_signal?: AbortSignal, timeoutMs?: number): Promise<Uint8Array | null> {
    this.readTimeouts.push(timeoutMs);
    return this.reads.shift() ?? null;
  }

  async close(_signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    this.closeTimeouts.push(timeoutMs);
    this.closed = true;
  }

  dataChunkSizes(): number[] {
    return this.writes
      .filter((packet) => text(packet.subarray(0, 4)) === "DATA")
      .map((packet) => new DataView(packet.buffer, packet.byteOffset + 4, 4).getUint32(0, true));
  }
}

class FakeSyncClient {
  readonly stream: FakeStream;

  constructor(stream = new FakeStream()) {
    this.stream = stream;
  }

  async openSync(): Promise<AdbServiceStream> {
    return this.stream;
  }
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function syncStatus(id: "OKAY" | "FAIL", value: number, detail: Uint8Array<ArrayBufferLike> = new Uint8Array()): Uint8Array {
  const packet = new Uint8Array(8 + detail.byteLength);
  packet.set(ascii(id), 0);
  new DataView(packet.buffer).setUint32(4, value, true);
  packet.set(detail, 8);
  return packet;
}

describe("ADB Sync Push", () => {
  it("uploads in 4088-byte DATA chunks and reports progress", async () => {
    const client = new FakeSyncClient();
    const progress: number[] = [];
    await new AdbSync(client).push(
      stagingPath(
        "/data/local/tmp/djonehub-webflash-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/payload/qdc507-agent",
      ),
      new Uint8Array(9000),
      0o755,
      (value) => progress.push(value),
    );
    expect(client.stream.dataChunkSizes()).toEqual([4088, 4088, 824]);
    expect(progress.at(-1)).toBe(9000);
    expect(client.stream.closed).toBe(true);
    expect(client.stream.readTimeouts).toContain(20_000);
    expect(client.stream.closeTimeouts).toEqual([5_000]);
  });

  it("coalesces progress updates during a large upload and still reports the exact final size", async () => {
    const client = new FakeSyncClient();
    const progress: number[] = [];

    await new AdbSync(client).push(
      stagingPath(
        "/data/local/tmp/djonehub-webflash-cccccccccccccccccccccccccccccccc/payload/qdc507-agent",
      ),
      new Uint8Array(130_000),
      0o755,
      (value) => progress.push(value),
    );

    expect(progress.at(-1)).toBe(130_000);
    expect(progress.length).toBeLessThanOrEqual(2);
  });

  it("rejects paths outside the random staging directory", () => {
    expect(() => stagingPath("/data/djonehub/bin/qdc507-agent")).toThrow(
      "STAGING_PATH_INVALID",
    );
  });

  it("surfaces remote FAIL text", async () => {
    const message = ascii("permission denied");
    const packet = syncStatus("FAIL", message.length, message);
    const client = new FakeSyncClient(new FakeStream([packet]));
    await expect(
      new AdbSync(client).push(
        stagingPath(
          "/data/local/tmp/djonehub-webflash-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/payload/qdc507-agent",
        ),
        new Uint8Array([1]),
        0o755,
        () => undefined,
      ),
    ).rejects.toThrow("permission denied");
  });

  it("rejects a non-zero ADB Sync OKAY value", async () => {
    const client = new FakeSyncClient(new FakeStream([syncStatus("OKAY", 1)]));

    await expect(new AdbSync(client).push(
      stagingPath("/data/local/tmp/djonehub-webflash-dddddddddddddddddddddddddddddddd/payload/qdc507-agent"),
      new Uint8Array([1]),
      0o755,
    )).rejects.toThrow("ADB_SYNC_RESPONSE_UNEXPECTED");
  });

  it("pulls only whitelisted installed payloads for rollback backup", async () => {
    const body = ascii("old-agent");
    const response = new Uint8Array(8 + body.length + 8);
    response.set(ascii("DATA"), 0);
    new DataView(response.buffer).setUint32(4, body.length, true);
    response.set(body, 8);
    response.set(ascii("DONE"), 8 + body.length);
    const client = new FakeSyncClient(new FakeStream([response]));

    await expect(new AdbSync(client).pull(
      installedPath("/data/djonehub/bin/qdc507-agent"),
    )).resolves.toEqual(body);
    expect(text(client.stream.writes[0]!.subarray(0, 4))).toBe("RECV");
    expect(() => installedPath("/data/djonehub/log/agent.log")).not.toThrow();
    expect(() => installedPath("/data/vendor/private")).toThrow("INSTALLED_PATH_INVALID");
  });
});
