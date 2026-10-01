import { createHash, timingSafeEqual } from "node:crypto";

const CHANNEL = /^(?:testflight|stable)$/;
const DEVICE_HASH = /^[a-f0-9]{32}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{12,128}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const PHASES = new Set([
  "created", "checking_manifest", "manifest_verified", "downloading", "package_download_verified",
  "verifying_package", "staging", "activating", "health_check", "completed", "failed",
]);

export type StatusDocument = {
  operationId: string;
  writeTokenHash: string;
  channel: string;
  deviceHash: string;
  phase: string;
  progress: number;
  message: string;
  agentVersion?: string | undefined;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_BODY");
  return value as Record<string, unknown>;
}

export function validateSessionInput(value: unknown): { channel: string; deviceHash: string } {
  const input = requireObject(value);
  if (typeof input.channel !== "string" || !CHANNEL.test(input.channel)) throw new Error("INVALID_CHANNEL");
  if (typeof input.device_hash !== "string" || !DEVICE_HASH.test(input.device_hash)) throw new Error("INVALID_DEVICE_HASH");
  return { channel: input.channel, deviceHash: input.device_hash };
}

export function createStatusDocument(operationId: string, writeToken: string, channel: string, deviceHash: string, now = new Date()): StatusDocument {
  if (!OPERATION_ID.test(operationId) || writeToken.length < 24 || !CHANNEL.test(channel) || !DEVICE_HASH.test(deviceHash)) throw new Error("INVALID_SESSION");
  return {
    operationId, writeTokenHash: hash(writeToken), channel, deviceHash,
    phase: "created", progress: 0, message: "update accepted",
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function applyEvent(document: StatusDocument, writeToken: string, rawEvent: unknown, now = new Date()): StatusDocument {
  if (new Date(document.expiresAt).getTime() <= now.getTime()) throw new Error("SESSION_EXPIRED");
  const supplied = Buffer.from(hash(writeToken), "hex");
  const expected = Buffer.from(document.writeTokenHash, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("UNAUTHORIZED");
  if (document.phase === "completed" || document.phase === "failed") throw new Error("SESSION_TERMINAL");
  const event = requireObject(rawEvent);
  if (event.operation_id !== document.operationId) throw new Error("OPERATION_MISMATCH");
  if (typeof event.phase !== "string" || !PHASES.has(event.phase)) throw new Error("INVALID_PHASE");
  if (!Number.isInteger(event.progress) || Number(event.progress) < document.progress || Number(event.progress) > 100) throw new Error("INVALID_PROGRESS");
  if (typeof event.message !== "string" || event.message.length < 1 || event.message.length > 160 || /[\r\n]/.test(event.message)) throw new Error("INVALID_MESSAGE");
  if (event.agent_version !== undefined && (typeof event.agent_version !== "string" || !VERSION.test(event.agent_version))) throw new Error("INVALID_VERSION");
  if ((event.phase === "completed" || event.phase === "failed") && event.progress !== 100) throw new Error("INVALID_TERMINAL_PROGRESS");
  return {
    ...document, phase: event.phase, progress: Number(event.progress), message: event.message,
    agentVersion: event.agent_version as string | undefined, updatedAt: now.toISOString(),
  };
}

export function publicStatus(document: StatusDocument): Record<string, unknown> {
  return {
    operation_id: document.operationId, channel: document.channel, phase: document.phase,
    progress: document.progress, message: document.message, agent_version: document.agentVersion,
    created_at: document.createdAt, updated_at: document.updatedAt, expires_at: document.expiresAt,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
