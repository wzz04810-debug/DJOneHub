import { describe, expect, it } from "vitest";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import { gzipSync, zipSync } from "fflate";
import {
  verifyChannel,
  verifyDjupdateArchive,
  verifyWebflashArchive,
} from "../src/release/verifier";

const encoder = new TextEncoder();
const TEST_SECRET_KEY = new Uint8Array(32).fill(7);
const TEST_PUBLIC_KEY = await getPublicKeyAsync(TEST_SECRET_KEY);

async function digest(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", owned)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function fixture(
  version = "0.3.5",
  options: { badHash?: boolean; extraEntry?: boolean; badSignature?: boolean } = {},
): Promise<Uint8Array> {
  const agent = encoder.encode("agent-binary");
  const manifest = {
    files: [{
      archive_path: "payload/qdc507-agent",
      mode: 493,
      name: "qdc507-agent",
      sha256: options.badHash ? "0".repeat(64) : await digest(agent),
      size: agent.byteLength,
      target: "/data/djonehub/bin/qdc507-agent",
    }],
    format_version: 1,
    platform: "qdc507-armv7-linux-3.18.44",
    version,
  };
  const manifestBytes = encoder.encode(`${JSON.stringify(manifest)}\n`);
  const signature = await signAsync(manifestBytes, TEST_SECRET_KEY);
  if (options.badSignature) signature[0]! ^= 0xff;
  const entries: Record<string, Uint8Array> = {
    "manifest.json": manifestBytes,
    "manifest.sig": signature,
    "payload/qdc507-agent": agent,
  };
  if (options.extraEntry) entries["payload/evil"] = encoder.encode("evil");
  return zipSync(entries, { level: 0 });
}

function tar(entries: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, payload] of Object.entries(entries)) {
    const header = new Uint8Array(512);
    header.set(encoder.encode(name), 0);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    header.set(encoder.encode(payload.byteLength.toString(8).padStart(11, "0") + "\0"), 124);
    header.set(encoder.encode("00000000000\0"), 136);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(header, payload);
    const padding = (512 - payload.byteLength % 512) % 512;
    if (padding) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) { output.set(block, offset); offset += block.byteLength; }
  return output;
}

async function otaFixture(options: { badSignature?: boolean; extraEntry?: boolean } = {}): Promise<Uint8Array> {
  const payloads: Record<string, Uint8Array> = {
    "qdc507-agent": encoder.encode("agent"),
    "qdc507_data11_bridge.ko": encoder.encode("data11"),
    "qdc507_aprv3.ko": encoder.encode("aprv3"),
    "qdc507_voice.ko": encoder.encode("voice"),
    "mavo-pcm-bridge.armv7": encoder.encode("pcm"),
  };
  const targets: Record<string, string> = {
    "qdc507-agent": "bin/qdc507-agent",
    "qdc507_data11_bridge.ko": "kernel/qdc507_data11_bridge.ko",
    "qdc507_aprv3.ko": "voice-runtime/qdc507_aprv3.ko",
    "qdc507_voice.ko": "voice-runtime/qdc507_voice.ko",
    "mavo-pcm-bridge.armv7": "voice-runtime/mavo-pcm-bridge.armv7",
  };
  const manifest = {
    files: await Promise.all(Object.entries(payloads).map(async ([name, bytes]) => ({
      mode: name === "qdc507-agent" || name.endsWith("armv7") ? 493 : 420,
      name, sha256: await digest(bytes), size: bytes.byteLength, target: targets[name],
    }))),
    format_version: 1, platform: "qdc507-armv7-linux-3.18.44", version: "0.3.5",
  };
  const manifestBytes = encoder.encode(`${JSON.stringify(manifest)}\n`);
  const signature = await signAsync(manifestBytes, TEST_SECRET_KEY);
  if (options.badSignature) signature[0]! ^= 0xff;
  const entries: Record<string, Uint8Array> = {
    "manifest.json": manifestBytes,
    "manifest.sig": signature,
    ...Object.fromEntries(Object.entries(payloads).map(([name, bytes]) => [`payload/${name}`, bytes])),
  };
  if (options.extraEntry) entries["payload/evil"] = encoder.encode("evil");
  return gzipSync(tar(entries), { mtime: 0 });
}

describe("signed release verification", () => {
  it("accepts a valid fixture signed by the injected test key", async () => {
    const verified = await verifyWebflashArchive(
      await fixture(), undefined, undefined, TEST_PUBLIC_KEY,
    );
    expect(verified.manifest.platform).toBe("qdc507-armv7-linux-3.18.44");
    expect(verified.files.get("payload/qdc507-agent")?.mode).toBe(0o755);
  });

  it("rejects signature, unknown entry, hash, and downgrade failures", async () => {
    await expect(verifyWebflashArchive(await fixture("0.3.5", { badSignature: true }), undefined, undefined, TEST_PUBLIC_KEY))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    await expect(verifyWebflashArchive(await fixture("0.3.5", { extraEntry: true }), undefined, undefined, TEST_PUBLIC_KEY))
      .rejects.toMatchObject({ code: "PACKAGE_INVALID" });
    await expect(verifyWebflashArchive(await fixture("0.3.5", { badHash: true }), undefined, undefined, TEST_PUBLIC_KEY))
      .rejects.toMatchObject({ code: "PACKAGE_INVALID" });
    await expect(verifyWebflashArchive(await fixture("0.3.4"), "0.3.5", undefined, TEST_PUBLIC_KEY))
      .rejects.toMatchObject({ code: "DOWNGRADE_BLOCKED", message: "已安装 0.3.5，目标版本 0.3.4" });
    await expect(verifyWebflashArchive(await fixture("0.3.4"), "0.3.5", { allowDowngrade: true }, TEST_PUBLIC_KEY))
      .resolves.toMatchObject({ manifest: { version: "0.3.4" } });
  });

  it("verifies a strict signed stable channel", async () => {
    const bytes = encoder.encode(JSON.stringify({
      asset_url: "https://example.test/v.djwebflash",
      channel: "stable",
      format_version: 1,
      platform: "qdc507-armv7-linux-3.18.44",
      published_at: "2026-08-18T00:00:00Z",
      sha256: "a".repeat(64),
      size: 42,
      version: "0.3.5",
    }));
    const signature = await signAsync(bytes, TEST_SECRET_KEY);
    await expect(verifyChannel(bytes, signature, TEST_PUBLIC_KEY)).resolves.toMatchObject({ version: "0.3.5" });
    const unknown = encoder.encode(new TextDecoder().decode(bytes) + " ");
    await expect(verifyChannel(unknown, signature, TEST_PUBLIC_KEY)).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("accepts the existing signed djupdate format for first provisioning", async () => {
    const verified = await verifyDjupdateArchive(await otaFixture(), undefined, undefined, TEST_PUBLIC_KEY);
    expect(verified.manifest.version).toBe("0.3.5");
    expect(verified.files.get("payload/qdc507-agent")?.bytes).toEqual(encoder.encode("agent"));
    expect(verified.files.size).toBe(5);
  });

  it("rejects a djupdate with a bad signature or unknown tar entry", async () => {
    await expect(verifyDjupdateArchive(await otaFixture({ badSignature: true }), undefined, undefined, TEST_PUBLIC_KEY))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    await expect(verifyDjupdateArchive(await otaFixture({ extraEntry: true }), undefined, undefined, TEST_PUBLIC_KEY))
      .rejects.toMatchObject({ code: "PACKAGE_INVALID" });
  });
});
