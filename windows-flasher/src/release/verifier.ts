import { verifyAsync } from "@noble/ed25519";
import { gunzipSync, unzipSync } from "fflate";
import {
  FlashError,
  MODULE_PLATFORM,
  type ChannelDocument,
  type WebflashManifest,
  type WebflashManifestFile,
} from "../domain";
import { RELEASE_PUBLIC_KEY } from "./public-key";
import type { VerifiedPackage } from "./schema";

const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_DECOMPRESSED_SIZE = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const MANIFEST_KEYS = ["files", "format_version", "platform", "version"];
const FILE_KEYS = ["archive_path", "mode", "name", "sha256", "size", "target"];
const OTA_FILE_KEYS = ["mode", "name", "sha256", "size", "target"];
const CHANNEL_KEYS = ["asset_url", "channel", "format_version", "platform", "published_at", "sha256", "size", "version"];
const FILE_SPECS: Record<string, { target: string; mode: 384 | 420 | 493 }> = {
  "install-webflash.sh": { target: "/data/local/tmp/install-webflash.sh", mode: 493 },
  "qdc507-agent": { target: "/data/djonehub/bin/qdc507-agent", mode: 493 },
  "qdc507_data11_bridge.ko": { target: "/data/djonehub/kernel/qdc507_data11_bridge.ko", mode: 420 },
  "qdc507_aprv3.ko": { target: "/data/djonehub/voice-runtime/qdc507_aprv3.ko", mode: 420 },
  "qdc507_voice.ko": { target: "/data/djonehub/voice-runtime/qdc507_voice.ko", mode: 420 },
  "mavo-pcm-bridge.armv7": { target: "/data/djonehub/voice-runtime/mavo-pcm-bridge.armv7", mode: 493 },
};

function packageError(message: string, cause?: unknown): FlashError {
  return new FlashError("PACKAGE_INVALID", message, { cause });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw packageError(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw packageError(`${name} 字段不符合格式`);
  }
}

function parseJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (error) {
    throw packageError(`${name} JSON 无效`, error);
  }
}

async function validSignature(bytes: Uint8Array, signature: Uint8Array, key: Uint8Array): Promise<boolean> {
  if (signature.byteLength !== 64 || key.byteLength !== 32) return false;
  try {
    return await verifyAsync(signature, bytes, key);
  } catch {
    return false;
  }
}

function scanCentralDirectory(bytes: Uint8Array): { names: string[]; total: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = Math.max(0, bytes.byteLength - 65_557); offset <= bytes.byteLength - 22; offset += 1) {
    if (view.getUint32(offset, true) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) throw packageError("ZIP 中央目录缺失");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw packageError("ZIP 中央目录损坏");
    }
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > bytes.byteLength) throw packageError("ZIP 文件名损坏");
    names.push(decoder.decode(bytes.subarray(offset + 46, nameEnd)));
    total += size;
    if (total > MAX_DECOMPRESSED_SIZE) throw packageError("升级包解压后超过 32 MiB");
    offset = nameEnd + extraLength + commentLength;
  }
  if (new Set(names).size !== names.length) throw packageError("ZIP 包含重复路径");
  return { names, total };
}

function tarText(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end < 0 ? field : field.subarray(0, end));
}

function tarOctal(block: Uint8Array, start: number, length: number): number {
  const value = tarText(block, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw packageError("TAR 数字字段无效");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw packageError("TAR 数字字段越界");
  return parsed;
}

export function parseUstarArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength > MAX_DECOMPRESSED_SIZE || bytes.byteLength % 512 !== 0) {
    throw packageError("TAR 大小或对齐无效");
  }
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      ended = true;
      break;
    }
    if (tarText(header, 257, 6) !== "ustar") throw packageError("TAR 不是受支持的 USTAR 格式");
    const expectedChecksum = tarOctal(header, 148, 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    }
    if (actualChecksum !== expectedChecksum) throw packageError("TAR 头校验和无效");
    const type = header[156];
    if (type !== 0 && type !== 0x30) throw packageError("TAR 包含非普通文件");
    const name = tarText(header, 0, 100);
    if (!name || name.startsWith("/") || name.includes("..") || name.includes("\\") || entries.has(name)) {
      throw packageError("TAR 路径无效或重复");
    }
    const size = tarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) throw packageError("TAR 文件内容截断");
    entries.set(name, bytes.slice(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!ended || entries.size === 0) throw packageError("TAR 缺少结束块或文件");
  return entries;
}

