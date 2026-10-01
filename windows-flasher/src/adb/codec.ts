const HEADER_LENGTH = 24;
const MAX_PAYLOAD_LENGTH = 1024 * 1024;

export interface AdbMessage {
  readonly command: number;
  readonly arg0: number;
  readonly arg1: number;
  readonly payload: Uint8Array;
}

export interface AdbHeader {
  readonly command: number;
  readonly arg0: number;
  readonly arg1: number;
  readonly length: number;
  readonly checksum: number;
  readonly magic: number;
}

export function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function adbCommand(value: string): number {
  if (!/^[\x20-\x7e]{4}$/.test(value)) {
    throw new Error("ADB_COMMAND_INVALID");
  }
  return (
    value.charCodeAt(0) |
    (value.charCodeAt(1) << 8) |
    (value.charCodeAt(2) << 16) |
    (value.charCodeAt(3) << 24)
  ) >>> 0;
}

export const ADB_CNXN = adbCommand("CNXN");
export const ADB_AUTH = adbCommand("AUTH");
export const ADB_OPEN = adbCommand("OPEN");
export const ADB_OKAY = adbCommand("OKAY");
export const ADB_CLSE = adbCommand("CLSE");
export const ADB_WRTE = adbCommand("WRTE");

function checksum(payload: Uint8Array): number {
  let result = 0;
  for (const byte of payload) {
    result = (result + byte) >>> 0;
  }
  return result;
}

export function encodeAdbMessage(message: AdbMessage): Uint8Array {
  if (message.payload.byteLength > MAX_PAYLOAD_LENGTH) {
    throw new Error("ADB_PAYLOAD_TOO_LARGE");
  }
  const packet = new Uint8Array(HEADER_LENGTH + message.payload.byteLength);
  const view = new DataView(packet.buffer);
  view.setUint32(0, message.command >>> 0, true);
  view.setUint32(4, message.arg0 >>> 0, true);
  view.setUint32(8, message.arg1 >>> 0, true);
  view.setUint32(12, message.payload.byteLength, true);
  view.setUint32(16, checksum(message.payload), true);
  view.setUint32(20, (message.command ^ 0xffffffff) >>> 0, true);
  packet.set(message.payload, HEADER_LENGTH);
  return packet;
}

export function decodeAdbHeader(bytes: Uint8Array): AdbHeader {
  if (bytes.byteLength !== HEADER_LENGTH) {
    throw new Error("ADB_HEADER_LENGTH_INVALID");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: AdbHeader = {
    command: view.getUint32(0, true),
    arg0: view.getUint32(4, true),
    arg1: view.getUint32(8, true),
    length: view.getUint32(12, true),
    checksum: view.getUint32(16, true),
    magic: view.getUint32(20, true),
  };
  if (header.magic !== ((header.command ^ 0xffffffff) >>> 0)) {
    throw new Error("ADB_MAGIC_INVALID");
  }
  if (header.length > MAX_PAYLOAD_LENGTH) {
    throw new Error("ADB_PAYLOAD_TOO_LARGE");
  }
  return header;
}

export function validateAdbPayload(
  header: AdbHeader,
  payload: Uint8Array,
): void {
  if (payload.byteLength !== header.length) {
    throw new Error("ADB_PAYLOAD_LENGTH_INVALID");
  }
  if (checksum(payload) !== header.checksum) {
    throw new Error("ADB_CHECKSUM_INVALID");
  }
}
