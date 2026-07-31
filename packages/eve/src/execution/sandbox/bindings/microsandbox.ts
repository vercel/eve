import {
  createMicrosandboxResource,
  prewarmMicrosandboxTemplate,
  referenceMicrosandboxResource,
  type MicrosandboxReference,
  type MicrosandboxResource,
  type MicrosandboxTemplateReference,
} from "#execution/sandbox/bindings/microsandbox-lifecycle.js";
import { enrichMicrosandboxError } from "#execution/sandbox/bindings/microsandbox-create.js";
import {
  decodeMicrosandboxCreateOptions,
  microsandboxOptionsForHash,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";
import { createStableHash } from "#execution/sandbox/bindings/microsandbox-runtime.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import { parseJsonObject } from "#shared/json.js";
import type { SandboxProviderContext } from "#shared/sandbox-value.js";

export { pruneMicrosandboxTemplates } from "#execution/sandbox/bindings/microsandbox-templates.js";

/**
 * Stable provider name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const MICROSANDBOX_PROVIDER = "microsandbox";

export type {
  MicrosandboxReference,
  MicrosandboxResource,
  MicrosandboxTemplateReference,
} from "#execution/sandbox/bindings/microsandbox-lifecycle.js";

export interface CreateMicrosandboxSandboxProviderInput {
  readonly createOptions?: MicrosandboxSandboxCreateOptions;
}

export interface MicrosandboxSandboxProvider {
  create(input: {
    readonly context: SandboxProviderContext;
    readonly reference?: MicrosandboxReference;
    readonly template?: MicrosandboxTemplateReference;
  }): Promise<MicrosandboxResource>;
  prewarm(input: {
    readonly appRoot: string;
    readonly log?: (message: string) => void;
    readonly prepare: (resource: MicrosandboxResource) => Promise<void>;
    readonly templateId: string;
  }): Promise<MicrosandboxTemplateReference>;
}

export function createMicrosandboxSandboxProvider(
  input: CreateMicrosandboxSandboxProviderInput = {},
): MicrosandboxSandboxProvider {
  const options = resolveMicrosandboxOptions(input.createOptions);
  const configuration = parseJsonObject(input.createOptions ?? {});
  const optionsHash = createStableHash(JSON.stringify(microsandboxOptionsForHash(options))).slice(
    0,
    20,
  );

  return {
    async prewarm(prewarmInput): Promise<MicrosandboxTemplateReference> {
      try {
        return await prewarmMicrosandboxTemplate({
          appRoot: prewarmInput.appRoot,
          configuration,
          log: prewarmInput.log,
          provider: MICROSANDBOX_PROVIDER,
          options,
          optionsHash,
          prepare: prewarmInput.prepare,
          templateId: prewarmInput.templateId,
        });
      } catch (error) {
        throw enrichMicrosandboxError({
          context: `Failed to prewarm microsandbox template "${prewarmInput.templateId}"`,
          error,
        });
      }
    },
    async create(createInput): Promise<MicrosandboxResource> {
      return await createMicrosandboxResource({
        context: createInput.context,
        provider: MICROSANDBOX_PROVIDER,
        configuration,
        options,
        optionsHash,
        reference: createInput.reference,
        template: createInput.template,
      });
    },
  };
}

export { referenceMicrosandboxResource };

export async function restoreMicrosandboxResource(
  reference: MicrosandboxReference,
  context: SandboxProviderContext,
): Promise<MicrosandboxResource> {
  return await createMicrosandboxSandboxProvider({
    createOptions: decodeMicrosandboxCreateOptions(reference.configuration),
  }).create({ context, reference });
}
