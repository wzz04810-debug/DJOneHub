export type DiagnosticLevel = "info" | "warn" | "error";

export type DiagnosticEntry = {
  readonly sequence: number;
  readonly timestamp: number;
  readonly level: DiagnosticLevel;
  readonly code: string;
  readonly message: string;
};

const MAX_ENTRIES = 1000;
const listeners = new Set<(entry: DiagnosticEntry) => void>();
const history: DiagnosticEntry[] = [];
let nextSequence = 1;

function redact(value: string): string {
  return value
    .replace(/\b(serial|imei|imsi|iccid|phone|sim)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\d{7,}/g, "[REDACTED]");
}

function time(value: number): string {
  return new Date(value).toISOString().slice(11, 23);
}

export function diagnostic(
  code: string,
  message: string,
  level: DiagnosticLevel = "info",
): void {
  const entry: DiagnosticEntry = {
    sequence: nextSequence++,
    timestamp: Date.now(),
    level,
    code: redact(code).replace(/[^A-Z0-9_-]/gi, "_").slice(0, 48),
    message: redact(message).slice(0, 500),
  };
  history.push(entry);
  while (history.length > MAX_ENTRIES) {
    const oldestInfo = history.findIndex((candidate) => candidate.level === "info");
    history.splice(oldestInfo >= 0 ? oldestInfo : 0, 1);
  }
  for (const listener of listeners) {
    try { listener(entry); } catch { /* diagnostics must never interrupt flashing */ }
  }
}

export function subscribeDiagnostics(listener: (entry: DiagnosticEntry) => void): () => void {
  listeners.add(listener);
  for (const entry of history) {
    try { listener(entry); } catch { /* diagnostics must never interrupt flashing */ }
  }
  return () => listeners.delete(listener);
}

export function formatDiagnosticLog(): string {
  return history.map((entry) =>
    `${time(entry.timestamp)} ${entry.level.toUpperCase()} [${entry.code}] ${entry.message}`,
  ).join("\n");
}

export function clearDiagnostics(): void {
  history.length = 0;
  nextSequence = 1;
}