function parseManifest(bytes: Uint8Array): WebflashManifest {
  const raw = object(parseJson(bytes, "manifest.json"), "manifest");
  exactKeys(raw, MANIFEST_KEYS, "manifest");
  if (raw.format_version !== 1 || raw.platform !== MODULE_PLATFORM || typeof raw.version !== "string" || !VERSION.test(raw.version) || !Array.isArray(raw.files)) {
    throw packageError("manifest 元数据无效");
  }
  const targets = new Set<string>();
  const paths = new Set<string>();
  const files: WebflashManifestFile[] = raw.files.map((item, index) => {
    const file = object(item, `files[${index}]`);
    exactKeys(file, FILE_KEYS, `files[${index}]`);
    if (typeof file.name !== "string") throw packageError("payload 名称无效");
    const spec = FILE_SPECS[file.name];
    if (!spec || file.archive_path !== `payload/${file.name}` || file.target !== spec.target || file.mode !== spec.mode || typeof file.sha256 !== "string" || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || (file.size as number) < 0) {
      throw packageError(`payload 声明无效：${file.name}`);
    }
    if (targets.has(file.target as string) || paths.has(file.archive_path as string)) throw packageError("payload 路径或目标重复");
    targets.add(file.target as string);
    paths.add(file.archive_path as string);
    return file as unknown as WebflashManifestFile;
  });
  if (files.length === 0) throw packageError("升级包没有 payload");
  return { format_version: 1, version: raw.version, platform: MODULE_PLATFORM, files };
}

function parseOtaManifest(bytes: Uint8Array): WebflashManifest {
  const raw = object(parseJson(bytes, "manifest.json"), "manifest");
  exactKeys(raw, MANIFEST_KEYS, "manifest");
  if (raw.format_version !== 1 || raw.platform !== MODULE_PLATFORM || typeof raw.version !== "string" || !VERSION.test(raw.version) || !Array.isArray(raw.files)) {
    throw packageError("OTA manifest 元数据无效");
  }
  const expectedNames = Object.keys(FILE_SPECS).filter((name) => name !== "install-webflash.sh").sort();
  const files: WebflashManifestFile[] = raw.files.map((item, index) => {
    const file = object(item, `files[${index}]`);
    exactKeys(file, OTA_FILE_KEYS, `files[${index}]`);
    if (typeof file.name !== "string") throw packageError("OTA payload 名称无效");
    const spec = FILE_SPECS[file.name];
    const relativeTarget = spec?.target.replace("/data/djonehub/", "");
    if (!spec || file.name === "install-webflash.sh" || file.target !== relativeTarget || file.mode !== spec.mode || typeof file.sha256 !== "string" || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || (file.size as number) < 0) {
      throw packageError(`OTA payload 声明无效：${file.name}`);
    }
    return {
      name: file.name,
      archive_path: `payload/${file.name}`,
      target: spec.target,
      sha256: file.sha256,
      size: file.size as number,
      mode: spec.mode,
    };
  });
  const names = files.map((file) => file.name).sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    throw packageError("OTA payload 文件集合不完整");
  }
  return { format_version: 1, version: raw.version, platform: MODULE_PLATFORM, files };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function versionParts(value: string): number[] {
  return value.split("-", 1)[0]!.split(".").map(Number);
}

function isOlder(candidate: string, installed: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(installed);
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]!;
  }
  return false;
}

export async function verifyChannel(bytes: Uint8Array, signature: Uint8Array, verificationKey: Uint8Array<ArrayBufferLike> = RELEASE_PUBLIC_KEY): Promise<ChannelDocument> {
  if (!(await validSignature(bytes, signature, verificationKey))) {
    throw new FlashError("SIGNATURE_INVALID", "发布通道签名无效");
  }
  const raw = object(parseJson(bytes, "stable.json"), "channel");
  exactKeys(raw, CHANNEL_KEYS, "channel");
  if (raw.format_version !== 1 || raw.channel !== "stable" || raw.platform !== MODULE_PLATFORM || typeof raw.version !== "string" || !VERSION.test(raw.version) || typeof raw.asset_url !== "string" || !raw.asset_url.startsWith("https://") || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256) || !Number.isSafeInteger(raw.size) || (raw.size as number) < 0 || typeof raw.published_at !== "string" || !Number.isFinite(Date.parse(raw.published_at))) {
    throw packageError("发布通道内容无效");
  }
  return raw as unknown as ChannelDocument;
}

