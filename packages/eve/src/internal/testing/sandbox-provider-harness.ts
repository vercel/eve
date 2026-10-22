import { createSandboxProviderFiles } from "#execution/sandbox/provider-files.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import {
  createSandboxProviderResources,
  type SandboxPreparedArtifact,
  type SandboxProviderHandle,
  type LegacySandboxProviderImplementation,
  type SandboxProviderResourceFile,
} from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export function createSandboxProviderHarness<
  Options extends object | undefined,
  PreparedArtifact extends SandboxPreparedArtifact,
  SessionState,
  Session extends SandboxSession,
>(
  implementation: LegacySandboxProviderImplementation<
    Options,
    PreparedArtifact,
    SessionState,
    Session
  >,
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

  function sessionContext(appRoot: string, sandboxName: string) {
    return {
      host: createSandboxProviderHost(appRoot),
      session: {
        auth: { current: null, initiator: null },
        id: sandboxName,
        turn: { id: "test-turn", sequence: 0 },
      },
      storagePath: appRoot,
    } as const;
  }

  const harness = {
    async endSession(input: {
      readonly appRoot: string;
      readonly sandboxName: string;
      readonly state: SessionState | null;
    }): Promise<void> {
      await implementation.onSessionEnd(
        sessionContext(input.appRoot, input.sandboxName),
        input.state,
        { reason: "completed" },
      );
    },
    async prepare(input: {
      readonly appRoot: string;
      readonly log?: (message: string) => void;
      readonly resourcesKey?: string;
      readonly resourcesPath?: string;
      readonly skills?: readonly SandboxProviderResourceFile[];
      readonly sourceRevision?: string;
      readonly workspace?: readonly SandboxProviderResourceFile[];
    }) {
      const hasFiles = (input.skills?.length ?? 0) + (input.workspace?.length ?? 0) > 0;
      const artifact = await implementation.prepare({
        files: createSandboxProviderFiles(`${input.appRoot}/sandbox`),
        host: createSandboxProviderHost(input.appRoot),
        log: input.log,
        resources: createSandboxProviderResources({
          key: input.resourcesKey ?? (hasFiles ? "test-resources" : undefined),
          path: input.resourcesPath,
          skills: input.skills,
          workspace: input.workspace,
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
      const context = sessionContext(input.appRoot, input.sandboxName);
      if (input.existing === undefined) {
        return (await implementation.start(context, options, artifact)).handle;
      }
      return await implementation.resume(context, artifact, input.existing);
    },
    async start(input: {
      readonly appRoot: string;
      readonly options?: Options;
      readonly prepared?: PreparedArtifact;
      readonly sandboxName: string;
    }) {
      const artifact = await resolveArtifact(input);
      return await implementation.start(
        sessionContext(input.appRoot, input.sandboxName),
        input.options ?? options,
        artifact,
      );
    },
  };
  return harness;
}
