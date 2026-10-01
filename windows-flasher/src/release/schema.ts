import type { ChannelDocument, WebflashManifest } from "../domain";

export type VerifiedFile = {
  readonly bytes: Uint8Array;
  readonly mode: 384 | 420 | 493;
  readonly target: string;
};

export type VerifiedPackage = {
  readonly manifest: WebflashManifest;
  readonly files: ReadonlyMap<string, VerifiedFile>;
};

export type VerifiedChannel = ChannelDocument;
