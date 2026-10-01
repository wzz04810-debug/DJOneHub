import { describe, expect, it } from "vitest";
import {
  ADB_INTERFACE,
  MODULE_PLATFORM,
  USB_PRODUCT_ID,
  USB_VENDOR_ID,
  isTerminalState,
} from "../src/domain";

describe("QDC507 domain contract", () => {
  it("pins the verified hardware and platform", () => {
    expect([USB_VENDOR_ID, USB_PRODUCT_ID]).toEqual([0x2c7c, 0x0125]);
    expect(ADB_INTERFACE).toEqual({
      classCode: 0xff,
      subclassCode: 0x42,
      protocolCode: 0x01,
    });
    expect(MODULE_PLATFORM).toBe("qdc507-armv7-linux-3.18.44");
  });

  it("only marks completed and failed as terminal", () => {
    expect(isTerminalState({ phase: "completed", version: "0.3.5" })).toBe(true);
    expect(
      isTerminalState({
        phase: "failed",
        code: "USB_DISCONNECTED",
        message: "断开",
      }),
    ).toBe(true);
    expect(
      isTerminalState({
        phase: "uploading",
        file: "qdc507-agent",
        sent: 1,
        total: 2,
      }),
    ).toBe(false);
  });
});
