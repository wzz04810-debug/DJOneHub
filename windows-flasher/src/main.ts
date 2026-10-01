import { ProvisioningController } from "./provisioning/controller";
import { mountWindowsFlasher, type WindowsFlasherEnvironment } from "./ui/windows-app";

const root = document.querySelector<HTMLElement>("#app");

function environment(): WindowsFlasherEnvironment {
  const userAgent = navigator.userAgent;
  const os = /Macintosh|Mac OS X/.test(userAgent) ? "macOS" : /Windows/.test(userAgent) ? "Windows" : "Other";
  const match = /(Edg|Chrome)\/([\d.]+)/.exec(userAgent);
  return {
    secure: globalThis.isSecureContext,
    webUsb: "usb" in navigator,
    os,
    browser: match ? `${match[1] === "Edg" ? "Edge" : "Chrome"} ${match[2]}` : "不受支持的浏览器",
  };
}

if (root) {
  mountWindowsFlasher(root, new ProvisioningController(), environment());
}