export async function verifyWebflashArchive(
  bytes: Uint8Array,
  installedVersion?: string,
  policy: { allowDowngrade: boolean } = { allowDowngrade: false },
  verificationKey: Uint8Array<ArrayBufferLike> = RELEASE_PUBLIC_KEY,
): Promise<VerifiedPackage> {
  const directory = scanCentralDirectory(bytes);
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch (error) {
    throw packageError("ZIP 解压失败", error);
  }
  const manifestBytes = archive["manifest.json"];
  const signature = archive["manifest.sig"];
  if (!manifestBytes || !signature) throw packageError("升级包缺少 manifest 或签名");
  if (!(await validSignature(manifestBytes, signature, verificationKey))) {
    throw new FlashError("SIGNATURE_INVALID", "升级包签名无效");
  }
  const manifest = parseManifest(manifestBytes);
  if (installedVersion && isOlder(manifest.version, installedVersion) && !policy.allowDowngrade) {
    throw new FlashError("DOWNGRADE_BLOCKED", `已安装 ${installedVersion}，目标版本 ${manifest.version}`);
  }
  const allowed = new Set(["manifest.json", "manifest.sig", ...manifest.files.map((file) => file.archive_path)]);
  if (directory.names.some((name) => !allowed.has(name)) || directory.names.length !== allowed.size) {
    throw packageError("升级包包含未知或缺失文件");
  }
  const files = new Map<string, { bytes: Uint8Array; mode: 384 | 420 | 493; target: string }>();
  for (const declared of manifest.files) {
    const payload = archive[declared.archive_path];
    if (!payload || payload.byteLength !== declared.size || await sha256(payload) !== declared.sha256) {
      throw packageError(`payload 校验失败：${declared.archive_path}`);
    }
    files.set(declared.archive_path, { bytes: payload, mode: declared.mode, target: declared.target });
  }
  return { manifest, files };
}

export async function verifyDjupdateArchive(
  bytes: Uint8Array,
  installedVersion?: string,
  policy: { allowDowngrade: boolean } = { allowDowngrade: false },
  verificationKey: Uint8Array<ArrayBufferLike> = RELEASE_PUBLIC_KEY,
): Promise<VerifiedPackage> {
  if (bytes.byteLength < 18 || bytes.byteLength > 24 * 1024 * 1024 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw packageError("OTA gzip 格式或压缩大小无效");
  }
  const footer = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 4, 4).getUint32(0, true);
  if (footer > MAX_DECOMPRESSED_SIZE) throw packageError("OTA 解压后超过 32 MiB");
  let archive: Map<string, Uint8Array>;
  try {
    archive = parseUstarArchive(gunzipSync(bytes));
  } catch (error) {
    if (error instanceof FlashError) throw error;
    throw packageError("OTA gzip/TAR 解压失败", error);
  }
  const manifestBytes = archive.get("manifest.json");
  const signature = archive.get("manifest.sig");
  if (!manifestBytes || !signature) throw packageError("OTA 缺少 manifest 或签名");
  if (!(await validSignature(manifestBytes, signature, verificationKey))) {
    throw new FlashError("SIGNATURE_INVALID", "OTA 升级包签名无效");
  }
  const manifest = parseOtaManifest(manifestBytes);
  if (installedVersion && isOlder(manifest.version, installedVersion) && !policy.allowDowngrade) {
    throw new FlashError("DOWNGRADE_BLOCKED", `已安装 ${installedVersion}，目标版本 ${manifest.version}`);
  }
  const allowed = new Set(["manifest.json", "manifest.sig", ...manifest.files.map((file) => file.archive_path)]);
  if (archive.size !== allowed.size || [...archive.keys()].some((name) => !allowed.has(name))) {
    throw packageError("OTA 包含未知或缺失文件");
  }
  const files = new Map<string, { bytes: Uint8Array; mode: 384 | 420 | 493; target: string }>();
  for (const declared of manifest.files) {
    const payload = archive.get(declared.archive_path);
    if (!payload || payload.byteLength !== declared.size || await sha256(payload) !== declared.sha256) {
      throw packageError(`OTA payload 校验失败：${declared.archive_path}`);
    }
    files.set(declared.archive_path, { bytes: payload, mode: declared.mode, target: declared.target });
  }
  return { manifest, files };
}
