export type BootstrapFile = {
  readonly name: string;
  readonly archivePath: string;
  readonly remotePath: string;
  readonly mode: 0o644 | 0o755;
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
};

export type BootstrapBundle = {
  readonly version: string;
  readonly files: readonly BootstrapFile[];
};

import { BOOTSTRAP_RELEASE_POLICY, type BootstrapReleasePolicy } from "./policy";
export { BOOTSTRAP_RELEASE_POLICY, type BootstrapReleasePolicy } from "./policy";

function invalid(message: string, cause?: unknown): FlashError {
  return new FlashError("PACKAGE_INVALID", message, { cause });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function tarText(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end < 0 ? field : field.subarray(0, end));
}

function tarOctal(block: Uint8Array, start: number, length: number): number {
  const value = tarText(block, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw invalid("Bootstrap TAR 数字字段无效");
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result) || result < 0) throw invalid("Bootstrap TAR 数字字段越界");
  return result;
}

function normalizedPath(raw: string): string {
  const value = raw.startsWith("./") ? raw.slice(2) : raw;
  return value === "." ? "" : value.replace(/\/$/, "");
}

function paxHeaderPath(entryPath: string): string {
  if (!entryPath) return "PaxHeader/currentdir";
  const separator = entryPath.lastIndexOf("/");
  const directory = separator < 0 ? "" : entryPath.slice(0, separator);
  const basename = entryPath.slice(separator + 1);
  return `${directory ? `${directory}/` : ""}PaxHeader/${basename}`;
}

function validatePaxMetadata(bytes: Uint8Array): void {
  const allowedBinaryKeys = new Set([
    "LIBARCHIVE.xattr.com.apple.provenance",
    "SCHILY.xattr.com.apple.provenance",
  ]);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const space = bytes.indexOf(0x20, offset);
    if (space <= offset || space - offset > 10) throw invalid("Bootstrap PAX 记录长度无效");
    const lengthText = decoder.decode(bytes.subarray(offset, space));
    if (!/^[1-9]\d*$/.test(lengthText)) throw invalid("Bootstrap PAX 记录长度无效");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.byteLength || bytes[end - 1] !== 0x0a) throw invalid("Bootstrap PAX 记录边界无效");
    const equals = bytes.indexOf(0x3d, space + 1);
    if (equals < space + 2 || equals >= end - 1) throw invalid("Bootstrap PAX 记录格式无效");
    const key = decoder.decode(bytes.subarray(space + 1, equals));
    const value = bytes.subarray(equals + 1, end - 1);
    if (key === "mtime") {
      if (!/^\d{1,12}(?:\.\d{1,20})?$/.test(decoder.decode(value))) throw invalid("Bootstrap PAX mtime 无效");
    } else if (!allowedBinaryKeys.has(key) || value.byteLength === 0 || value.byteLength > 128) {
      throw invalid("Bootstrap PAX 包含可改变归档语义的字段");
    }
    offset = end;
  }
  if (offset === 0) throw invalid("Bootstrap PAX 元数据为空");
}

function parseArchive(bytes: Uint8Array, policy: BootstrapReleasePolicy): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  let linkSeen = false;
  let ended = false;
  let pendingPax: { readonly name: string; readonly mode: number } | undefined;
  let offset = 0;
  const filePolicies = new Map(policy.files.map((file) => [file.archivePath, file]));
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      if (offset + 1024 > bytes.byteLength || !bytes.subarray(offset, offset + 1024).every((value) => value === 0)) {
        throw invalid("Bootstrap TAR 结束块无效");
      }
      ended = true;
      break;
    }
    if (tarText(header, 257, 6) !== "ustar") throw invalid("Bootstrap TAR 格式无效");
    const expectedChecksum = tarOctal(header, 148, 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (expectedChecksum !== actualChecksum) throw invalid("Bootstrap TAR 头校验和无效");
    const name = normalizedPath(tarText(header, 0, 100));
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) throw invalid("Bootstrap TAR 路径不安全");
    const type = header[156];
    const mode = tarOctal(header, 100, 8) & 0o777;
    const size = tarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) throw invalid("Bootstrap TAR 内容截断");
    if (type === 0x78) {
      if (pendingPax !== undefined || size <= 0 || size > 512 || (mode !== 0o644 && mode !== 0o755)) throw invalid("Bootstrap PAX 头无效");
      validatePaxMetadata(bytes.subarray(dataStart, dataEnd));
      pendingPax = { name, mode };
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (pendingPax !== undefined) {
      if (pendingPax.name !== paxHeaderPath(name) || pendingPax.mode !== mode) throw invalid("Bootstrap PAX 与后续条目不匹配");
      pendingPax = undefined;
    }
    if (type === 0x35) {
      if (!ALLOWED_DIRECTORIES.has(name) || directories.has(name) || size !== 0) throw invalid("Bootstrap 包含额外或重复目录");
      directories.add(name);
    } else if (type === 0x32) {
      if (name !== LINK_PATH || tarText(header, 157, 100) !== LINK_TARGET || linkSeen || size !== 0) throw invalid("Bootstrap 自启动链接无效");
      linkSeen = true;
    } else if (type === 0 || type === 0x30) {
      const expected = filePolicies.get(name);
      if (!expected || entries.has(name) || size !== expected.size || mode !== expected.mode) throw invalid("Bootstrap 文件白名单、大小或权限无效");
      entries.set(name, bytes.slice(dataStart, dataEnd));
    } else {
      throw invalid("Bootstrap 包含不允许的归档类型");
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!ended || pendingPax !== undefined || !linkSeen || entries.size !== policy.files.length || directories.size !== ALLOWED_DIRECTORIES.size) {
    throw invalid("Bootstrap 包文件集合不完整");
  }
  return entries;
}

