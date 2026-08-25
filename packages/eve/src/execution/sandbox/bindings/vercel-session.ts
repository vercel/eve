import type { VercelEgressAuth } from "#execution/sandbox/bindings/vercel-egress-auth.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { isAuthorizationInterrupt } from "#harness/authorization-interrupt.js";
import { resolveVercelEgressPolicy } from "#execution/sandbox/bindings/vercel-egress-auth.js";
import {
  clearVercelEgressDemandMarkers,
  readVercelEgressDemandedRuleIds,
} from "#execution/sandbox/bindings/vercel-egress-demand.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import type { SandboxBackendHandle } from "#public/definitions/sandbox-backend.js";
import type { TokenResult } from "#runtime/connections/types.js";
import type { VercelSandboxSessionUseOptions } from "#public/sandbox/vercel-sandbox.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

export function createVercelSandboxHandle(
  sandbox: VercelSandbox,
  sessionKey: string,
  egressAuth: VercelEgressAuth | undefined,
  brokeredPolicy: SandboxNetworkPolicy | undefined,
  initialCredentials: ReadonlyMap<string, TokenResult> = new Map(),
  demandToken?: string,
): SandboxBackendHandle<VercelSandboxSessionUseOptions> {
  let credentials = new Map(initialCredentials);
  const onRequestRuleIds =
    egressAuth === undefined
      ? []
      : [...egressAuth.rules.values()]
          .filter((rule) => rule.credentialResolution === "on-request")
          .map((rule) => rule.id);
  const settleDemand =
    egressAuth === undefined || onRequestRuleIds.length === 0
      ? undefined
      : async (): Promise<void> => {
          const demanded = await readVercelEgressDemandedRuleIds(
            sandbox,
            onRequestRuleIds,
            demandToken,
          );
          if (demanded.length === 0) return;
          const unresolved = demanded.filter((ruleId) => !credentials.has(ruleId));
          if (unresolved.length === 0) {
            await clearVercelEgressDemandMarkers(sandbox, demanded);
            return;
          }
          let resolved;
          try {
            resolved = await resolveVercelEgressPolicy(
              egressAuth,
              sessionKey,
              unresolved,
              sandbox.name,
              demandToken,
            );
          } catch (error) {
            // Interactive authorization parks the step. The demand markers
            // survive so the resumed step's handle creation activates the
            // approved credential before the model re-runs the command.
            if (isAuthorizationInterrupt(error)) throw error;
            await sandbox.update({
              networkPolicy: egressAuth.buildPolicy(credentials, sandbox.name, demandToken),
            });
            await clearVercelEgressDemandMarkers(sandbox, unresolved);
            throw error;
          }
          credentials = new Map([...credentials, ...resolved.credentials]);
          await sandbox.update({
            networkPolicy: egressAuth.buildPolicy(credentials, sandbox.name, demandToken),
          });
          await clearVercelEgressDemandMarkers(sandbox, unresolved);
          if (resolved.unresolvedRuleIds.length > 0) {
            throw new Error(
              "Sandbox credentials remained unavailable for on-request rules: " +
                `${formatVercelEgressRuleList(egressAuth, resolved.unresolvedRuleIds)}.`,
            );
          }
        };
  return {
    session: buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, sessionKey, settleDemand),
      createVercelNetworkPolicySetter(sandbox, onRequestRuleIds.length > 0),
    ),
    useSessionFn: async (options?: VercelSandboxSessionUseOptions) => {
      if (options !== undefined) {
        if (egressAuth !== undefined && options.networkPolicy !== undefined) {
          throw new Error(
            "vercel(): `onSession` cannot replace `networkPolicy` when managed `auth` rules exist.",
          );
        }
        await sandbox.update(options);
      }
      if (brokeredPolicy !== undefined) {
        await sandbox.update({ networkPolicy: brokeredPolicy });
      }
      return buildSandboxSession(
        createVercelInternalSandboxSession(sandbox, sessionKey, settleDemand),
        createVercelNetworkPolicySetter(sandbox, onRequestRuleIds.length > 0),
      );
    },
    async captureState() {
      const metadata: Record<string, unknown> = { sandboxName: sandbox.name };
      if (demandToken !== undefined) metadata.demandToken = demandToken;
      return {
        backendName: "vercel",
        metadata,
        sessionKey,
      };
    },
    async stop() {
      await stopVercelSandbox(sandbox);
    },
    async shutdown() {
      try {
        await stopVercelSandbox(sandbox);
      } catch {
        // Provider-side timeout is the backstop when the sandbox is unreachable.
      }
    },
    async revokeStepCredentials() {
      if (egressAuth !== undefined) {
        await sandbox.update({ networkPolicy: egressAuth.clearedPolicy });
      }
    },
  };
}

export function formatVercelEgressRuleList(
  egressAuth: VercelEgressAuth,
  ruleIds: readonly string[],
): string {
  return ruleIds
    .map((ruleId) => {
      const domain = egressAuth.rules.get(ruleId)?.domain;
      return domain === undefined ? ruleId : `"${domain}" (${ruleId})`;
    })
    .join(", ");
}

async function stopVercelSandbox(sandbox: VercelSandbox): Promise<void> {
  if (sandbox.status !== "running" && sandbox.status !== "pending") {
    return;
  }
  await sandbox.stop();
}

export function createVercelInternalSandboxSession(
  sandbox: VercelSandbox,
  id: string,
  settleDemand?: () => Promise<void>,
): InternalSandboxSession {
  return {
    id,
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const command = await sandbox.runCommand({
        args: ["-lc", options.command],
        cmd: "bash",
        cwd: options.workingDirectory ?? WORKSPACE_ROOT,
        detached: true,
        env: options.env,
        signal: options.abortSignal,
      });
      const process = adaptMultiplexedCommandToSandboxProcess({
        command,
        getOutput: (log) => log.stream,
      });
      if (settleDemand === undefined) return process;
      // A blocked request already failed inside the command (the egress proxy
      // answered 428), so the command exits on its own. One post-exit check
      // resolves the demanded credential — or raises the standard
      // authorization interrupt — and the model re-runs what it needs to.
      return {
        ...process,
        async wait() {
          const result = await process.wait();
          await settleDemand();
          return result;
        },
      };
    },
    async readFile(options: SandboxReadFileOptions) {
      return normalizeVercelReadStream(await sandbox.readFile({ path: options.path }));
    },
    async writeFile(options: SandboxWriteFileOptions) {
      const bytes = await streamToBuffer(options.content);
      await sandbox.writeFiles([{ content: bytes, path: options.path }]);
    },
    async removePath(options: SandboxRemovePathOptions) {
      await sandbox.fs.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
  };
}

export function createVercelNetworkPolicySetter(
  sandbox: VercelSandbox,
  managedOnRequest = false,
): (policy: SandboxNetworkPolicy) => Promise<void> {
  return async (policy) => {
    if (managedOnRequest) {
      throw new Error(
        "vercel(): `setNetworkPolicy()` cannot replace a policy with on-request `auth` rules.",
      );
    }
    await sandbox.update({ networkPolicy: policy });
  };
}

function resolveVercelSandboxPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}
