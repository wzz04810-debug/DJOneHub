import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import { releaseFromBlob, type StoredFirmwareRelease } from "./src/firmware/catalog";

const LOCAL_FIRMWARE_ROOT = resolve(import.meta.dirname, "local-firmware");
const PACKAGE_NAME = /\.(?:djwebflash|djupdate)$/i;

function localFirmwarePlugin(): Plugin {
  const catalog = () => {
    if (!existsSync(LOCAL_FIRMWARE_ROOT)) return [];
    // 显式标注返回类型，确保本地固件目录为空时仍能通过严格模式构建。
    const releases: StoredFirmwareRelease[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!PACKAGE_NAME.test(entry.name)) continue;
        const pathname = path.slice(LOCAL_FIRMWARE_ROOT.length + 1);
        const stats = statSync(path);
        const checksumPath = `${path}.sha256`;
        const sha256 = existsSync(checksumPath)
          ? readFileSync(checksumPath, "utf8").trim().split(/\s+/, 1)[0]?.toLowerCase()
          : undefined;
        const release = releaseFromBlob({
          pathname,
          size: stats.size,
          uploadedAt: stats.mtime.toISOString(),
          url: "https://local.invalid/blob",
          downloadUrl: "https://local.invalid/blob?download=1",
        });
        if (!release) continue;
        releases.push(sha256 && /^[a-f0-9]{64}$/.test(sha256) ? { ...release, sha256 } : release);
      }
    };
    walk(LOCAL_FIRMWARE_ROOT);
    return releases
      .sort((left, right) => {
        const buildOrder = right.testflightBuild.localeCompare(left.testflightBuild, "en", { numeric: true });
        return buildOrder || Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt);
      })
      .map(({ pathname: _pathname, checksumPathname: _checksumPathname, ...release }) => release);
  };

  const send = (response: ServerResponse, status: number, body: string | NodeJS.ReadableStream, headers: Record<string, string>) => {
    response.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
    if (typeof body === "string") {
      response.end(body);
      return;
    }
    Readable.from(body).pipe(response);
  };

  return {
    name: "local-firmware",
    configureServer(server) {
      server.middlewares.use("/api/firmware-package", (request: IncomingMessage, response: ServerResponse, next) => {
        if (request.method !== "POST") {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          try {
            const id = JSON.parse(Buffer.concat(chunks).toString("utf8")).id;
            if (typeof id !== "string" || id.includes("..") || id.startsWith("/") || id.includes("\\")) {
              send(response, 400, "Invalid firmware", { "Content-Type": "text/plain" });
              return;
            }
            const path = resolve(LOCAL_FIRMWARE_ROOT, id);
            if (!path.startsWith(LOCAL_FIRMWARE_ROOT + "/") || !existsSync(path) || !PACKAGE_NAME.test(path)) {
              send(response, 404, "Firmware not found", { "Content-Type": "text/plain" });
              return;
            }
            const size = statSync(path).size;
            send(response, 200, createReadStream(path), {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(size),
              "Content-Disposition": "inline",
            });
          } catch {
            send(response, 400, "Invalid request", { "Content-Type": "text/plain" });
          }
        });
      });
      server.middlewares.use("/api/firmware", (request: IncomingMessage, response: ServerResponse, next) => {
        if (request.method !== "GET") {
          next();
          return;
        }
        send(response, 200, JSON.stringify({ releases: catalog() }), { "Content-Type": "application/json" });
      });
    },
  };
}

export default defineConfig({
  base: "./",
  // Windows 桌面版只使用受控的内置基线包，不复制旧网页工程的下载目录。
  publicDir: false,
  plugins: [localFirmwarePlugin()],
  build: {
    sourcemap: false,
    target: "es2022",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
