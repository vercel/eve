import { applyNoProjectConfiguration, resolveStandardInvocation } from "./shared.js";
import type { PackageManagerStrategy } from "./types.js";

export const bunPackageManager = {
  kind: "bun",
  scaffoldFiles: {},
  applyProjectConfiguration: applyNoProjectConfiguration,
  devArguments: () => ["x", "eve", "dev"],
  installArguments: (options) => [
    "install",
    ...(options.bypassMinimumReleaseAge === true ? ["--minimum-release-age=0"] : []),
  ],
  prepareArguments: (_projectRoot, args) => args,
  resolveInvocation: (args) => resolveStandardInvocation("bun", args),
} satisfies PackageManagerStrategy;
