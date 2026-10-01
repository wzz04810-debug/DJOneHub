import { describe, expect, it } from "vitest";
import { verifyBootstrapArchive } from "../src/bootstrap/package";
import { bootstrapFixture } from "./bootstrap-fixture";

describe("Bootstrap rootfs package", () => {
  it("accepts only the exact policy-bound files, link, ARMv7 ELF, HTTPS host and public key", async () => {
    const { archive, policy } = await bootstrapFixture();

    const bundle = await verifyBootstrapArchive(archive, policy);

    expect(bundle.version).toBe("0.1.0");
    expect(bundle.files.map((file) => file.remotePath)).toEqual([
      "/etc/djonehub-bootstrap.json",
      "/etc/init.d/djonehub_agent",
      "/etc/init.d/djonehub_bootstrap",
      "/usr/lib/djonehub/qdc507_data11_bridge.ko",
      "/usr/sbin/djonehub-bootstrap",
    ]);
  });

  it("accepts bounded metadata-only PAX headers emitted by the release tar tool", async () => {
    const { archive, policy } = await bootstrapFixture({ paxMetadata: true });

    await expect(verifyBootstrapArchive(archive, policy)).resolves.toMatchObject({ version: "0.1.0" });
  });

  it("rejects a PAX header that attempts to override an allowed entry path", async () => {
    const { archive, policy } = await bootstrapFixture({ unsafePaxPath: true });

    await expect(verifyBootstrapArchive(archive, policy)).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
  });

  it("rejects an archive whose top-level digest is not the pinned release", async () => {
    const { archive, policy } = await bootstrapFixture();
    const tampered = archive.slice();
    tampered[20]! ^= 1;

    await expect(verifyBootstrapArchive(tampered, policy)).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
  });

  it.each([
    ["unknown file", { extraFile: true }],
    ["wrong symlink", { wrongLink: true }],
    ["non-ARM ELF", { badElf: true }],
    ["HTTP manifest", { insecureManifest: true }],
    ["different public key", { wrongPublicKey: true }],
  ] as const)("rejects %s even when the archive digest is supplied by the fixture", async (_name, options) => {
    const { archive, policy } = await bootstrapFixture(options);
    await expect(verifyBootstrapArchive(archive, policy)).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
  });
});
