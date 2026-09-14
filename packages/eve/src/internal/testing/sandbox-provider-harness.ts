import {
  createSandboxProviderResources,
  type SandboxDockerfileInput,
  type SandboxPreparedArtifact,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
  type SandboxProviderTags,
} from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export function createSandboxProviderHarness<Options extends object | undefined>(
  implementation: SandboxProviderImplementation<Options, Record<string, unknown>>,
  options: Options,
  harnessOptions: {
    readonly preparedArtifact?: (templateName: string) => SandboxPreparedArtifact;
  } = {},
) {
  const preparedArtifacts = new Map<string, SandboxPreparedArtifact>();
  return {
    async prepare(input: {
      readonly appRoot: string;
      readonly dockerfile?: SandboxDockerfileInput;
      readonly force?: boolean;
      readonly log?: (message: string) => void;
      readonly resourcesKey?: string;
      readonly resourcesPath?: string;
      readonly runPreparation?: (sandbox: SandboxSession) => Promise<void>;
      readonly seedFiles?: readonly {
        readonly content: string | Uint8Array;
        readonly path: string;
      }[];
      readonly templateName: string;
    }) {
      const result = await implementation.prepare({
        appRoot: input.appRoot,
        dockerfile: input.dockerfile,
        force: input.force,
        log: input.log,
        resources: createSandboxProviderResources({
          ...input,
          resourcesKey:
            input.resourcesKey ??
            (input.seedFiles === undefined || input.seedFiles.length === 0
              ? undefined
              : "test-resources"),
        }),
        runPreparation: input.runPreparation ?? (async () => {}),
        templateName: input.templateName,
      });
      preparedArtifacts.set(input.templateName, result.artifact);
      return result;
    },
    async getOrCreate(input: {
      readonly appRoot: string;
      readonly existing?: Record<string, unknown>;
      readonly prepared?: SandboxPreparedArtifact;
      readonly resourcesKey?: string;
      readonly sandboxName: string;
      readonly tags?: SandboxProviderTags;
      readonly templateName: string | null;
    }): Promise<SandboxProviderHandle<Record<string, unknown>>> {
      const prepared =
        input.prepared ??
        (input.templateName === null
          ? undefined
          : (preparedArtifacts.get(input.templateName) ??
            harnessOptions.preparedArtifact?.(input.templateName)));
      const preparedInput =
        input.templateName === null
          ? undefined
          : prepared === undefined
            ? (() => {
                throw new Error(`Missing prepared artifact for template "${input.templateName}".`);
              })()
            : { artifact: prepared, templateName: input.templateName };
      return await implementation.getOrCreate(
        {
          appRoot: input.appRoot,
          existing: input.existing,
          handle: (providerHandle) => providerHandle,
          options,
          resources: createSandboxProviderResources({ resourcesKey: input.resourcesKey }),
          sandboxName: input.sandboxName,
          tags: input.tags,
        },
        preparedInput,
      );
    },
  };
}
