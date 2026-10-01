import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebUsbAdbDevice,
  requestQdc507,
} from "../src/adb/webusb-device";
import { adbCommand, ascii, encodeAdbMessage } from "../src/adb/codec";

interface FakeDeviceOptions {
  readonly adbInterfaceNumber?: number;
  readonly endpointOut?: number;
  readonly endpointIn?: number;
  readonly claimError?: Error;
  readonly hangOnOpen?: boolean;
  readonly hangOnRead?: boolean;
  readonly readError?: Error;
}

class FakeUsbDevice {
  readonly vendorId = 0x2c7c;
  readonly productId = 0x0125;
  readonly productName = "Baiwang";
  readonly manufacturerName = "BAIWANG";
  opened = false;
  configuration: USBConfiguration | null = null;
  readonly claimedInterfaces: number[] = [];
  readonly releasedInterfaces: number[] = [];
  readonly outTransferSizes: number[] = [];
  private readonly options: FakeDeviceOptions;

  constructor(options: FakeDeviceOptions = {}) {
    this.options = options;
  }

  async open(): Promise<void> {
    if (this.options.hangOnOpen) return new Promise(() => undefined);
    this.opened = true;
  }

  async selectConfiguration(): Promise<void> {
    const number = this.options.adbInterfaceNumber ?? 6;
    const alternate = {
      alternateSetting: 0,
      interfaceClass: 0xff,
      interfaceSubclass: 0x42,
      interfaceProtocol: 0x01,
      interfaceName: null,
      endpoints: [
        {
          endpointNumber: this.options.endpointOut ?? 3,
          direction: "out",
          type: "bulk",
          packetSize: 512,
        },
        {
          endpointNumber: (this.options.endpointIn ?? 0x84) & 0x0f,
          direction: "in",
          type: "bulk",
          packetSize: 512,
        },
      ],
    } as USBAlternateInterface;
    this.configuration = {
      configurationValue: 1,
      configurationName: null,
      interfaces: [
        {
          interfaceNumber: number,
          alternate,
          alternates: [alternate],
          claimed: false,
        },
      ],
    };
  }

  async claimInterface(number: number): Promise<void> {
    if (this.options.claimError) throw this.options.claimError;
    this.claimedInterfaces.push(number);
  }

  async releaseInterface(number: number): Promise<void> {
    this.releasedInterfaces.push(number);
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async transferOut(
    _endpoint: number,
    data: BufferSource,
  ): Promise<USBOutTransferResult> {
    const size = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
    this.outTransferSizes.push(size);
    return { status: "ok", bytesWritten: size };
  }

  async transferIn(
    _endpoint: number,
    length: number,
  ): Promise<USBInTransferResult> {
    if (this.options.hangOnRead) return new Promise(() => undefined);
    if (this.options.readError) throw this.options.readError;
    return { status: "ok", data: new DataView(new ArrayBuffer(length)) };
  }
}

afterEach(() => vi.useRealTimers());

class FakeUsb {
  lastFilters: USBDeviceFilter[] = [];
  readonly device: FakeUsbDevice;
  readonly hangOnRequest: boolean;

  constructor(device = new FakeUsbDevice(), hangOnRequest = false) {
    this.device = device;
    this.hangOnRequest = hangOnRequest;
  }

