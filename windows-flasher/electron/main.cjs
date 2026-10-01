const { app, BrowserWindow, dialog, session } = require("electron");
const { createHash } = require("node:crypto");
const { createReadStream, existsSync, readFileSync, statSync } = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const QDC507_VENDOR_ID = 0x2c7c;
const QDC507_PRODUCT_ID = 0x0125;
const MIME_TYPES = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

function firmwareRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "firmware")
    : path.join(app.getAppPath(), "resources", "firmware");
}

/** 只有摘要与清单同时匹配时，才把内置首次部署包提供给渲染进程。 */
function baseline() {
  const root = firmwareRoot();
  const metadataPath = path.join(root, "baseline.json");
  if (!existsSync(metadataPath)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const filePath = path.join(root, metadata.filename);
    if (!metadata.filename || path.basename(metadata.filename) !== metadata.filename || !existsSync(filePath)) return undefined;
    const bytes = readFileSync(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== metadata.sha256 || bytes.byteLength !== metadata.size) return undefined;
    return { ...metadata, filePath, uploadedAt: "2026-10-01T00:00:00.000Z" };
  } catch {
    return undefined;
  }
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  if (typeof body === "string") response.end(body);
  else body.pipe(response);
}

function createServer() {
  const webRoot = path.join(app.getAppPath(), "dist");
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const current = baseline();
    if (requestUrl.pathname === "/api/firmware" && request.method === "GET") {
      const releases = current ? [{ id: "baseline-0.3.15", version: current.version, testflightBuild: current.build, filename: current.filename, size: current.size, uploadedAt: current.uploadedAt, sha256: current.sha256 }] : [];
      return send(response, 200, JSON.stringify({ releases }), { "Content-Type": "application/json" });
    }
    if (requestUrl.pathname === "/api/firmware-package" && request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!current || payload.id !== "baseline-0.3.15") return send(response, 404, "Firmware not found");
          send(response, 200, createReadStream(current.filePath), { "Content-Type": "application/octet-stream", "Content-Length": String(current.size) });
        } catch { send(response, 400, "Invalid request"); }
      });
      return;
    }
    const pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
    const candidate = path.resolve(webRoot, `.${pathname}`);
    if (!candidate.startsWith(`${webRoot}${path.sep}`) || !existsSync(candidate) || statSync(candidate).isDirectory()) return send(response, 404, "Not found");
    send(response, 200, createReadStream(candidate), { "Content-Type": MIME_TYPES[path.extname(candidate)] || "application/octet-stream" });
  });
}

function configureUsbPermissions() {
  const currentSession = session.defaultSession;
  currentSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => permission === "usb" && new URL(requestingOrigin).hostname === "127.0.0.1");
  currentSession.on("select-usb-device", (event, details, callback) => {
    event.preventDefault();
    const candidates = details.deviceList.filter((device) => device.vendorId === QDC507_VENDOR_ID && device.productId === QDC507_PRODUCT_ID);
    if (candidates.length === 1) callback(candidates[0].deviceId);
    else {
      callback("");
      void dialog.showMessageBox({ type: "warning", message: candidates.length === 0 ? "未找到 QDC507（2c7c:0125）设备。" : "检测到多个 QDC507 设备，请只连接一个模块后重试。" });
    }
  });
}

app.whenReady().then(() => {
  configureUsbPermissions();
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return app.quit();
    const window = new BrowserWindow({ width: 1180, height: 860, minWidth: 980, minHeight: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void window.loadURL(`http://127.0.0.1:${address.port}/`);
  });
  app.on("before-quit", () => server.close());
});

app.on("window-all-closed", () => app.quit());
