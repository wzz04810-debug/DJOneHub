export type BlobListItem = {
  readonly pathname: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly url: string;
  readonly downloadUrl: string;
};

export type FirmwareRelease = {
  readonly id: string;
  readonly version: string;
  readonly testflightBuild: string;
  readonly filename: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly sha256?: string;
};

export type StoredFirmwareRelease = FirmwareRelease & {
  readonly pathname: string;
  readonly checksumPathname: string;
};

const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const BUILD = /^testflight-([0-9A-Za-z.-]+)$/;
const PACKAGE = /\.(?:djwebflash|djupdate)$/i;

export function releaseFromBlob(blob: BlobListItem): StoredFirmwareRelease | undefined {
  const parts = blob.pathname.split("/");
  if (parts.length !== 4 || parts[0] !== "firmware" || !parts[1] || !parts[2] || !parts[3]) return undefined;
  const build = BUILD.exec(parts[2]);
  if (!VERSION.test(parts[1]) || !build?.[1] || !PACKAGE.test(parts[3])) return undefined;
  if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || !Number.isFinite(Date.parse(blob.uploadedAt))) return undefined;
  try {
    const url = new URL(blob.url);
    const downloadUrl = new URL(blob.downloadUrl);
    if (url.protocol !== "https:" || downloadUrl.protocol !== "https:" || url.hostname !== downloadUrl.hostname) return undefined;
  } catch {
    return undefined;
  }
  return {
    id: blob.pathname,
    version: parts[1],
    testflightBuild: build[1],
    filename: parts[3],
    size: blob.size,
    uploadedAt: blob.uploadedAt,
    pathname: blob.pathname,
    checksumPathname: `${blob.pathname}.sha256`,
  };
}

export function buildCatalog(blobs: readonly BlobListItem[], checksums: ReadonlyMap<string, string> = new Map()): StoredFirmwareRelease[] {
  return blobs
    .map(releaseFromBlob)
    .filter((release): release is StoredFirmwareRelease => release !== undefined)
    .map((release) => {
      const checksum = checksums.get(release.checksumPathname)?.trim().toLowerCase();
      return checksum && /^[a-f0-9]{64}$/.test(checksum) ? { ...release, sha256: checksum } : release;
    })
    .sort((left, right) => {
      const buildOrder = right.testflightBuild.localeCompare(left.testflightBuild, "en", { numeric: true });
      return buildOrder || Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt);
    });
}
