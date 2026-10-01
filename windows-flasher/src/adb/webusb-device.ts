import {
  ADB_INTERFACE,
  FlashError,
  USB_PRODUCT_ID,
  USB_VENDOR_ID,
} from "../domain";
import type { AdbPacketIO } from "./client";
import { diagnostic } from "../diagnostics";
import { decodeAdbHeader } from "./codec";

type EndpointSelection = {
  readonly interfaceNumber: number;
  readonly alternateSetting: number;
  readonly endpointIn: number;
  readonly endpointOut: number;
  readonly endpointOutPacketSize: number;
};

const USB_OPERATION_TIMEOUT_MS = 15_000;

function disconnected(message: string, cause?: unknown): FlashError {
  return new FlashError("USB_DISCONNECTED", message, { cause });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isUsbDisconnectError(error: unknown): boolean {
  if (error instanceof FlashError) return error.code === "USB_DISCONNECTED";
  const message = errorMessage(error);
  return /disconnected|device was lost|device not found/i.test(message);
}

function usbResponse<T>(operation: Promise<T>, operationName: string, signal?: AbortSignal, timeoutMs = USB_OPERATION_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(() => {
      diagnostic("USB_TIMEOUT", operationName, "error");
      reject(disconnected(`等待模块 USB 响应超时：${operationName}`));
    }, timeoutMs);
    const aborted = () => reject(signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
    signal?.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", aborted);
    });
  });
}

function selectAdbInterface(device: USBDevice): EndpointSelection {
  const matches: EndpointSelection[] = [];
  for (const iface of device.configuration?.interfaces ?? []) {
    for (const alternate of iface.alternates) {
      diagnostic(
        "USB_INTERFACE_SEEN",
        `if=${iface.interfaceNumber} alt=${alternate.alternateSetting} class=${alternate.interfaceClass.toString(16).padStart(2, "0")} subclass=${alternate.interfaceSubclass.toString(16).padStart(2, "0")} protocol=${alternate.interfaceProtocol.toString(16).padStart(2, "0")} endpoints=${alternate.endpoints.length}`,
      );
      if (
        alternate.interfaceClass !== ADB_INTERFACE.classCode ||
        alternate.interfaceSubclass !== ADB_INTERFACE.subclassCode ||
        alternate.interfaceProtocol !== ADB_INTERFACE.protocolCode
      ) {
        continue;
      }
      const endpointIn = alternate.endpoints.find(
        (endpoint) => endpoint.type === "bulk" && endpoint.direction === "in",
      );
      const endpointOut = alternate.endpoints.find(
        (endpoint) => endpoint.type === "bulk" && endpoint.direction === "out",
      );
      if (endpointIn && endpointOut) {
        matches.push({
          interfaceNumber: iface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          endpointIn: endpointIn.endpointNumber,
          endpointOut: endpointOut.endpointNumber,
          endpointOutPacketSize: endpointOut.packetSize,
        });
      }
    }
  }
  if (matches.length !== 1) {
    diagnostic("ADB_INTERFACE_MATCH", `matches=${matches.length}`, "error");
    throw new FlashError(
      "UNSUPPORTED_DEVICE",
      matches.length === 0
        ? "未找到模块的 ADB USB 接口"
        : "模块暴露了多个 ADB USB 接口，无法安全选择",
    );
  }
  diagnostic("ADB_INTERFACE_MATCH", `if=${matches[0]!.interfaceNumber} alt=${matches[0]!.alternateSetting} in=${matches[0]!.endpointIn} out=${matches[0]!.endpointOut} outPacket=${matches[0]!.endpointOutPacketSize}`);
  return matches[0]!;
}

export class WebUsbAdbDevice implements AdbPacketIO {
  private readonly device: USBDevice;
  private selection: EndpointSelection | undefined;

  constructor(device: USBDevice) {
    this.device = device;
  }

  async open(): Promise<void> {
    try {
      diagnostic("USB_OPEN_START", `opened=${this.device.opened}`);
      if (!this.device.opened) {
        await usbResponse(this.device.open(), "device.open");
        diagnostic("USB_OPEN_OK", "device.open completed");
      }
      if (!this.device.configuration) {
        await usbResponse(this.device.selectConfiguration(1), "selectConfiguration(1)");
        diagnostic("USB_CONFIGURATION", "selected configuration=1");
      }
      const selection = selectAdbInterface(this.device);
      try {
        diagnostic("USB_CLAIM_START", `if=${selection.interfaceNumber}`);
        await usbResponse(this.device.claimInterface(selection.interfaceNumber), `claimInterface(${selection.interfaceNumber})`);
        diagnostic("USB_CLAIM_OK", `if=${selection.interfaceNumber}`);
      } catch (error) {
        diagnostic("USB_CLAIM_FAILED", errorMessage(error), "error");
        if (isUsbDisconnectError(error)) {
          throw disconnected("模块 USB 在占用接口时断开", error);
        }
        throw new FlashError(
          "USB_INTERFACE_BUSY",
          "ADB USB 接口被其他程序占用，请退出可能访问模块的程序后重试",
          { cause: error },
        );
      }
      if (selection.alternateSetting !== 0) {
        await usbResponse(
          this.device.selectAlternateInterface(
            selection.interfaceNumber,
            selection.alternateSetting,
          ),
          `selectAlternateInterface(${selection.interfaceNumber},${selection.alternateSetting})`,
        );
      }
      this.selection = selection;
    } catch (error) {
      if (error instanceof FlashError) {
        throw error;
      }
      throw disconnected("无法打开模块 USB 连接", error);
    }
  }

