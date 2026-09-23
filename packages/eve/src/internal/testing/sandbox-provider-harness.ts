import { createSandboxProviderFiles } from "#execution/sandbox/provider-files.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import {
  createSandboxProviderResources,
  type SandboxPreparedArtifact,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
} from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export function createSandboxProviderHarness<
  Options extends object | undefined,
  PreparedArtifact extends SandboxPreparedArtifact,
  SessionState,
  Session extends SandboxSession,
>(
  implementation: SandboxProviderImplementation<Options, PreparedArtifact, SessionState, Session>,
  options: Options,
  harnessOptions: {
    readonly preparedArtifact?: () => PreparedArtifact;
  } = {},
) {
  let preparedArtifact: PreparedArtifact | undefined;
  async function resolveArtifact(input: {
    readonly appRoot: string;
    readonly prepared?: PreparedArtifact;
  }): Promise<PreparedArtifact> {
    return (
      input.prepared ??
      preparedArtifact ??
      harnessOptions.preparedArtifact?.() ??
      (await harness.prepare({ appRoot: input.appRoot }))
    );
  }

  const harness = {
    async prepare(input: {
      readonly appRoot: string;
      readonly log?: (message: string) => void;
      readonly resourcesKey?: string;
      readonly resourcesPath?: string;
      readonly seedFiles?: readonly {
        readonly content: string | Uint8Array;
        readonly path: string;
      }[];
      readonly sourceRevision?: string;
    }) {
      const artifact = await implementation.prepare({
        files: createSandboxProviderFiles(`${input.appRoot}/sandbox`),
        host: createSandboxProviderHost(input.appRoot),
        log: input.log,
        resources: createSandboxProviderResources({
          ...input,
          resourcesKey:
            input.resourcesKey ??
            (input.seedFiles === undefined || input.seedFiles.length === 0
              ? undefined
              : "test-resources"),
        }),
        sourceRevision: input.sourceRevision ?? "test-source-revision",
        storagePath: input.appRoot,
      });
      preparedArtifact = artifact;
      return artifact;
    },
    async openSession(input: {
      readonly appRoot: string;
      readonly existing?: SessionState;
      readonly prepared?: PreparedArtifact;
      readonly sandboxName: string;
    }): Promise<SandboxProviderHandle<Session>> {
      const artifact = await resolveArtifact(input);
      const context = {
        host: createSandboxProviderHost(input.appRoot),
        session: {
          auth: { current: null, initiator: null },
          id: input.sandboxName,
          turn: { id: "test-turn", sequence: 0 },
        },
        storagePath: input.appRoot,
      } as const;
      if (input.existing === undefined) {
        return (await implementation.start(context, options, artifact)).handle;
      }
      return await implementation.resume(context, artifact, input.existing);
    },
    async start(input: {
      readonly appRoot: string;
      readonly prepared?: PreparedArtifact;
      readonly sandboxName: string;
    }) {
      const artifact = await resolveArtifact(input);
      return await implementation.start(
        {
          host: createSandboxProviderHost(input.appRoot),
          session: {
            auth: { current: null, initiator: null },
            id: input.sandboxName,
            turn: { id: "test-turn", sequence: 0 },
          },
          storagePath: input.appRoot,
        },
        options,
        artifact,
      );
    },
  };
  return harness;
}
