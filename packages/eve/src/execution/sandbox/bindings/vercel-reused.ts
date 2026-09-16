import { createHash } from "node:crypto";

import {
  createVercelImageSandboxProviderImplementation,
  type CreateVercelImageProviderInput,
  type VercelImagePreparedArtifact,
} from "#execution/sandbox/bindings/vercel-image.js";
import type { ExperimentalVercelReusedImageEnvironmentOptions } from "#public/sandbox/vercel-reused-sandbox.js";
import type {
  NoSandboxProviderMetadata,
  SandboxProviderImplementation,
} from "#shared/sandbox-provider.js";

export const VERCEL_REUSED_IMAGE_PROVIDER_NAME = "vercel-reused-image";

export function createVercelReusedImageSandboxProvider(
  environmentOptions: ExperimentalVercelReusedImageEnvironmentOptions,
  input: CreateVercelImageProviderInput = {},
): SandboxProviderImplementation<
  undefined,
  NoSandboxProviderMetadata,
  VercelImagePreparedArtifact
> {
  const { key, ...createOptions } = environmentOptions;
  if (key.trim().length === 0) throw new Error("Reused Vercel sandbox keys must be non-empty.");
  return createVercelImageSandboxProviderImplementation(createOptions, input, {
    providerName: VERCEL_REUSED_IMAGE_PROVIDER_NAME,
    resolveRuntimeOptions: () => ({}),
    resolveSandboxName: (_context, source) => reusedSandboxName(key, source.templateName),
    ownsNativeSandbox: false,
  });
}

function reusedSandboxName(key: string, templateName: string): string {
  const identity = createHash("sha256").update(`${key}:${templateName}`).digest("hex").slice(0, 32);
  return `eve-sbx-reuse-${identity}`;
}
