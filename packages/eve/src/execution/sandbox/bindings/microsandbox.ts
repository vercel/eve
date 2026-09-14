import {
  createMicrosandboxHandle,
  prewarmMicrosandboxTemplate,
} from "#execution/sandbox/bindings/microsandbox-lifecycle.js";
import { enrichMicrosandboxError } from "#execution/sandbox/bindings/microsandbox-create.js";
import {
  microsandboxOptionsForHash,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";
import { createStableHash } from "#execution/sandbox/bindings/microsandbox-runtime.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import type { SandboxProviderImplementation } from "#shared/sandbox-provider.js";

export { pruneMicrosandboxTemplates } from "#execution/sandbox/bindings/microsandbox-templates.js";

export const MICROSANDBOX_PROVIDER_NAME = "microsandbox";

export function createMicrosandboxSandboxProvider(
  createOptions: MicrosandboxSandboxCreateOptions = {},
): SandboxProviderImplementation<undefined, Record<string, unknown>> {
  const options = resolveMicrosandboxOptions(createOptions);
  const optionsHash = createStableHash(JSON.stringify(microsandboxOptionsForHash(options))).slice(
    0,
    20,
  );

  return {
    async prepare(context) {
      try {
        return await prewarmMicrosandboxTemplate({
          context,
          options,
          optionsHash,
          providerName: MICROSANDBOX_PROVIDER_NAME,
        });
      } catch (error) {
        throw enrichMicrosandboxError({
          context: `Failed to prepare microsandbox template "${context.templateName}"`,
          error,
        });
      }
    },
    async getOrCreate(context, prepared) {
      return await createMicrosandboxHandle({
        context,
        prepared,
        options,
        optionsHash,
        providerName: MICROSANDBOX_PROVIDER_NAME,
      });
    },
  };
}