function validateConfig(bytes: Uint8Array, publicKeyBase64: string): void {
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)); } catch (error) { throw invalid("Bootstrap 配置 JSON 无效", error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Bootstrap 配置无效");
  const config = value as Record<string, unknown>;
  if (typeof config.manifest_url !== "string" || typeof config.public_key !== "string" || config.at_device !== "/dev/djonehub_data11" || !Array.isArray(config.allowed_hosts)) {
    throw invalid("Bootstrap 配置字段无效");
  }
  let manifest: URL;
  try { manifest = new URL(config.manifest_url); } catch (error) { throw invalid("Bootstrap manifest URL 无效", error); }
  if (manifest.protocol !== "https:" || manifest.username || manifest.password || !manifest.hostname) throw invalid("Bootstrap manifest URL 不安全");
  if (!config.allowed_hosts.some((host) => typeof host === "string" && host.toLowerCase() === manifest.hostname.toLowerCase())) {
    throw invalid("Bootstrap manifest 主机未列入白名单");
  }
  if (config.public_key !== publicKeyBase64) throw invalid("Bootstrap 发布公钥不匹配");
  let key: Uint8Array;
  try { key = Uint8Array.from(atob(config.public_key), (character) => character.charCodeAt(0)); } catch (error) { throw invalid("Bootstrap 发布公钥编码无效", error); }
  if (key.byteLength !== 32) throw invalid("Bootstrap 发布公钥长度无效");
}

export async function verifyBootstrapArchive(
  bytes: Uint8Array,
  policy: BootstrapReleasePolicy = BOOTSTRAP_RELEASE_POLICY,
): Promise<BootstrapBundle> {
  if (bytes.byteLength < 18 || bytes.byteLength > MAX_ARCHIVE_BYTES || bytes.byteLength !== policy.archiveSize || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw invalid("Bootstrap gzip 大小或格式无效");
  }
  if (await sha256(bytes) !== policy.archiveSha256) throw invalid("Bootstrap 顶层 SHA-256 不匹配");
  const uncompressedSize = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 4, 4).getUint32(0, true);
  if (uncompressedSize <= 0 || uncompressedSize > MAX_UNCOMPRESSED_BYTES) throw invalid("Bootstrap 解压大小无效");
  let archive: Uint8Array;
  try { archive = gunzipSync(bytes); } catch (error) { throw invalid("Bootstrap gzip 解压失败", error); }
  if (archive.byteLength !== uncompressedSize) throw invalid("Bootstrap gzip 解压长度不匹配");
  const entries = parseArchive(archive, policy);
  const files: BootstrapFile[] = [];
  for (const expected of policy.files) {
    const payload = entries.get(expected.archivePath);
    if (!payload || await sha256(payload) !== expected.sha256) throw invalid(`Bootstrap 文件 SHA-256 不匹配：${expected.archivePath}`);
    files.push({ ...expected, name: expected.archivePath.split("/").at(-1)!, bytes: payload });
  }
  const executable = entries.get("usr/sbin/djonehub-bootstrap");
  if (!executable || executable.byteLength < 20 || executable[0] !== 0x7f || executable[1] !== 0x45 || executable[2] !== 0x4c || executable[3] !== 0x46 || executable[4] !== 1 || executable[5] !== 1 || executable[18] !== 40 || executable[19] !== 0) {
    throw invalid("Bootstrap 可执行文件不是 ARMv7 little-endian ELF");
  }
  validateConfig(entries.get("etc/djonehub-bootstrap.json")!, policy.publicKeyBase64);
  return { version: policy.version, files };
}
import { gunzipSync } from "fflate";
import { FlashError } from "../domain";

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;
const LINK_PATH = "etc/rc5.d/S99zzz_djonehub_bootstrap";
const LINK_TARGET = "../init.d/djonehub_bootstrap";
const ALLOWED_DIRECTORIES = new Set(["", "etc", "etc/init.d", "etc/rc5.d", "usr", "usr/lib", "usr/lib/djonehub", "usr/sbin"]);
const decoder = new TextDecoder("utf-8", { fatal: true });
