import { describe, expect, it } from "vitest";
import {
  adbCommand,
  ascii,
  decodeAdbHeader,
  encodeAdbMessage,
  validateAdbPayload,
} from "../src/adb/codec";

describe("ADB codec", () => {
  it("encodes CNXN with checksum and magic", () => {
    const command = adbCommand("CNXN");
    const packet = encodeAdbMessage({
      command,
      arg0: 0x01000000,
      arg1: 4096,
      payload: ascii("host::\0"),
    });
    expect(packet.byteLength).toBe(31);
    expect(new DataView(packet.buffer).getUint32(20, true)).toBe(
      (command ^ 0xffffffff) >>> 0,
    );
    expect(decodeAdbHeader(packet.subarray(0, 24)).length).toBe(7);
  });

  it("rejects invalid header length and magic", () => {
    expect(() => decodeAdbHeader(new Uint8Array(23))).toThrow(
      "ADB_HEADER_LENGTH_INVALID",
    );
    const packet = encodeAdbMessage({
      command: adbCommand("WRTE"),
      arg0: 1,
      arg1: 2,
      payload: new Uint8Array(),
    });
    packet[20] = (packet[20] ?? 0) ^ 1;
    expect(() => decodeAdbHeader(packet.subarray(0, 24))).toThrow(
      "ADB_MAGIC_INVALID",
    );
  });

  it("rejects a payload checksum mismatch", () => {
    const command = adbCommand("WRTE");
    const header = {
      command,
      arg0: 1,
      arg1: 2,
      length: 1,
      checksum: 7,
      magic: (command ^ 0xffffffff) >>> 0,
    };
    expect(() => validateAdbPayload(header, new Uint8Array([8]))).toThrow(
      "ADB_CHECKSUM_INVALID",
    );
  });

  it("rejects payloads larger than one MiB", () => {
    const command = adbCommand("WRTE");
    const header = new Uint8Array(24);
    const view = new DataView(header.buffer);
    view.setUint32(0, command, true);
    view.setUint32(12, 1_048_577, true);
    view.setUint32(20, (command ^ 0xffffffff) >>> 0, true);
    expect(() => decodeAdbHeader(header)).toThrow("ADB_PAYLOAD_TOO_LARGE");
  });
});
