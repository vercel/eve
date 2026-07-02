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
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
} from "#public/definitions/sandbox-backend.js";
import type {
  MicrosandboxBootstrapUseOptions,
  MicrosandboxCreateOptions,
  MicrosandboxSessionUseOptions,
} from "#public/sandbox/microsandbox-sandbox.js";

export { pruneMicrosandboxTemplates } from "#execution/sandbox/bindings/microsandbox-templates.js";

/**
 * Stable backend name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const MICROSANDBOX_BACKEND_NAME = "microsandbox";

/**
 * Construction input for {@link createMicrosandboxSandboxBackend}.
 * Internal — the public surface is the `microsandbox()` factory
 * under `eve/sandbox`.
 */
export interface CreateMicrosandboxSandboxBackendInput {
  readonly createOptions?: MicrosandboxCreateOptions;
}

/**
 * Creates the microsandbox sandbox backend: lightweight local VMs with
 * snapshot-backed templates, running each command as the
 * `vercel-sandbox` user for parity with hosted Vercel Sandbox.
 */
export function createMicrosandboxSandboxBackend(
  input: CreateMicrosandboxSandboxBackendInput = {},
): SandboxBackend<MicrosandboxBootstrapUseOptions, MicrosandboxSessionUseOptions> {
  const options = resolveMicrosandboxOptions(input.createOptions);
  const optionsHash = createStableHash(JSON.stringify(microsandboxOptionsForHash(options))).slice(
    0,
    20,
  );

  return {
    name: MICROSANDBOX_BACKEND_NAME,
    async prewarm(
      prewarmInput: SandboxBackendPrewarmInput<MicrosandboxBootstrapUseOptions>,
    ): Promise<SandboxBackendPrewarmResult> {
      try {
        return await prewarmMicrosandboxTemplate({
          backendName: MICROSANDBOX_BACKEND_NAME,
          options,
          optionsHash,
          prewarmInput,
        });
      } catch (error) {
        throw enrichMicrosandboxError({
          context: `Failed to prewarm microsandbox template "${prewarmInput.templateKey}"`,
          error,
        });
      }
    },
    async create(
      createInput: SandboxBackendCreateInput,
    ): Promise<SandboxBackendHandle<MicrosandboxSessionUseOptions>> {
      return await createMicrosandboxHandle({
        backendName: MICROSANDBOX_BACKEND_NAME,
        createInput,
        options,
        optionsHash,
      });
    },
  };
}
