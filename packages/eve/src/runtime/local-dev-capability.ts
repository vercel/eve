import { randomUUID } from "node:crypto";

import {
  resumeDevelopmentRuntimeArtifacts,
  suspendDevelopmentRuntimeArtifacts,
} from "#services/dev-client/runtime-artifacts.js";
import { readTrustedDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import { isLoopbackHostname } from "#shared/network-address.js";
import { ContextContainer, contextStorage } from "#context/container.js";

/**
 * Authored application root, published by the `eve dev` host that owns the
 * authored-source watcher.
 *
 * The runtime's own `appRoot` can point at an immutable development snapshot
 * (see `runtime/compiled-artifacts-source.ts`), so a tool that writes to it
 * mutates a directory that is about to be discarded. This variable always names
 * the directory the developer authored.
 */
const LOCAL_DEV_APP_ROOT_ENV = "EVE_DEV_APP_ROOT";
/** Origin of the dev host's control plane, which owns the watcher handle. */
const LOCAL_DEV_CONTROL_URL_ENV = "EVE_DEV_CONTROL_URL";
export const LOCAL_DEV_INTERACTIVE_CLIENT_HEADER = "x-eve-dev-interactive-client";

/**
 * Capabilities available to authored code while handling a same-machine
 * request to `eve dev`.
 *
 * Absence is the signal, not a disabled flag: a deployed runtime has no
 * authored tree to mutate or watcher to pause, and a request from a remote
 * client is not authorized to mutate the server's authored tree.
 * {@link getLocalDevCapability} returns `undefined` in both cases.
 */
export interface LocalDevCapability {
  /**
   * Absolute path of the authored application root — the directory holding
   * `package.json` and the authored `agent/` tree, never a runtime snapshot.
   */
  readonly appRoot: string;
  /**
   * Whether the requesting client is the dev TUI and can therefore run a flow
   * that asks questions in its terminal.
   */
  readonly interactiveClient: boolean;
  /**
   * Runs `task` with the authored-source watcher paused, then resumes it.
   *
   * Each suspension has an idempotent lease, so concurrent holders cannot
   * resume each other early; the final release rebuilds authored
   * artifacts instead of waiting for the watcher's change debounce.
   */
  withSuspendedSource<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Publishes the local dev capability to the runtime for one dev server.
 *
 * Returns a restore function that reinstates the previous values, matching the
 * other environment installers the dev host tears down on close.
 */
export function installLocalDevCapabilityEnvironment(input: {
  readonly appRoot: string;
  readonly serverUrl: string;
}): () => void {
  const previousAppRoot = process.env[LOCAL_DEV_APP_ROOT_ENV];
  const previousControlUrl = process.env[LOCAL_DEV_CONTROL_URL_ENV];
  process.env[LOCAL_DEV_APP_ROOT_ENV] = input.appRoot;
  process.env[LOCAL_DEV_CONTROL_URL_ENV] = new URL(input.serverUrl).origin;
  return () => {
    restore(LOCAL_DEV_APP_ROOT_ENV, previousAppRoot);
    restore(LOCAL_DEV_CONTROL_URL_ENV, previousControlUrl);
  };
}

/**
 * Runs a development request with local-dev access only when the parent host
 * signed a loopback peer address. Public address headers cannot grant access.
 */
export async function withLocalDevRequestScope<T>(
  request: Request,
  callback: () => Promise<T>,
): Promise<T> {
  const address = readTrustedDevelopmentClientAddress(
    request.headers,
    process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV],
  );
  if (address === undefined || !isLoopbackHostname(address)) {
    return await callback();
  }

  return await contextStorage.run(
    new ContextContainer({
      localDevRequest: {
        interactiveClient: request.headers.get(LOCAL_DEV_INTERACTIVE_CLIENT_HEADER) === "1",
      },
    }),
    callback,
  );
}

/**
 * Resolves the local dev capability, or `undefined` outside an authorized
 * local request to `eve dev`.
 *
 * This is deliberately not a {@link import("#public/definitions/tool.js").ToolContext}
 * field: both values are meaningless in a deployed runtime, and a capability
 * that cannot exist there should be absent from the type rather than present
 * and undefined.
 */
export function getLocalDevCapability(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LocalDevCapability | undefined {
  const appRoot = environment[LOCAL_DEV_APP_ROOT_ENV];
  const controlUrl = environment[LOCAL_DEV_CONTROL_URL_ENV];
  const requestScope = contextStorage.getStore()?.localDevRequest;
  if (
    requestScope === undefined ||
    appRoot === undefined ||
    appRoot === "" ||
    controlUrl === undefined ||
    controlUrl === ""
  ) {
    return undefined;
  }

  return {
    appRoot,
    interactiveClient: requestScope.interactiveClient,
    async withSuspendedSource<T>(task: () => Promise<T>): Promise<T> {
      const leaseId = randomUUID();
      if (!(await suspendDevelopmentRuntimeArtifacts({ leaseId, serverUrl: controlUrl }))) {
        throw new Error(
          "Could not pause the eve development server. Its authored-source watcher must be suspended before the authored tree is modified.",
        );
      }
      let outcome:
        | { readonly error: unknown; readonly ok: false }
        | { readonly ok: true; value: T };
      try {
        outcome = { ok: true, value: await task() };
      } catch (error) {
        outcome = { error, ok: false };
      }

      // Release is keyed by this acquisition, so retrying after a lost
      // response cannot release another concurrent holder.
      if (
        (await resumeDevelopmentRuntimeArtifacts({ leaseId, serverUrl: controlUrl })) ===
          undefined &&
        (await resumeDevelopmentRuntimeArtifacts({ leaseId, serverUrl: controlUrl })) === undefined
      ) {
        throw new Error(
          "Could not resume the eve development server after modifying the authored tree. Restart eve dev before making further source changes.",
          outcome.ok ? undefined : { cause: outcome.error },
        );
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
  };
}

function restore(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