  async write(packet: Uint8Array): Promise<void> {
    const selection = this.selection;
    if (!selection) {
      throw disconnected("模块 USB 连接尚未打开");
    }
    if (packet.byteLength < 24) throw disconnected("ADB 数据包头不完整");
    const header = packet.subarray(0, 24);
    const payload = packet.subarray(24);
    if (decodeAdbHeader(header).length !== payload.byteLength) {
      throw disconnected("ADB 数据包长度不匹配");
    }
    try {
      const writeBlock = async (block: Uint8Array, kind: "header" | "payload") => {
        let offset = 0;
        do {
          const pending = block.slice(offset);
          diagnostic("USB_OUT", `kind=${kind} endpoint=${selection.endpointOut} bytes=${pending.byteLength}`);
          const result = await usbResponse(
            this.device.transferOut(selection.endpointOut, pending),
            `transferOut(${kind},ep=${selection.endpointOut})`,
          );
          diagnostic("USB_OUT_RESULT", `kind=${kind} endpoint=${selection.endpointOut} status=${result.status} written=${result.bytesWritten ?? 0}`);
          if (result.status !== "ok" || result.bytesWritten === undefined || (pending.byteLength > 0 && result.bytesWritten === 0)) {
            throw disconnected("向模块写入 USB 数据失败");
          }
          offset += result.bytesWritten;
        } while (offset < block.byteLength);
      };
      await writeBlock(header, "header");
      if (payload.byteLength > 0) {
        await writeBlock(payload, "payload");
      }
    } catch (error) {
      if (error instanceof FlashError) {
        throw error;
      }
      throw disconnected("模块 USB 写入中断", error);
    }
  }

  async readExact(length: number, signal?: AbortSignal, timeoutMs?: number): Promise<Uint8Array> {
    const endpoint = this.selection?.endpointIn;
    if (endpoint === undefined) {
      throw disconnected("模块 USB 连接尚未打开");
    }
    const result = new Uint8Array(length);
    let offset = 0;
    try {
      while (offset < length) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Operation aborted", "AbortError");
        }
        diagnostic("USB_IN_WAIT", `endpoint=${endpoint} bytes=${length - offset}`);
        const transfer = await usbResponse(
          this.device.transferIn(endpoint, length - offset),
          `transferIn(ep=${endpoint},bytes=${length - offset})`,
          signal,
          timeoutMs,
        );
        diagnostic("USB_IN_RESULT", `endpoint=${endpoint} status=${transfer.status} bytes=${transfer.data?.byteLength ?? 0}`);
        if (transfer.status !== "ok" || !transfer.data?.byteLength) {
          throw disconnected("从模块读取 USB 数据失败");
        }
        const chunk = new Uint8Array(
          transfer.data.buffer,
          transfer.data.byteOffset,
          transfer.data.byteLength,
        );
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } catch (error) {
      if (error instanceof FlashError || isAbortError(error)) {
        throw error;
      }
      throw disconnected("模块 USB 读取中断", error);
    }
  }

  async close(): Promise<void> {
    const selection = this.selection;
    this.selection = undefined;
    try {
      if (selection) {
        await this.device.releaseInterface(selection.interfaceNumber);
      }
      if (this.device.opened) {
        await this.device.close();
      }
    } catch (error) {
      throw disconnected("关闭模块 USB 连接失败", error);
    }
  }
}

export async function requestQdc507(usb: USB): Promise<WebUsbAdbDevice> {
  let device: USBDevice;
  try {
    diagnostic("USB_CHOOSER_OPEN", "filter vid=2c7c pid=0125");
    device = await usbResponse(
      usb.requestDevice({
        filters: [{ vendorId: USB_VENDOR_ID, productId: USB_PRODUCT_ID }],
      }),
      "requestDevice chooser",
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      throw new FlashError("USB_PERMISSION_CANCELLED", "未选择模块 USB 设备", {
        cause: error,
      });
    }
    throw error;
  }
  diagnostic(
    "USB_DEVICE_SELECTED",
    `${device.productName ?? "unnamed"} vid=${device.vendorId.toString(16).padStart(4, "0")} pid=${device.productId.toString(16).padStart(4, "0")} configurations=${device.configurations?.length ?? 0}`,
  );
  if (
    device.vendorId !== USB_VENDOR_ID ||
    device.productId !== USB_PRODUCT_ID
  ) {
    throw new FlashError("UNSUPPORTED_DEVICE", "所选 USB 设备不是 QDC507 模块");
  }
  return new WebUsbAdbDevice(device);
}
