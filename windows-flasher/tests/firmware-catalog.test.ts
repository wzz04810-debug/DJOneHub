import { describe, expect, it } from "vitest";
import { buildCatalog, releaseFromBlob, type BlobListItem } from "../src/firmware/catalog";

function blob(pathname: string, uploadedAt = "2026-08-30T08:00:00.000Z"): BlobListItem {
  const url = `https://store.public.blob.vercel-storage.com/${pathname}`;
  return { pathname, size: 12_345, uploadedAt, url, downloadUrl: `${url}?download=1` };
}

describe("firmware catalog", () => {
  it("extracts a version and TestFlight build from the immutable blob path", () => {
    expect(releaseFromBlob(blob("firmware/0.3.5/testflight-42/qdc507-0.3.5.djwebflash"))).toMatchObject({
      id: "firmware/0.3.5/testflight-42/qdc507-0.3.5.djwebflash", version: "0.3.5", testflightBuild: "42", filename: "qdc507-0.3.5.djwebflash",
    });
  });

  it("ignores unrelated and malformed blobs", () => {
    expect(releaseFromBlob(blob("firmware/latest/package.zip"))).toBeUndefined();
    expect(releaseFromBlob(blob("firmware/0.3.5/testflight-42/package.html"))).toBeUndefined();
  });

  it("adds verified checksums and sorts newest TestFlight builds first", () => {
    const older = blob("firmware/0.3.4/testflight-40/old.djupdate", "2026-08-20T08:00:00.000Z");
    const newer = blob("firmware/0.3.5/testflight-42/new.djwebflash");
    const checksums = new Map([[`${newer.pathname}.sha256`, "a".repeat(64)]]);
    const releases = buildCatalog([older, newer], checksums);
    expect(releases.map((release) => release.version)).toEqual(["0.3.5", "0.3.4"]);
    expect(releases.map((release) => release.testflightBuild)).toEqual(["42", "40"]);
    expect(releases[0]?.sha256).toBe("a".repeat(64));
  });
});
