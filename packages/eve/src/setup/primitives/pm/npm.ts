import { applyNoProjectConfiguration, resolveStandardInvocation } from "./shared.js";
import type { PackageManagerStrategy } from "./types.js";

export const npmPackageManager = {
  kind: "npm",
  scaffoldFiles: {},
  applyProjectConfiguration: applyNoProjectConfiguration,
  devArguments: () => ["exec", "--workspaces=false", "--", "eve", "dev"],
  installArguments: (options) => [
    "install",
    ...(options.ignoreWorkspace === true ? ["--workspaces=false"] : []),
    ...(options.bypassMinimumReleaseAge === true ? ["--min-release-age=0"] : []),
  ],
  prepareArguments: (_projectRoot, args) => args,
  resolveInvocation: (args) => resolveStandardInvocation("npm", args),
} satisfies PackageManagerStrategy;
