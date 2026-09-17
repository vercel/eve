import type { EveCliSetupFailureCode } from "#cli/telemetry/index.js";
import type { PackageManagerKind } from "#setup/package-manager.js";
import { type PackageManagerInstallResult } from "#setup/primitives/index.js";
import type { ProcessOutputLine } from "#setup/primitives/process-output.js";

export function installProgressDetail(
  packageManager: PackageManagerKind,
  line: ProcessOutputLine,
): string | undefined {
  const text = line.text.trim();
  if (text === "" || packageManager !== "npm") return text || undefined;

  const manifest = /^npm silly fetch manifest (.+)$/u.exec(text);
  if (manifest !== null) return `Resolving ${manifest[1]}`;

  const failedRequest = /^npm http fetch \S+ \S+ attempt (\d+) failed with (\S+)$/u.exec(text);
  if (failedRequest !== null) {
    return `npm registry · attempt ${failedRequest[1]} failed: ${failedRequest[2]}`;
  }

  if (line.stream === "stdout" || /^npm (?:error|warn)\b/u.test(text)) return text;
  return undefined;
}

export const NPM_NOISE_LINE = /^\s*npm (?:silly|verbose|http|timing)\b/u;
export const INSTALL_OUTPUT_FALLBACK_LINES = 20;

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
