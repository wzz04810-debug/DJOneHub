import { describe, expect, it } from "vitest";
import { parsePreflight, runPreflight } from "../src/provisioning/preflight";
import { clearDiagnostics, formatDiagnosticLog } from "../src/diagnostics";

function validPreflight(factoryPid = "721"): string {
  const fields = [
    "uid=0", "arch=armv7l", "kernel=3.18.44", "usb=2c7c:0125",
    `factory_pid=${factoryPid}`, "call=NONE", "available=20971520",
    "functions=diag,serial,ecm,ffs,audio", "agent=none",
    "agent_pid=none", "port_7575=0", "serial_connected=1",
    "cap_busybox=1", "cap_sha256=1", "cap_wget=1", "",
  ].join("\n");
  return `DJONEHUB_PREFLIGHT_BEGIN\n${fields}DJONEHUB_PREFLIGHT_END\n`;
}

describe("device preflight", () => {
  it("accepts only the verified module identity", () => {
    const result = parsePreflight(validPreflight());
    expect(result.platform).toBe("qdc507-armv7-linux-3.18.44");
    expect(result.availableBytes).toBe(20_971_520);
    expect(result).toMatchObject({ agentPid: undefined, port7575Listening: false, serialConnected: true });
  });

  it("reports low free space without applying a package-independent cutoff", () => {
    const result = parsePreflight(validPreflight().replace("available=20971520", "available=8388608"));
    expect(result.availableBytes).toBe(8_388_608);
  });

  it("accepts the verified VID/PID when sysfs uses uppercase hexadecimal", () => {
    clearDiagnostics();
    expect(parsePreflight(validPreflight().replace("usb=2c7c:0125", "usb=2C7C:0125"))).toMatchObject({
      platform: "qdc507-armv7-linux-3.18.44",
    });
    expect(formatDiagnosticLog()).toContain("usb=2C7C:0125");
  });

  it("normalizes the CRLF output used by the previous QDC507 deployer", () => {
    expect(parsePreflight(validPreflight().replaceAll("\n", "\r\n"))).toMatchObject({
      platform: "qdc507-armv7-linux-3.18.44",
    });
  });

  it("ignores CRLF-only blank lines emitted by the module shell", () => {
    const output = validPreflight().replace("arch=armv7l\n", "arch=armv7l\r\n\r\n");
    expect(parsePreflight(output)).toMatchObject({
      platform: "qdc507-armv7-linux-3.18.44",
    });
  });

  it("ignores a reconnect shell banner outside the framed preflight payload", () => {
    clearDiagnostics();
    const output = `root\r\n${validPreflight()}logout\r\n`;

    expect(parsePreflight(output)).toMatchObject({
      platform: "qdc507-armv7-linux-3.18.44",
      installedVersion: undefined,
    });
    expect(formatDiagnosticLog()).toContain("[PREFLIGHT_ENVELOPE] prefix_bytes=6 suffix_bytes=8");
  });

  it("ignores non-field command noise inside the frame while keeping field validation strict", () => {
    clearDiagnostics();
    const output = validPreflight().replace(
      "DJONEHUB_PREFLIGHT_BEGIN\n",
      "DJONEHUB_PREFLIGHT_BEGIN\nroot\r\n",
    );

    expect(parsePreflight(output)).toMatchObject({
      platform: "qdc507-armv7-linux-3.18.44",
      callState: "NONE",
    });
    expect(formatDiagnosticLog()).toContain("[PREFLIGHT_NOISE] lines=1 bytes=6");
  });

  it("maps active calls and bad kernels to stable errors", () => {
    for (const [input, code] of [
      [validPreflight().replace("call=NONE", "call=ACTIVE"), "CALL_ACTIVE"],
      [validPreflight().replace("kernel=3.18.44", "kernel=5.10"), "UNSUPPORTED_PLATFORM"],
    ] as const) {
      try {
        parsePreflight(input);
        expect.unreachable(`expected ${code}`);
      } catch (error) {
        expect(error).toMatchObject({ code });
      }
    }
  });

  it("requires the factory PID to remain unchanged across reads", async () => {
    const outputs = [validPreflight("721"), validPreflight("722")];
    const client = { runShell: async () => outputs.shift()! };
    await expect(runPreflight(client)).rejects.toMatchObject({ code: "FACTORY_SERVICE_UNHEALTHY" });
  });
});
