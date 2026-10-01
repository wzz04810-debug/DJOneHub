import { describe, expect, it } from "vitest";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import { ReleaseClient, STABLE_CHANNEL_URL } from "../src/release/client";

const encoder = new TextEncoder();
const secret = new Uint8Array(32).fill(9);
const publicKey = await getPublicKeyAsync(secret);

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", owned)), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function fixture(assetUrl: string, packageBytes = new Uint8Array(12_000)): Promise<Map<string, Response>> {
  const channel = encoder.encode(JSON.stringify({
    asset_url: assetUrl, channel: "stable", format_version: 1,
    platform: "qdc507-armv7-linux-3.18.44", published_at: "2026-08-18T00:00:00Z",
    sha256: await sha256(packageBytes), size: packageBytes.byteLength, version: "0.3.5",
  }));
  const signature = await signAsync(channel, secret);
  return new Map([
    [STABLE_CHANNEL_URL, new Response(channel, { headers: { "Content-Length": String(channel.byteLength) } })],
    [`${STABLE_CHANNEL_URL}.sig`, new Response(signature)],
    [assetUrl, new Response(packageBytes, { headers: { "Content-Length": String(packageBytes.byteLength) } })],
  ]);
}

function fakeFetch(responses: Map<string, Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const response = responses.get(url);
    if (!response) return new Response("missing", { status: 404 });
    return response.clone();
  }) as typeof fetch;
}

describe("release client", () => {
  it("accepts only the compiled release hosts", async () => {
    const responses = await fixture("https://evil.example/pkg.djwebflash");
    const client = new ReleaseClient(fakeFetch(responses), publicKey);
    await expect(client.fetchStableChannel()).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
  });

  it("reports streamed download progress", async () => {
    const asset = "https://github.com/wzz04810-debug/DJOneHub-iPad/releases/download/v0.3.5/package.djwebflash";
    const responses = await fixture(asset);
    const values: number[] = [];
    const client = new ReleaseClient(fakeFetch(responses), publicKey);
    const channel = await client.fetchStableChannel();
    await client.fetchPackage(channel, (progress) => values.push(progress.received));
    expect(values.at(-1)).toBe(12_000);
  });
});
