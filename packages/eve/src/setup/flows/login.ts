import { createPromptCommandOutput } from "#setup/cli/index.js";
import { runVercel } from "#setup/primitives/run-vercel.js";
import { getVercelAuthStatus, type VercelAuthStatus } from "#setup/vercel-project.js";

import type { Prompter } from "../prompter.js";
import { withSpinner } from "../with-spinner.js";

export type LoginFlowResult =
  /** A `vercel whoami` already succeeds; nothing to do. */
  | { kind: "already" }
  /** `vercel login` ran and the directory is now authenticated. */
  | { kind: "logged-in" }
  /** `vercel login` exited without leaving an authenticated session. */
  | { kind: "failed" }
  /** The Vercel CLI is not installed, so login cannot start. */
  | { kind: "cli-missing" }
  /** Vercel could not be reached, so login state could not be determined. */
  | { kind: "unavailable" }
  /** The user stopped waiting (Cancel / Esc) before login completed. */
  | { kind: "cancelled" };

/**
 * Deadline for the `vercel login` browser OAuth. Generous because a human is in
 * the loop, but bounded so an abandoned hand-off cannot stall the TUI forever.
 * Mirrors the Slack Connect create wait.
 */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Injected for tests; defaults to the real auth probe and `vercel login`. */
export interface LoginFlowDeps {
  getVercelAuthStatus: typeof getVercelAuthStatus;
  runVercelLogin: (input: {
    cwd: string;
    onOutput: ReturnType<typeof createPromptCommandOutput>;
    signal?: AbortSignal;
  }) => Promise<boolean>;
}

const defaultDeps: LoginFlowDeps = {
  getVercelAuthStatus,
  // `--non-interactive` (stdin ignored) makes `vercel login` run the OAuth/SSO
  // web flow with no terminal method menu: it prints the URL (streamed to the
  // rail via onOutput) and polls the browser. That is what lets the TUI stay
  // live and wait, exactly like `vercel connect create`.
  runVercelLogin: ({ cwd, onOutput, signal }) =>
    runVercel(["login"], {
      cwd,
      nonInteractive: true,
      onOutput,
      timeoutMs: LOGIN_TIMEOUT_MS,
      signal,
    }),
};

/**
 * Runs `vercel login` while the dev TUI stays live, mirroring the Slack Connect
 * browser wait: an interactive prompter races the login subprocess against a
 * "Cancel" action (the browser OAuth runs without the terminal, so the panel
 * keeps painting and the user can bail); a plain/headless prompter just runs it
 * behind an ephemeral spinner. Returns the CLI's success, or `"cancelled"` when
 * the user stops waiting first.
 */
async function runVercelLoginWithControls(
  deps: LoginFlowDeps,
  appRoot: string,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  prompter: Prompter,
  signal: AbortSignal | undefined,
): Promise<boolean | "cancelled"> {
  if (prompter.awaitChoice === undefined) {
    return withSpinner(prompter, "Opening Vercel login in your browser…", () =>
      deps.runVercelLogin({ cwd: appRoot, onOutput, signal }),
    );
  }

  // A private controller linked to the outer signal, so a Cancel aborts only
  // this subprocess while an outer interrupt still propagates.
  const controller = new AbortController();
  const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const prompt = prompter.awaitChoice({
    status: "Logging in to Vercel…",
    context: "Complete the login in your browser",
    actions: [{ value: "cancel", label: "Cancel" }],
  });
  const work = deps.runVercelLogin({ cwd: appRoot, onOutput, signal: linked });
  try {
    const winner = await Promise.race([
      work.then((ok) => ({ via: "work" as const, ok })),
      prompt.choice.then(() => ({ via: "choice" as const })),
    ]);
    if (winner.via === "work") return winner.ok;
    // Cancel (or Esc): abort the login subprocess and settle it before leaving.
    controller.abort();
    await work.catch(() => {});
    return "cancelled";
  } finally {
    prompt.close();
  }
}

/**
 * THE LOGIN FLOW for the dev TUI's `/vc:login`. Short-circuits when already
 * authenticated; otherwise runs `vercel login` as a browser flow the TUI waits
 * on (see {@link runVercelLoginWithControls}) and re-probes after, so a
 * half-finished or abandoned login reports `failed`, never a false success.
 */
export async function runLoginFlow(input: {
  appRoot: string;
  prompter: Prompter;
  /** Run the browser login even when the account-level Vercel session is valid. */
  force?: boolean;
  signal?: AbortSignal;
  deps?: Partial<LoginFlowDeps>;
}): Promise<LoginFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: LoginFlowDeps = { ...defaultDeps, ...input.deps };
  const onOutput = createPromptCommandOutput(prompter.log);

  const probeAuth = (): Promise<VercelAuthStatus> => deps.getVercelAuthStatus(appRoot, { signal });

  const initialStatus = await withSpinner(prompter, "Checking your Vercel login…", probeAuth);
  signal?.throwIfAborted();
  switch (initialStatus) {
    case "authenticated":
      if (input.force !== true) return { kind: "already" };
      break;
    case "cli-missing":
      return { kind: "cli-missing" };
    case "unavailable":
      return { kind: "unavailable" };
    case "logged-out":
      break;
    default: {
      const exhaustive: never = initialStatus;
      return exhaustive;
    }
  }

  const outcome = await runVercelLoginWithControls(deps, appRoot, onOutput, prompter, signal);
  if (outcome === "cancelled") return { kind: "cancelled" };
  if (!outcome) return { kind: "failed" };

  const status = await withSpinner(prompter, "Confirming your Vercel login…", probeAuth);
  signal?.throwIfAborted();
  switch (status) {
    case "authenticated":
      return { kind: "logged-in" };
    case "logged-out":
      return { kind: "failed" };
    case "cli-missing":
      return { kind: "cli-missing" };
    case "unavailable":
      return { kind: "unavailable" };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
