export type BootstrapFilePolicy = {
  readonly archivePath: string;
  readonly remotePath: string;
  readonly mode: 0o644 | 0o755;
  readonly size: number;
  readonly sha256: string;
};

export type BootstrapReleasePolicy = {
  readonly version: string;
  readonly archiveSha256: string;
  readonly archiveSize: number;
  readonly publicKeyBase64: string;
  readonly files: readonly BootstrapFilePolicy[];
};

export const BOOTSTRAP_RELEASE_POLICY: BootstrapReleasePolicy = {
  version: "0.1.0",
  archiveSha256: "861c70221a8df78317d399feb700dd1f10cc46cd1722d59171a700cac08d3b7c",
  archiveSize: 2_643_087,
  publicKeyBase64: "ytpXllvXQ26FCoNhO8rFX0dJKFXYwJaN9uF1L2f2osg=",
  files: [
    { archivePath: "etc/djonehub-bootstrap.json", remotePath: "/etc/djonehub-bootstrap.json", mode: 0o644, size: 984, sha256: "41e511c2d11082fed3cee5a699f0506406879a191eaeba6d5c42e40ec4c19238" },
    { archivePath: "etc/init.d/djonehub_agent", remotePath: "/etc/init.d/djonehub_agent", mode: 0o755, size: 16_118, sha256: "f21fc908eef074936a313e38bc9af236677a68f18eded1a65c48c960f9c5d524" },
    { archivePath: "etc/init.d/djonehub_bootstrap", remotePath: "/etc/init.d/djonehub_bootstrap", mode: 0o755, size: 1_512, sha256: "088dcde0d80574e6234d8c614f68503e104641c192b3a6bd3a802961ad4f2e2b" },
    { archivePath: "usr/lib/djonehub/qdc507_data11_bridge.ko", remotePath: "/usr/lib/djonehub/qdc507_data11_bridge.ko", mode: 0o644, size: 8_748, sha256: "007dca148bb2a020f304696d8ec898511245036a6bd6cebf97fefe67b713065b" },
    { archivePath: "usr/sbin/djonehub-bootstrap", remotePath: "/usr/sbin/djonehub-bootstrap", mode: 0o755, size: 6_357_140, sha256: "9e59a8af037c07ab54d8032337c48445dd4024bc6a00afea915eb8d10c814369" },
  ],
};
