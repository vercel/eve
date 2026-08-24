import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type BundledCompiledModuleMapDescriptor,
  validateBundledCompiledArtifactEnvelope,
  validateCompiledModuleMapDescriptorRegistries,
} from "#runtime/loaders/bundled-artifacts.js";

/** Authenticates inert descriptor bytes and every backing before selected loads run. */
export async function withAuthenticatedCompiledModuleMapDescriptor<T>(input: {
  readonly descriptorPath: string;
  readonly descriptorSha256: string;
  readonly diagnostics: unknown;
  readonly manifest: unknown;
  readonly metadata: unknown;
  readonly runtimeAppRoot: string;
  readonly run: (descriptor: BundledCompiledModuleMapDescriptor) => Promise<T> | T;
}): Promise<T> {
  const source = await readFile(input.descriptorPath, "utf8");
  const actualSha256 = createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== input.descriptorSha256) {
    throw new Error(
      `Compiled module-map descriptor digest mismatch: expected "${input.descriptorSha256}", received "${actualSha256}".`,
    );
  }

  const capturedPath = join(
    dirname(input.descriptorPath),
    `.eve-authenticated-descriptor-${actualSha256}-${randomUUID()}.mjs`,
  );
  await writeFile(capturedPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const namespace = (await import(
      `${pathToFileURL(capturedPath).href}?capture=${encodeURIComponent(capturedPath)}`
    )) as {
      readonly createModuleMapDescriptor?: (runtimeAppRoot: string) => unknown;
    };
    if (typeof namespace.createModuleMapDescriptor !== "function") {
      throw new Error(
        "Authenticated compiled module-map descriptor does not export its runtime-root projection factory.",
      );
    }
    const moduleMapDescriptor = namespace.createModuleMapDescriptor(input.runtimeAppRoot);
    const envelope = await validateBundledCompiledArtifactEnvelope({
      diagnostics: input.diagnostics,
      manifest: input.manifest,
      metadata: input.metadata,
      moduleMapDescriptor,
    });
    await validateCompiledModuleMapDescriptorRegistries(envelope.moduleMapDescriptor);
    return await input.run(envelope.moduleMapDescriptor);
  } finally {
    await rm(capturedPath, { force: true });
  }
}
