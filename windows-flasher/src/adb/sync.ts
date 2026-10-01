import type { AdbServiceStream } from "./client";

const MAX_FILE_SIZE = 16 * 1024 * 1024;
const SYNC_DATA_SIZE = 4088;
const PROGRESS_UPDATE_BYTES = 64 * 1024;
const SYNC_FINAL_TIMEOUT_MS = 20_000;
const SYNC_CLOSE_TIMEOUT_MS = 5_000;
const SYNC_READ_TIMEOUT_MS = 90_000;
const STAGING_FILE = /^\/data\/local\/tmp\/djonehub-webflash-[a-f0-9]{32}\/[A-Za-z0-9._/-]+$/;
const AGENT_RESTORE_FILE = "/data/djonehub/bin/qdc507-agent.webflash-restore";
const ROOTFS_FILES = new Set([
  "/etc/djonehub-bootstrap.json",
  "/etc/init.d/djonehub_agent",
  "/etc/init.d/djonehub_bootstrap",
  "/usr/lib/djonehub/qdc507_data11_bridge.ko",
  "/usr/sbin/djonehub-bootstrap",
]);
const INSTALLED_FILES = new Set([
  "/data/djonehub/bin/qdc507-agent",
  "/data/djonehub/kernel/qdc507_data11_bridge.ko",
  "/data/djonehub/voice-runtime/qdc507_aprv3.ko",
  "/data/djonehub/voice-runtime/qdc507_voice.ko",
  "/data/djonehub/voice-runtime/mavo-pcm-bridge.armv7",
  "/data/djonehub/log/agent.log",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type StagingPath = string & { readonly __stagingPath: unique symbol };
export type AgentRestorePath = string & { readonly __agentRestorePath: unique symbol };
export type RootfsWritePath = string & { readonly __rootfsWritePath: unique symbol };
export type WritablePath = StagingPath | AgentRestorePath | RootfsWritePath;
export type InstalledPath = string & { readonly __installedPath: unique symbol };
export type RootfsPath = string & { readonly __rootfsPath: unique symbol };
export type ReadablePath = InstalledPath | RootfsPath;
export type AllowedMode = 0o600 | 0o644 | 0o755;

export interface SyncClient {
  openSync(signal?: AbortSignal): Promise<AdbServiceStream>;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Operation aborted", "AbortError");
  }
}

export function stagingPath(value: string): StagingPath {
  if (
    !STAGING_FILE.test(value) ||
    value.includes("..") ||
    value.includes(",") ||
    value.includes("\0") ||
    value.includes("//")
  ) {
    throw new Error("STAGING_PATH_INVALID");
  }
  return value as StagingPath;
}

export function agentRestorePath(): AgentRestorePath {
  return AGENT_RESTORE_FILE as AgentRestorePath;
}

export function rootfsPath(value: string): RootfsPath {
  if (!ROOTFS_FILES.has(value)) throw new Error("ROOTFS_PATH_INVALID");
  return value as RootfsPath;
}

export function rootfsWritePath(value: string, suffix: "next" | "restore"): RootfsWritePath {
  if (!ROOTFS_FILES.has(value) || !value.startsWith("/")) throw new Error("ROOTFS_PATH_INVALID");
  return `${value}.webflash-${suffix}` as RootfsWritePath;
}

export function installedPath(value: string): InstalledPath {
  if (!INSTALLED_FILES.has(value)) throw new Error("INSTALLED_PATH_INVALID");
  return value as InstalledPath;
}

function syncPacket(id: string, payload: Uint8Array): Uint8Array {
  const packet = new Uint8Array(8 + payload.byteLength);
  packet.set(encoder.encode(id), 0);
  new DataView(packet.buffer).setUint32(4, payload.byteLength, true);
  packet.set(payload, 8);
  return packet;
}

function donePacket(timestamp: number): Uint8Array {
  const packet = new Uint8Array(8);
  packet.set(encoder.encode("DONE"), 0);
  new DataView(packet.buffer).setUint32(4, timestamp >>> 0, true);
  return packet;
}

class StreamReader {
  private buffered = new Uint8Array();

  async exact(
    stream: AdbServiceStream,
    length: number,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Uint8Array> {
    while (this.buffered.byteLength < length) {
      aborted(signal);
      const chunk = await stream.read(signal, timeoutMs);
      if (chunk === null) {
        throw new Error("ADB_SYNC_RESPONSE_TRUNCATED");
      }
      const combined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
      combined.set(this.buffered);
      combined.set(chunk, this.buffered.byteLength);
      this.buffered = combined;
    }
    const result = this.buffered.slice(0, length);
    this.buffered = this.buffered.slice(length);
    return result;
  }
}

export class AdbSync {
  private readonly client: SyncClient;

  constructor(client: SyncClient) {
    this.client = client;
  }

  async push(
    path: WritablePath,
    bytes: Uint8Array,
    mode: AllowedMode,
    onProgress?: (sent: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (bytes.byteLength > MAX_FILE_SIZE) {
      throw new Error("ADB_SYNC_FILE_TOO_LARGE");
    }
    aborted(signal);
    const stream = await this.client.openSync(signal);
    try {
      const destination = encoder.encode(`${path},${mode}`);
      await stream.write(syncPacket("SEND", destination), signal);
      let lastReported = 0;
      for (let offset = 0; offset < bytes.byteLength; offset += SYNC_DATA_SIZE) {
        aborted(signal);
        const chunk = bytes.subarray(offset, offset + SYNC_DATA_SIZE);
        await stream.write(syncPacket("DATA", chunk), signal);
        const sent = Math.min(offset + chunk.byteLength, bytes.byteLength);
        if (sent === bytes.byteLength || sent - lastReported >= PROGRESS_UPDATE_BYTES) {
          onProgress?.(sent, bytes.byteLength);
          lastReported = sent;
        }
      }
      await stream.write(donePacket(Math.floor(Date.now() / 1000)), signal);
      const reader = new StreamReader();
      const status = await reader.exact(stream, 8, signal, SYNC_FINAL_TIMEOUT_MS);
      const id = decoder.decode(status.subarray(0, 4));
      const value = new DataView(status.buffer, status.byteOffset + 4, 4).getUint32(0, true);
      if (id === "OKAY" && value === 0) {
        return;
      }
      if (id === "FAIL") {
        const message = decoder.decode(await reader.exact(stream, value, signal, SYNC_FINAL_TIMEOUT_MS));
        throw new Error(`ADB_SYNC_FAILED: ${message}`);
      }
      throw new Error("ADB_SYNC_RESPONSE_UNEXPECTED");
    } finally {
      await stream.close(signal, SYNC_CLOSE_TIMEOUT_MS);
    }
  }

  async pull(
    path: ReadablePath,
    onProgress?: (received: number) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    aborted(signal);
    const stream = await this.client.openSync(signal);
    try {
      await stream.write(syncPacket("RECV", encoder.encode(path)), signal);
      const reader = new StreamReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const id = decoder.decode(await reader.exact(stream, 4, signal, SYNC_READ_TIMEOUT_MS));
        const lengthBytes = await reader.exact(stream, 4, signal, SYNC_READ_TIMEOUT_MS);
        const length = new DataView(
          lengthBytes.buffer,
          lengthBytes.byteOffset,
          4,
        ).getUint32(0, true);
        if (id === "DONE") break;
        if (id === "FAIL") {
          throw new Error(`ADB_SYNC_FAILED: ${decoder.decode(await reader.exact(stream, length, signal, SYNC_READ_TIMEOUT_MS))}`);
        }
        if (id !== "DATA" || length > MAX_FILE_SIZE || received + length > MAX_FILE_SIZE) {
          throw new Error("ADB_SYNC_RESPONSE_UNEXPECTED");
        }
        chunks.push(await reader.exact(stream, length, signal, SYNC_READ_TIMEOUT_MS));
        received += length;
        onProgress?.(received);
      }
      const result = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    } finally {
      await stream.close(signal, SYNC_CLOSE_TIMEOUT_MS);
    }
  }
}
