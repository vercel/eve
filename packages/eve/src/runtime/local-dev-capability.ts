import {
  rebuildDevelopmentRuntimeArtifacts,
  resumeDevelopmentRuntimeArtifacts,
  suspendDevelopmentRuntimeArtifacts,
} from "#services/dev-client/runtime-artifacts.js";

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
/**
 * Set by the process that owns the terminal when it also runs the dev TUI.
 *
 * Nothing else distinguishes `eve dev` from `eve dev --no-ui`: both fork the
 * same server child over pipes, so neither the host nor the runtime can observe
 * a TTY. Only the terminal's owner knows, so only it may declare this.
 */
const LOCAL_DEV_INTERACTIVE_CLIENT_ENV = "EVE_DEV_INTERACTIVE_CLIENT";

/**
 * Capabilities available to authored code only while a *local* `eve dev`
 * process owns this runtime.
 *
 * Absence is the signal, not a disabled flag: a deployed runtime has no
 * authored tree to mutate and no watcher to pause, and a TUI attached to a
 * remote `eve dev <url>` has neither either, since no local server was
 * started for it. {@link getLocalDevCapability} returns `undefined` in both
 * cases, and a tool that requires this capability refuses instead of
 * silently doing something weaker or targeting the wrong root.
 */
export interface LocalDevCapability {
  /**
   * Absolute path of the authored application root — the directory holding
   * `package.json` and the authored `agent/` tree, never a runtime snapshot.
   */
  readonly appRoot: string;
  /**
   * Whether an interactive client (the dev TUI) owns the terminal this dev
   * server was started from, and can therefore run a flow that asks questions.
   */
  readonly interactiveClient: boolean;
  /**
   * Runs `task` with the authored-source watcher paused, then resumes it.
   *
   * Suspension is reference counted by the watcher, so concurrent holders
   * cannot resume each other early; the final release rebuilds authored
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

/** Environment a terminal owner adds to the dev server child it forks. */
export function localDevInteractiveClientEnvironment(
  interactiveClient: boolean,
): Record<string, string> {
  return interactiveClient ? { [LOCAL_DEV_INTERACTIVE_CLIENT_ENV]: "1" } : {};
}

/**
 * Resolves the local dev capability, or `undefined` outside a local `eve dev`
 * process.
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
  if (appRoot === undefined || appRoot === "" || controlUrl === undefined || controlUrl === "") {
    return undefined;
  }

  return {
    appRoot,
    interactiveClient: environment[LOCAL_DEV_INTERACTIVE_CLIENT_ENV] === "1",
    async withSuspendedSource<T>(task: () => Promise<T>): Promise<T> {
      if (!(await suspendDevelopmentRuntimeArtifacts({ serverUrl: controlUrl }))) {
        throw new Error(
          "Could not pause the eve development server. Its authored-source watcher must be suspended before the authored tree is modified.",
        );
      }
      try {
        return await task();
      } finally {
        // `resume()` already force-rebuilds once the last suspension lifts
        // (`dev-authored-source-watcher.ts`), so releasing the capability is
        // normally sufficient on its own. The explicit `rebuild()` below is
        // not part of that — it only runs when the resume request itself
        // could not be served, so a network blip on this one call does not
        // leave the tree compiled from pre-install sources indefinitely.
        if ((await resumeDevelopmentRuntimeArtifacts({ serverUrl: controlUrl })) === undefined) {
          await rebuildDevelopmentRuntimeArtifacts({ force: true, serverUrl: controlUrl });
        }
      }
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
