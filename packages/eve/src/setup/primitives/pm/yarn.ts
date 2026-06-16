import { applyNoProjectConfiguration, resolveStandardInvocation } from "./shared.js";
import type { PackageManagerStrategy } from "./types.js";

export const yarnPackageManager = {
  kind: "yarn",
  scaffoldFiles: {},
  applyProjectConfiguration: applyNoProjectConfiguration,
  devArguments: () => ["eve", "dev"],
  installArguments: () => ["install"],
  prepareArguments: (_projectRoot, args) => args,
  resolveInvocation: (args) => resolveStandardInvocation("yarn", args),
} satisfies PackageManagerStrategy;
