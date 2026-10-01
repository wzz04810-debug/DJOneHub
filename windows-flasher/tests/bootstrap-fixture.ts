import { gzipSync } from "fflate";

const encoder = new TextEncoder();

export type BootstrapFixturePolicy = {
  readonly version: "0.1.0";
  readonly archiveSha256: string;
  readonly archiveSize: number;
  readonly publicKeyBase64: string;
  readonly files: readonly {
    readonly archivePath: string;
    readonly remotePath: string;
    readonly mode: 0o644 | 0o755;
    readonly size: number;
    readonly sha256: string;
  }[];
};

type TarEntry = {
  readonly name: string;
  readonly type: "directory" | "file" | "symlink" | "pax";
  readonly mode: number;
  readonly data?: Uint8Array;
  readonly linkname?: string;
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function octal(value: number, length: number): Uint8Array {
  return encoder.encode(value.toString(8).padStart(length - 1, "0") + "\0");
}

function tar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const payload = entry.data ?? new Uint8Array();
    const header = new Uint8Array(512);
    header.set(encoder.encode(entry.name), 0);
    header.set(octal(entry.mode, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(payload.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header.fill(0x20, 148, 156);
    header[156] = entry.type === "directory" ? 0x35 : entry.type === "symlink" ? 0x32 : entry.type === "pax" ? 0x78 : 0x30;
    if (entry.linkname) header.set(encoder.encode(entry.linkname), 157);
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(header);
    if (entry.type === "file" || entry.type === "pax") {
      blocks.push(payload);
      const padding = (512 - payload.byteLength % 512) % 512;
      if (padding) blocks.push(new Uint8Array(padding));
    }
  }
  blocks.push(new Uint8Array(1024));
  const output = new Uint8Array(blocks.reduce((total, block) => total + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) { output.set(block, offset); offset += block.byteLength; }
  return output;
}

export async function bootstrapFixture(options: {
  readonly extraFile?: boolean;
  readonly badElf?: boolean;
  readonly insecureManifest?: boolean;
  readonly wrongPublicKey?: boolean;
  readonly wrongLink?: boolean;
  readonly paxMetadata?: boolean;
  readonly unsafePaxPath?: boolean;
} = {}): Promise<{ archive: Uint8Array; policy: BootstrapFixturePolicy }> {
  const publicKeyBase64 = "ytpXllvXQ26FCoNhO8rFX0dJKFXYwJaN9uF1L2f2osg=";
  const executable = new Uint8Array(20);
  executable.set([0x7f, 0x45, 0x4c, 0x46, 1, 1]);
  executable[18] = options.badElf ? 62 : 40;
  const config = encoder.encode(JSON.stringify({
    manifest_url: `${options.insecureManifest ? "http" : "https"}://flash.remotepilot.site/api/module-update/manifest`,
    allowed_hosts: ["flash.remotepilot.site"],
    public_key: options.wrongPublicKey ? "A".repeat(44) : publicKeyBase64,
    at_device: "/dev/djonehub_data11",
    success_sms_to_sim_number: true,
  }));
  const files = [
    { archivePath: "etc/djonehub-bootstrap.json", remotePath: "/etc/djonehub-bootstrap.json", mode: 0o644 as const, bytes: config },
    { archivePath: "etc/init.d/djonehub_agent", remotePath: "/etc/init.d/djonehub_agent", mode: 0o755 as const, bytes: encoder.encode("#!/bin/sh\nexit 0\n") },
    { archivePath: "etc/init.d/djonehub_bootstrap", remotePath: "/etc/init.d/djonehub_bootstrap", mode: 0o755 as const, bytes: encoder.encode("#!/bin/sh\nexit 0\n") },
    { archivePath: "usr/lib/djonehub/qdc507_data11_bridge.ko", remotePath: "/usr/lib/djonehub/qdc507_data11_bridge.ko", mode: 0o644 as const, bytes: encoder.encode("ko") },
    { archivePath: "usr/sbin/djonehub-bootstrap", remotePath: "/usr/sbin/djonehub-bootstrap", mode: 0o755 as const, bytes: executable },
  ];
  const directories = ["./", "./usr/", "./etc/", "./etc/init.d/", "./etc/rc5.d/", "./usr/sbin/", "./usr/lib/", "./usr/lib/djonehub/"];
  let entries: TarEntry[] = [
    ...directories.map((name) => ({ name, type: "directory" as const, mode: 0o755 })),
    ...files.map((file) => ({ name: `./${file.archivePath}`, type: "file" as const, mode: file.mode, data: file.bytes })),
    { name: "./etc/rc5.d/S99zzz_djonehub_bootstrap", type: "symlink", mode: 0o755, linkname: options.wrongLink ? "../../evil" : "../init.d/djonehub_bootstrap" },
  ];
  if (options.paxMetadata || options.unsafePaxPath) {
    const concatenate = (parts: readonly Uint8Array[]): Uint8Array => {
      const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
      let offset = 0;
      for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
      return result;
    };
    const paxRecord = (key: string, value: string | Uint8Array): Uint8Array => {
      const valueBytes = typeof value === "string" ? encoder.encode(value) : value;
      let length = key.length + valueBytes.byteLength + 4;
      while (true) {
        const prefix = encoder.encode(`${length} ${key}=`);
        const record = concatenate([prefix, valueBytes, encoder.encode("\n")]);
        if (record.byteLength === length) return record;
        length = record.byteLength;
      }
    };
    const paxName = (name: string): string => {
      const normalized = name.replace(/^\.\//, "").replace(/\/$/, "");
      if (!normalized) return "PaxHeader/currentdir";
      const slash = normalized.lastIndexOf("/");
      const directory = slash < 0 ? "" : normalized.slice(0, slash);
      const base = normalized.slice(slash + 1);
      return `${directory ? `${directory}/` : ""}PaxHeader/${base}`;
    };
    entries = entries.flatMap((entry, index) => [{
      name: paxName(entry.name),
      type: "pax" as const,
      mode: entry.mode,
      data: index === 0 && options.unsafePaxPath
        ? paxRecord("path", "./etc/evil")
        : concatenate([
          paxRecord("mtime", "1788407161.528367724"),
          paxRecord("LIBARCHIVE.xattr.com.apple.provenance", "AQIA6oF8Ztsx95U"),
          paxRecord("SCHILY.xattr.com.apple.provenance", new Uint8Array([1, 2, 0, 0xff, 0x80])),
        ]),
    }, entry]);
  }
  if (options.extraFile) entries.push({ name: "./etc/evil", type: "file", mode: 0o644, data: encoder.encode("evil") });
  const archive = gzipSync(tar(entries), { mtime: 0 });
  const policyFiles = await Promise.all(files.map(async (file) => ({
    archivePath: file.archivePath,
    remotePath: file.remotePath,
    mode: file.mode,
    size: file.bytes.byteLength,
    sha256: await sha256(file.bytes),
  })));
  return {
    archive,
    policy: {
      version: "0.1.0",
      archiveSha256: await sha256(archive),
      archiveSize: archive.byteLength,
      publicKeyBase64,
      files: policyFiles,
    },
  };
}
