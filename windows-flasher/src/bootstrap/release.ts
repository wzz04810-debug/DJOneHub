import { FlashError } from "../domain";
import { BOOTSTRAP_RELEASE_POLICY, type BootstrapReleasePolicy } from "./package";

export type BootstrapDownloadProgress = (received: number, total: number) => void;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

export class BootstrapReleaseClient {
  private readonly fetcher: typeof fetch;
  private readonly policy: BootstrapReleasePolicy;

  constructor(fetcher: typeof fetch = fetch, policy: BootstrapReleasePolicy = BOOTSTRAP_RELEASE_POLICY) {
    this.fetcher = fetcher;
    this.policy = policy;
  }

  async fetchPackage(onProgress?: BootstrapDownloadProgress, signal?: AbortSignal): Promise<Uint8Array> {
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher("/api/bootstrap-package", {
        method: "POST",
        headers: { "X-DJOneHub-Flash": "1" },
        signal: signal ?? AbortSignal.timeout(120_000),
        cache: "no-store",
        redirect: "error",
      });
    } catch (error) {
      throw new FlashError("DOWNLOAD_FAILED", "Bootstrap 包下载失败", { cause: error });
    }
    if (!response.ok) throw new FlashError("DOWNLOAD_FAILED", `Bootstrap 包下载失败：HTTP ${response.status}`);
    const lengthText = response.headers.get("Content-Length");
    const transferEncoded = response.headers.has("Content-Encoding");
    const serverHash = response.headers.get("X-DJOneHub-Bootstrap-SHA256")?.toLowerCase();
    const length = lengthText === null ? undefined : Number(lengthText);
    if (serverHash !== this.policy.archiveSha256
      || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
      || (!transferEncoded && length !== undefined && length !== this.policy.archiveSize)) {
      throw new FlashError("PACKAGE_INVALID", "Bootstrap 服务端发布身份与固定版本不一致");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new FlashError("DOWNLOAD_FAILED", "Bootstrap 下载响应不可读取");
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > this.policy.archiveSize) {
        await reader.cancel();
        throw new FlashError("PACKAGE_INVALID", "Bootstrap 下载内容超过固定大小");
      }
      chunks.push(next.value);
      onProgress?.(received, this.policy.archiveSize);
    }
    if (received !== this.policy.archiveSize) throw new FlashError("PACKAGE_INVALID", "Bootstrap 下载内容长度不匹配");
    const result = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    if (await sha256(result) !== this.policy.archiveSha256) throw new FlashError("PACKAGE_INVALID", "Bootstrap 下载内容 SHA-256 不匹配");
    return result;
  }
}
