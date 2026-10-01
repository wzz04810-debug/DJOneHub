import { afterEach, describe, expect, it } from "vitest";
import {
  clearDiagnostics,
  diagnostic,
  formatDiagnosticLog,
  subscribeDiagnostics,
} from "../src/diagnostics";

afterEach(clearDiagnostics);

describe("connection diagnostics", () => {
  it("replays bounded, redacted structured entries to the page", () => {
    diagnostic("USB_DEVICE_SELECTED", "baiwang serial=123456789012 vid=2c7c pid=0125");
    const entries: string[] = [];
    const unsubscribe = subscribeDiagnostics((entry) => entries.push(`${entry.code} ${entry.message}`));
    diagnostic("ADB_PACKET", "received CNXN");
    unsubscribe();
    expect(entries).toEqual([
      "USB_DEVICE_SELECTED baiwang serial=[REDACTED] vid=2c7c pid=0125",
      "ADB_PACKET received CNXN",
    ]);
    expect(formatDiagnosticLog()).toContain("[ADB_PACKET] received CNXN");
    expect(formatDiagnosticLog()).not.toContain("123456789012");
  });

  it("never lets a broken page listener interrupt USB operations", () => {
    const unsubscribe = subscribeDiagnostics(() => { throw new Error("render failed"); });
    expect(() => diagnostic("USB_OPEN_START", "opened=false")).not.toThrow();
    unsubscribe();
  });

  it("retains warnings and errors when bulk USB packet logs fill the bounded history", () => {
    diagnostic("ROLLBACK_TRIGGER", "original_code=SPACE_CHECK_FAILED", "warn");
    for (let index = 0; index < 1_100; index += 1) {
      diagnostic("USB_PACKET", `index=${index}`);
    }
    diagnostic("ROLLBACK_FAILED", "restore timed out", "error");

    const log = formatDiagnosticLog();
    expect(log).toContain("[ROLLBACK_TRIGGER] original_code=SPACE_CHECK_FAILED");
    expect(log).toContain("[ROLLBACK_FAILED] restore timed out");
  });
});
