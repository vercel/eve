import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

interface PackageJson {
  readonly exports?: string | Record<string, unknown>;
}

interface ResolvedModule {
  readonly id: string;
}

interface BundlerPluginContext {
  resolve(source: string, importer?: string): Promise<ResolvedModule | null>;
}

interface BundlerPluginShape {
  readonly name: string;
  buildStart(this: BundlerPluginContext): Promise<void>;
}

function packagePathSegments(packageName: string): string[] {
  return packageName.startsWith("@") ? packageName.split("/", 2) : [packageName];
}

function findPackageJsonPath(appRoot: string, packageName: string): string | undefined {
  const segments = packagePathSegments(packageName);
  let directory = resolve(appRoot);
  const { root } = parse(directory);

  while (true) {
    const candidate = join(directory, "node_modules", ...segments, "package.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (directory === root) {
      return undefined;
    }
    directory = dirname(directory);
  }
}

function resolveTraceSpecifier(packageName: string, packageJson: PackageJson): string | undefined {
  if (packageJson.exports === undefined || typeof packageJson.exports === "string") {
    return packageName;
  }

  const exportKeys = Object.keys(packageJson.exports);
  if (!exportKeys.some((key) => key.startsWith("."))) {
    return packageName;
  }

  const explicitExport = exportKeys.find((key) => key === "." || !key.includes("*"));
  if (explicitExport === undefined) {
    return undefined;
  }

  return explicitExport === "." ? packageName : `${packageName}/${explicitExport.slice(2)}`;
}

/**
 * Seeds Nitro's dependency tracer without emitting or executing an import.
 *
 * `traceDeps` is a filter, not an unconditional trace root. Resolving one
 * exported module from each configured package makes Nitro register the
 * package with nf3; the matching `package*` trace selector then copies every
 * package file, including assets accessed only through runtime filesystem
 * lookup.
 */
export function createExternalDependencyTracePlugin(
  appRoot: string,
  packageNames: readonly string[],
): BundlerPluginShape | null {
  if (packageNames.length === 0) {
    return null;
  }

  return {
    name: "eve-external-dependency-trace-roots",
    async buildStart() {
      for (const packageName of packageNames) {
        const packageJsonPath = findPackageJsonPath(appRoot, packageName);
        if (packageJsonPath === undefined) {
          throw new Error(
            `Could not find external dependency "${packageName}". Add it to the application's dependencies before building.`,
          );
        }

        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
        const traceSpecifier = resolveTraceSpecifier(packageName, packageJson);
        if (traceSpecifier === undefined || (await this.resolve(traceSpecifier)) === null) {
          throw new Error(
            `Could not resolve an exported module for external dependency "${packageName}".`,
          );
        }
      }
    },
  };
}
