import type { SandboxSession } from "eve/sandbox";
import type { SandboxProviderHandle } from "eve/sandbox/provider";

import type { EveGhImplementation } from "./eve-gh-sandbox.ts";
import { requireState, type EveGhSessionContext, type EveGhSessionState } from "./eve-gh-state.ts";

interface DevboxAuth {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
}

/** Use Devbox's owner credential exchange without installing its agent daemon. */
export function withDevboxCredentials(
  provider: EveGhImplementation,
  resolveAuth: (context: EveGhSessionContext) => DevboxAuth,
  send: typeof fetch = globalThis.fetch,
): EveGhImplementation {
  async function attach(
    handle: SandboxProviderHandle,
    state: EveGhSessionState,
    auth: DevboxAuth,
  ): Promise<{ handle: SandboxProviderHandle; state: EveGhSessionState }> {
    const previousId = state.devboxId;
    let devboxId = previousId;
    const request = async (path: string, body?: unknown) => {
      let response: Response;
      try {
        response = await send(`https://api.vercel.com${path}`, {
          method: body === undefined ? "DELETE" : "POST",
          headers: {
            authorization: `Bearer ${auth.token}`,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new Error("Devbox credential request failed.");
      }
      if (body === undefined && response.status === 404) return {};
      if (!response.ok) throw new Error(`Devbox credential request failed (${response.status}).`);
      try {
        return (await response.json()) as Record<string, unknown>;
      } catch {
        throw new Error("Invalid Devbox credential response.");
      }
    };
    const remove = () => request(`/v1/devbox/${encodeURIComponent(devboxId!)}`);
    try {
      const setupBody: Record<string, unknown> = {
        sandboxId: state.sandboxName,
        projectId: auth.projectId,
      };
      if (devboxId) setupBody.devboxId = devboxId;
      setupBody.skipDevboxdInstall = true;
      const setup = await request(
        `/v1/devbox/setup?teamId=${encodeURIComponent(auth.teamId)}`,
        setupBody,
      );
      devboxId = requiredString(setup, "id");
      const registrationToken = requiredString(setup, "registrationToken");
      if (previousId && devboxId !== previousId) throw new Error("Devbox identity changed.");
      const credentials = await request("/v1/devbox/register", { devboxId, registrationToken });
      const vercelToken = requiredString(credentials, "vercelToken");
      if (typeof credentials.gitOauthToken !== "string" || !credentials.gitOauthToken) {
        throw new Error("Connect GitHub in your Vercel account's Login Connections, then retry.");
      }
      const env = {
        VERCEL_TOKEN: vercelToken,
        VERCEL_API_KEY: vercelToken,
        GH_TOKEN: credentials.gitOauthToken,
        GITHUB_TOKEN: credentials.gitOauthToken,
      };
      const sandbox: SandboxSession = {
        ...handle.sandbox,
        run: (options) => handle.sandbox.run({ ...options, env: { ...options.env, ...env } }),
        spawn: (options) => handle.sandbox.spawn({ ...options, env: { ...options.env, ...env } }),
      };
      return {
        handle: {
          sandbox,
          onRuntimeShutdown: () => handle.onRuntimeShutdown(),
          onSessionStop: () => handle.onSessionStop(),
          async onSessionDelete(options) {
            // Revoke the registration before deleting compute. Keep the sandbox
            // if revocation fails so the caller can retry both operations.
            await remove();
            await handle.onSessionDelete(options);
          },
        },
        state: { sandboxName: state.sandboxName, version: state.version, devboxId },
      };
    } catch (error) {
      // eve persists provider state only after start() returns, so a failed fresh
      // start must delete its new sandbox and registration: nothing could clean
      // them up later. A failed reconnect preserves both for the next attempt.
      const cleanup = previousId
        ? [() => handle.onSessionStop()]
        : [async () => devboxId && (await remove()), () => handle.onSessionDelete()];
      const failures: unknown[] = [];
      for (const step of cleanup) {
        try {
          await step();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures],
          `eve-gh sandbox setup and cleanup both failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  return {
    prepare: (context) => provider.prepare(context),
    async start(context, options, artifact) {
      const auth = resolveAuth(context);
      const started = await provider.start(context, options, artifact);
      let state: EveGhSessionState;
      try {
        state = requireState(started.state);
      } catch (error) {
        await started.handle.onSessionDelete();
        throw error;
      }
      // A fresh start never carries a Devbox identity.
      return await attach(started.handle, { sandboxName: state.sandboxName, version: 3 }, auth);
    },
    async resume(context, artifact, value) {
      const auth = resolveAuth(context);
      const state = requireState(value);
      const { devboxId: _devboxId, ...sandboxState } = state;
      const handle = await provider.resume(context, artifact, sandboxState);
      // Reconnect re-registers the same Devbox ID; resumed state is immutable.
      return (await attach(handle, state, auth)).handle;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredString(response: Record<string, unknown>, key: string): string {
  const value = response?.[key];
  if (typeof value !== "string" || !value) throw new Error("Invalid Devbox credential response.");
  return value;
}
