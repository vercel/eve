import type { EveCliSetupFailureCode } from "#cli/telemetry/index.js";
import { type PackageManagerInstallResult } from "#setup/primitives/index.js";
import { sanitizeForTerminal } from "#cli/ui/output.js";

const NPM_NOISE_LINE = /^\s*npm (?:silly|verbose|http|timing)\b/u;
const INSTALL_OUTPUT_MAX_LINES = 20;
const INSTALL_OUTPUT_MAX_BYTES = 16 * 1_024;

/** Keeps a bounded error tail, falling back to npm detail only when no other output exists. */
export function createInstallDiagnostics() {
  const lines: string[] = [];
  let bytes = 0;
  let hasUsefulOutput = false;
  let truncated = false;

  return {
    append(text: string): void {
      let line = sanitizeForTerminal(text).trimEnd();
      if (line.trim() === "") return;
      const noise = NPM_NOISE_LINE.test(line);
      if (noise && hasUsefulOutput) return;
      if (!noise && !hasUsefulOutput) {
        lines.length = 0;
        bytes = 0;
        truncated = false;
        hasUsefulOutput = true;
      }

      const encoded = Buffer.from(line);
      if (encoded.length >= INSTALL_OUTPUT_MAX_BYTES) {
        let start = encoded.length - INSTALL_OUTPUT_MAX_BYTES + 1;
        // Keep complete UTF-8 code points while reserving one byte for the newline.
        while ((encoded[start]! & 0xc0) === 0x80) start += 1;
        line = encoded.subarray(start).toString("utf8");
        truncated = true;
      }
      lines.push(line);
      bytes += Buffer.byteLength(line) + 1;
      while (lines.length > INSTALL_OUTPUT_MAX_LINES || bytes > INSTALL_OUTPUT_MAX_BYTES) {
        bytes -= Buffer.byteLength(lines.shift()!) + 1;
        truncated = true;
      }
    },
    result(): { lines: readonly string[]; truncated: boolean } {
      return { lines, truncated };
    },
  };
}

export function packageManagerInstallFailureCode(
  result: PackageManagerInstallResult,
): EveCliSetupFailureCode {
  if (result.kind === "workspace-probe-failed") return "workspace_probe_failed";
  if (result.kind === "workspace-probe-unrecognized") return "workspace_probe_unrecognized";
  if (result.result.termination.kind !== "spawn-error") return "dependency_installation";
  return result.result.termination.code === "ENOENT"
    ? "package_manager_not_found"
    : "package_manager_start_failed";
}
