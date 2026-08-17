import type {
  PackageManagerInstallResult,
  PackageManagerProcessResult,
} from "#setup/primitives/index.js";

export function packageProcessResult(code = 0): PackageManagerProcessResult {
  return {
    command: { executable: "pnpm", args: ["install"], cwd: "/app" },
    termination: { kind: "exit", code },
    stdout: "",
  };
}

export function packageInstallResult(code = 0): PackageManagerInstallResult {
  return { kind: "installed", result: packageProcessResult(code) };
}
