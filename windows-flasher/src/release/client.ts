import { FlashError } from "../domain";
import { RELEASE_PUBLIC_KEY } from "./public-key";
import type { VerifiedChannel } from "./schema";
import { verifyChannel } from "./verifier";

export const STABLE_CHANNEL_URL = "https://wzz04810-debug.github.io/DJOneHub-iPad/releases/stable.json";
const SITE_ORIGIN = new URL(STABLE_CHANNEL_URL).origin;
const MAX_PACKAGE_BYTES = 24 * 1024 * 1024;
const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export type DownloadProgressValue = { readonly received: number; readonly total?: number };
export type DownloadProgress = (progress: DownloadProgressValue) => void;

function allowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.origin === SITE_ORIGIN || ALLOWED_HOSTS.has(parsed.hostname));
  } catch {
    return false;
  }
}

async function fetchWithTimeout(fetcher: typeof fetch, url: string, milliseconds: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Download timeout", "TimeoutError")), milliseconds);
  try {
    const response = await fetcher(url, { signal: controller.signal, redirect: "follow", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (error) {
    throw new FlashError("DOWNLOAD_FAILED", `下载失败：${url}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBody(
  response: Response,
  maximum: number,
  onProgress?: DownloadProgress,
  requireLength = false,
): Promise<Uint8Array> {
  const lengthText = response.headers.get("Content-Length");
  const total = lengthText === null ? undefined : Number(lengthText);
  if ((requireLength && total === undefined) || (total !== undefined && (!Number.isSafeInteger(total) || total < 0 || total > maximum))) {
    throw new FlashError("DOWNLOAD_FAILED", "下载响应的 Content-Length 无效");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FlashError("DOWNLOAD_FAILED", "下载响应没有可读取内容");
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    received += next.value.byteLength;
    if (received > maximum) {
      await reader.cancel();
      throw new FlashError("DOWNLOAD_FAILED", "下载内容超过大小限制");
    }
    chunks.push(next.value);
    onProgress?.(total === undefined ? { received } : { received, total });
  }
  if (total !== undefined && received !== total) throw new FlashError("DOWNLOAD_FAILED", "实际下载大小与 Content-Length 不一致");
  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes);
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return Array.from(value, (part) => part.toString(16).padStart(2, "0")).join("");
}

export class ReleaseClient {
  private readonly fetcher: typeof fetch;
  private readonly verificationKey: Uint8Array;

  constructor(fetcher: typeof fetch = fetch, verificationKey = RELEASE_PUBLIC_KEY) {
    this.fetcher = fetcher;
    this.verificationKey = verificationKey;
  }

  async fetchStableChannel(onProgress?: DownloadProgress): Promise<VerifiedChannel> {
    const [documentResponse, signatureResponse] = await Promise.all([
      fetchWithTimeout(this.fetcher, STABLE_CHANNEL_URL, 30_000),
      fetchWithTimeout(this.fetcher, `${STABLE_CHANNEL_URL}.sig`, 30_000),
    ]);
    if ((documentResponse.url && !allowed(documentResponse.url)) || (signatureResponse.url && !allowed(signatureResponse.url))) {
      throw new FlashError("PACKAGE_INVALID", "发布通道重定向到了未授权站点");
    }
    const [bytes, signature] = await Promise.all([
      readBody(documentResponse, 64 * 1024, onProgress),
      readBody(signatureResponse, 64),
    ]);
    const channel = await verifyChannel(bytes, signature, this.verificationKey);
    if (!allowed(channel.asset_url)) throw new FlashError("PACKAGE_INVALID", "发布包地址不在允许列表中");
    return channel;
  }

  async fetchPackage(channel: VerifiedChannel, onProgress: DownloadProgress): Promise<Uint8Array> {
    if (!allowed(channel.asset_url)) throw new FlashError("PACKAGE_INVALID", "发布包地址不在允许列表中");
    const response = await fetchWithTimeout(this.fetcher, channel.asset_url, 120_000);
    if (response.url && !allowed(response.url)) throw new FlashError("PACKAGE_INVALID", "发布包重定向到了未授权站点");
    const bytes = await readBody(response, MAX_PACKAGE_BYTES, onProgress, true);
    if (bytes.byteLength !== channel.size || await digest(bytes) !== channel.sha256) {
      throw new FlashError("PACKAGE_INVALID", "发布包大小或 SHA-256 不匹配");
    }
    return bytes;
  }
}