  async requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice> {
    this.lastFilters = options.filters;
    if (this.hangOnRequest) return new Promise(() => undefined);
    return this.device as unknown as USBDevice;
  }
}

describe("WebUSB QDC507 adapter", () => {
  it("filters the chooser to the verified VID and PID", async () => {
    const usb = new FakeUsb();
    await requestQdc507(usb as unknown as USB);
    expect(usb.lastFilters).toEqual([{ vendorId: 0x2c7c, productId: 0x0125 }]);
  });

  it("times out when the browser chooser never returns the selected device", async () => {
    vi.useFakeTimers();
    const usb = new FakeUsb(new FakeUsbDevice(), true);
    const requesting = expect(requestQdc507(usb as unknown as USB)).rejects.toMatchObject({
      code: "USB_DISCONNECTED",
      message: "等待模块 USB 响应超时：requestDevice chooser",
    });
    await vi.advanceTimersByTimeAsync(15_001);
    await requesting;
  });

  it("finds FF/42/01 dynamically and claims its interface", async () => {
    const raw = new FakeUsbDevice({
      adbInterfaceNumber: 6,
      endpointOut: 3,
      endpointIn: 0x84,
    });
    const device = new WebUsbAdbDevice(raw as unknown as USBDevice);
    await device.open();
    expect(raw.claimedInterfaces).toEqual([6]);
    await device.close();
    expect(raw.releasedInterfaces).toEqual([6]);
  });

  it("writes the ADB header and payload as separate USB transfers", async () => {
    const raw = new FakeUsbDevice();
    const device = new WebUsbAdbDevice(raw as unknown as USBDevice);
    await device.open();
    await device.write(encodeAdbMessage({
      command: adbCommand("CNXN"), arg0: 0x01000000, arg1: 4096, payload: ascii("host::\0"),
    }));
    expect(raw.outTransferSizes).toEqual([24, 7]);
  });

  it("does not add a redundant USB ZLP to a length-framed ADB payload", async () => {
    const raw = new FakeUsbDevice();
    const device = new WebUsbAdbDevice(raw as unknown as USBDevice);
    await device.open();
    await device.write(encodeAdbMessage({
      command: adbCommand("WRTE"), arg0: 1, arg1: 2, payload: new Uint8Array(512),
    }));
    expect(raw.outTransferSizes).toEqual([24, 512]);
  });

  it("maps claim failures to USB_INTERFACE_BUSY", async () => {
    const raw = new FakeUsbDevice({
      claimError: new DOMException("Access denied", "NetworkError"),
    });
    await expect(
      new WebUsbAdbDevice(raw as unknown as USBDevice).open(),
    ).rejects.toMatchObject({ code: "USB_INTERFACE_BUSY" });
  });

  it("maps a Chrome disconnect during claimInterface to USB_DISCONNECTED", async () => {
    const raw = new FakeUsbDevice({
      claimError: new DOMException("The device was disconnected.", "NetworkError"),
    });
    await expect(
      new WebUsbAdbDevice(raw as unknown as USBDevice).open(),
    ).rejects.toMatchObject({ code: "USB_DISCONNECTED" });
  });

  it("maps a Chrome transferIn disconnect to USB_DISCONNECTED", async () => {
    const raw = new FakeUsbDevice({
      readError: new DOMException("Failed to execute 'transferIn' on 'USBDevice': The device was disconnected.", "NetworkError"),
    });
    const device = new WebUsbAdbDevice(raw as unknown as USBDevice);
    await device.open();
    await expect(device.readExact(24)).rejects.toMatchObject({
      code: "USB_DISCONNECTED",
      message: "模块 USB 读取中断",
    });
  });

  it("times out instead of hanging forever when the module does not answer ADB", async () => {
    vi.useFakeTimers();
    const raw = new FakeUsbDevice({ hangOnRead: true });
    const device = new WebUsbAdbDevice(raw as unknown as USBDevice);
    await device.open();
    const reading = expect(device.readExact(24)).rejects.toMatchObject({
      code: "USB_DISCONNECTED",
      message: "等待模块 USB 响应超时：transferIn(ep=4,bytes=24)",
    });
    await vi.advanceTimersByTimeAsync(15_001);
    await reading;
  });

  it("honors the ADB stage deadline instead of the generic USB timeout", async () => {
    vi.useFakeTimers();
    const raw = new FakeUsbDevice({ hangOnRead: true });
    const device = new WebUsbAdbDevice(raw as unknown as USBDevice);
    await device.open();
    const reading = expect(device.readExact(24, undefined, 10_000)).rejects.toMatchObject({
      code: "USB_DISCONNECTED",
      message: "等待模块 USB 响应超时：transferIn(ep=4,bytes=24)",
    });
    await vi.advanceTimersByTimeAsync(10_001);
    await reading;
  });

  it("times out when a selected module disappears while being opened", async () => {
    vi.useFakeTimers();
    const raw = new FakeUsbDevice({ hangOnOpen: true });
    const device = new WebUsbAdbDevice(raw as unknown as USBDevice);
    const opening = expect(device.open()).rejects.toMatchObject({
      code: "USB_DISCONNECTED",
      message: "等待模块 USB 响应超时：device.open",
    });
    await vi.advanceTimersByTimeAsync(15_001);
    await opening;
  });
});
