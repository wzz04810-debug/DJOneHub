import { describe, expect, it } from "vitest";
import { BootstrapReleaseClient } from "../src/bootstrap/release";
import { bootstrapFixture } from "./bootstrap-fixture";

describe("Bootstrap private release client", () => {
  it("loads the pinned artifact only through the same-origin flash endpoint", async () => {
    const { archive, policy } = await bootstrapFixture();
    let request: { input: string | URL | Request; init?: RequestInit } | undefined;
    const client = new BootstrapReleaseClient(async (input, init) => {
      request = init === undefined ? { input } : { input, init };
      return new Response(new Blob([new Uint8Array(archive)]), {
        status: 200,
        headers: {
          "Content-Length": String(archive.byteLength),
          "X-DJOneHub-Bootstrap-SHA256": policy.archiveSha256,
        },
      });
    }, policy);

    await expect(client.fetchPackage()).resolves.toEqual(archive);
    expect(request?.input).toBe("/api/bootstrap-package");
    expect(request?.init).toMatchObject({ method: "POST", headers: { "X-DJOneHub-Flash": "1" } });
  });

  it("rejects a body or server checksum that differs from the pinned release", async () => {
    const { archive, policy } = await bootstrapFixture();
    const wrongHeader = new BootstrapReleaseClient(async () => new Response(new Blob([new Uint8Array(archive)]), {
      headers: { "Content-Length": String(archive.byteLength), "X-DJOneHub-Bootstrap-SHA256": "0".repeat(64) },
    }), policy);
    await expect(wrongHeader.fetchPackage()).rejects.toMatchObject({ code: "PACKAGE_INVALID" });

    const tampered = archive.slice(); tampered[20]! ^= 1;
    const wrongBody = new BootstrapReleaseClient(async () => new Response(new Blob([new Uint8Array(tampered)]), {
      headers: { "Content-Length": String(tampered.byteLength), "X-DJOneHub-Bootstrap-SHA256": policy.archiveSha256 },
    }), policy);
    await expect(wrongBody.fetchPackage()).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
  });

  it("accepts an exact pinned body when Vercel transfer encoding removes Content-Length", async () => {
    const { archive, policy } = await bootstrapFixture();
    const client = new BootstrapReleaseClient(async () => new Response(new Blob([new Uint8Array(archive)]), {
      headers: {
        "Content-Encoding": "br",
        "X-DJOneHub-Bootstrap-SHA256": policy.archiveSha256,
      },
    }), policy);

    await expect(client.fetchPackage()).resolves.toEqual(archive);
  });
});
