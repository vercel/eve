import { access, cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const NEXT_MIDDLEWARE_PATH = "/_middleware";

function resolveMiddlewareFunctionDirectory(
  outputDirectory: string,
  middlewarePath: string,
): string {
  const normalizedPath = posix.normalize(middlewarePath.replace(/^\/+/, ""));

  if (
    normalizedPath.length === 0 ||
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("\\") ||
    normalizedPath.includes("\0")
  ) {
    throw new Error(`Invalid Vercel middlewarePath: ${JSON.stringify(middlewarePath)}.`);
  }

  const functionsDirectory = resolve(outputDirectory, "functions");
  const functionDirectory = resolve(functionsDirectory, `${normalizedPath}.func`);

  if (!functionDirectory.startsWith(`${functionsDirectory}${sep}`)) {
    throw new Error(`Vercel middlewarePath escapes the functions directory: ${middlewarePath}.`);
  }

  return functionDirectory;
}

/**
 * Copies host middleware functions into a generated service Build Output.
 *
 * Vercel validates generated-service routes against each service builder's
 * function map. The host remains the runtime owner of these functions; this
 * copy makes that same opaque Build Output function available while Vercel
 * collects the generated service.
 */
export async function copyHostMiddlewareFunctions(input: {
  readonly hostOutputDirectory: string;
  readonly serviceOutputDirectory: string;
}): Promise<void> {
  let configContents: string;
  try {
    configContents = await readFile(join(input.hostOutputDirectory, "config.json"), "utf8");
  } catch (error) {
    // The host Build Output config need not exist when a generated service
    // builds. A host that writes its config only at the end of its own build
    // (e.g. the Nuxt web service, whose Nitro Vercel preset emits config.json
    // last) may not have produced it when Vercel builds the generated service
    // independently. There is no host middleware to preserve in that case, so
    // skip the copy rather than failing the service build.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const config: unknown = JSON.parse(configContents);

  if (!isRecord(config)) {
    return;
  }

  const middlewarePaths = new Set<string>();

  if (Array.isArray(config.routes)) {
    for (const route of config.routes) {
      if (isRecord(route) && typeof route.middlewarePath === "string") {
        middlewarePaths.add(route.middlewarePath);
      }
    }
  }

  // Local `vercel build` emits the Next middleware function before it adds the
  // corresponding route to config.json. Remote builds have both by this point.
  const nextMiddlewareDirectory = resolveMiddlewareFunctionDirectory(
    input.hostOutputDirectory,
    NEXT_MIDDLEWARE_PATH,
  );
  try {
    await access(nextMiddlewareDirectory);
    middlewarePaths.add(NEXT_MIDDLEWARE_PATH);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  for (const middlewarePath of middlewarePaths) {
    const sourceDirectory = resolveMiddlewareFunctionDirectory(
      input.hostOutputDirectory,
      middlewarePath,
    );
    const destinationDirectory = resolveMiddlewareFunctionDirectory(
      input.serviceOutputDirectory,
      middlewarePath,
    );

    await mkdir(dirname(destinationDirectory), { recursive: true });
    await cp(sourceDirectory, destinationDirectory, {
      force: true,
      recursive: true,
    });
  }
}
