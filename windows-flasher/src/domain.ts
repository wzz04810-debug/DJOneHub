export const USB_VENDOR_ID = 0x2c7c;
export const USB_PRODUCT_ID = 0x0125;
export const ADB_INTERFACE = {
  classCode: 0xff,
  subclassCode: 0x42,
  protocolCode: 0x01,
} as const;
export const MODULE_PLATFORM = "qdc507-armv7-linux-3.18.44";

export type FlashErrorCode =
  | "UNSUPPORTED_BROWSER"
  | "INSECURE_CONTEXT"
  | "USB_PERMISSION_CANCELLED"
  | "USB_INTERFACE_BUSY"
  | "USB_DISCONNECTED"
  | "ADB_AUTH_REQUIRED"
  | "UNSUPPORTED_DEVICE"
  | "UNSUPPORTED_PLATFORM"
  | "CALL_ACTIVE"
  | "FACTORY_SERVICE_UNHEALTHY"
  | "INSUFFICIENT_SPACE"
  | "SPACE_CHECK_FAILED"
  | "DOWNLOAD_FAILED"
  | "SIGNATURE_INVALID"
  | "PACKAGE_INVALID"
  | "DOWNGRADE_BLOCKED"
  | "REPAIR_REQUIRED"
  | "INSTALL_FAILED"
  | "ROLLBACK_UNCONFIRMED"
  | "HEALTH_CHECK_FAILED"
  | "CANCELLED";

export class FlashError extends Error {
  readonly code: FlashErrorCode;

  constructor(code: FlashErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FlashError";
    this.code = code;
  }
}

export type WorkflowStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21;

type WorkflowProgress = {
  readonly step?: WorkflowStep;
  readonly detail?: string;
};

export type FlashState = WorkflowProgress & (
  | { phase: "environment" }
  | { phase: "awaiting-device" }
  | { phase: "preflight" }
  | { phase: "planning" }
  | { phase: "downloading"; received: number; total?: number }
  | { phase: "verifying-package" }
  | { phase: "uploading"; file: string; sent: number; total: number }
  | { phase: "installing"; stage: string }
  | { phase: "waiting-reconnect"; deadline: number }
  | { phase: "verifying-device" }
  | { phase: "completed"; version: string }
  | { phase: "failed"; code: FlashErrorCode; message: string }
);

export function isTerminalState(state: FlashState): boolean {
  return state.phase === "completed" || state.phase === "failed";
}

export interface ChannelDocument {
  readonly format_version: 1;
  readonly channel: "stable";
  readonly version: string;
  readonly platform: typeof MODULE_PLATFORM;
  readonly asset_url: string;
  readonly sha256: string;
  readonly size: number;
  readonly published_at: string;
}

export interface WebflashManifestFile {
  readonly name: string;
  readonly archive_path: string;
  readonly target: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: 384 | 420 | 493;
}

export interface WebflashManifest {
  readonly format_version: 1;
  readonly version: string;
  readonly platform: typeof MODULE_PLATFORM;
  readonly files: readonly WebflashManifestFile[];
}

export interface ProvisioningEvent {
  readonly state: FlashState;
  readonly timestamp: number;
  readonly detail?: string;
}
