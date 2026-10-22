import { resolve } from "node:path";

import { createSandboxPrepareContext } from "#execution/sandbox/prewarm.js";
import { createSandboxProviderFiles } from "#execution/sandbox/provider-files.js";
import { createConnectionSession } from "#execution/sandbox/session.js";
import { isToolSessionId } from "#execution/tool-session/id.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type {
  SandboxConnection,
  SandboxJson,
  SandboxPrepareContext,
  SandboxProviderImplementation,
  SandboxSessionContext,
  SandboxSessionEndOptions,
} from "#sandbox/provider.js";
import {
  getSandboxEnvironmentRuntime,
  type SandboxEnvironmentIdentity,
} from "#shared/sandbox-environment.js";
import type { SandboxProviderResourceFile } from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/**
 * Drives the lifecycle an environment's provider implements the way core
 * does, with eve's prepare context and derived session, without a runtime.
 * The type parameters name what the provider returns, which the environment
 * erases.
 */
export function createSandboxEnvironmentHarness<
  Options extends object | undefined = object | undefined,
  Artifact extends SandboxJson = SandboxJson,
  State extends SandboxJson = SandboxJson,
  Session extends SandboxSession = SandboxSession,
>(
  environment: SandboxEnvironmentIdentity,
  options?: Options,
  harnessOptions: { readonly preparedArtifact?: () => Artifact } = {},
) {
  const runtime = getSandboxEnvironmentRuntime(environment);
  const implementation = runtime.implementation as SandboxProviderImplementation<
    Options,
    Artifact,
    State,
    object
  >;
  let preparedArtifact: Artifact | undefined;
  async function resolveArtifact(input: {
    readonly appRoot: string;
    readonly prepared?: Artifact;
  }): Promise<Artifact> {
    return (
      input.prepared ??
      preparedArtifact ??
      harnessOptions.preparedArtifact?.() ??
      (await harness.prepare({ appRoot: input.appRoot }))
    );
  }

  function sessionContext(appRoot: string, sandboxName: string): SandboxSessionContext {
    return {
      kind: isToolSessionId(sandboxName) ? "tool-session" : "session",
      resolveProjectPath: (path) => resolve(appRoot, path),
      session: {
        auth: { current: null, initiator: null },
        id: sandboxName,
        turn: { id: "test-turn", sequence: 0 },
      },
      storagePath: appRoot,
    };
  }

  function opened(connection: SandboxConnection<object>) {
    return { connection, sandbox: createConnectionSession(connection) as Session };
  }

  const harness = {
    async endSession(
      input: {
        readonly appRoot: string;
        readonly sandboxName: string;
        readonly state: State | null;
      } & Partial<SandboxSessionEndOptions>,
    ): Promise<void> {
      await implementation.onSessionEnd(
        sessionContext(input.appRoot, input.sandboxName),
        input.state,
        {
          abortSignal: input.abortSignal,
          reason: input.reason ?? "completed",
        },
      );
    },
    async prepare(input: {
      readonly appRoot: string;
      readonly log?: (message: string) => void;
      readonly resourcesKey?: string;
      readonly resourcesPath?: string;
      readonly skills?: readonly SandboxProviderResourceFile[];
      readonly sourceRevision?: string;
      readonly storagePath?: string;
      readonly workspace?: readonly SandboxProviderResourceFile[];
    }): Promise<Artifact> {
      const hasFiles = (input.skills?.length ?? 0) + (input.workspace?.length ?? 0) > 0;
      const artifact = await implementation.prepare(
        createSandboxPrepareContext({
          appRoot: input.appRoot,
          files: createSandboxProviderFiles(`${input.appRoot}/sandbox`),
          log: input.log ?? (() => {}),
          provider: runtime,
          resources: {
            key: input.resourcesKey ?? (hasFiles ? "test-resources" : undefined),
            path: input.resourcesPath,
            skills: input.skills,
            workspace: input.workspace,
          },
          sourceRevision: input.sourceRevision ?? "test-source-revision",
          storagePath: input.storagePath ?? input.appRoot,
        }),
      );
      preparedArtifact = artifact;
      return artifact;
    },
    /** Resumes `existing` when given, or else starts the session's sandbox. */
    async openSession(input: {
      readonly appRoot: string;
      readonly existing?: State;
      readonly prepared?: Artifact;
      readonly sandboxName: string;
    }) {
      if (input.existing === undefined) return await harness.start(input);
      const artifact = await resolveArtifact(input);
      const context = sessionContext(input.appRoot, input.sandboxName);
      return opened(await implementation.resume(context, artifact, input.existing));
    },
    async start(input: {
      readonly appRoot: string;
      readonly options?: Options;
      readonly prepared?: Artifact;
      readonly sandboxName: string;
    }) {
      const artifact = await resolveArtifact(input);
      const { connection, state } = await implementation.start(
        sessionContext(input.appRoot, input.sandboxName),
        input.options ?? options,
        artifact,
      );
      return { ...opened(connection), state };
    },
  };
  return harness;
}

/**
 * Runs `ctx.populate()` against an in-memory sandbox whose home is
 * `/home/agent`, and returns the paths it wrote in order.
 */
export async function populatedPaths(context: SandboxPrepareContext): Promise<string[]> {
  const sandbox = mockSandbox({
    commands: { [`printf '%s\\n' "$HOME"`]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" } },
  });
  await context.populate(sandbox.connection);
  return sandbox.writes.map((write) => write.path);
}
