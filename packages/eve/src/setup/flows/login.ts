import { createPromptCommandOutput } from "#setup/cli/index.js";
import { runVercel } from "#setup/primitives/run-vercel.js";
import { getVercelAuthStatus, type VercelAuthStatus } from "#setup/vercel-project.js";

import type { Prompter } from "../prompter.js";
import { withSpinner } from "../with-spinner.js";

export type LoginFlowResult =
  | { kind: "already" }
  | { kind: "logged-in" }
  | { kind: "failed" }
  | { kind: "cli-missing" }
  | { kind: "unavailable" }
  | { kind: "cancelled" };

const LOGIN_TIMEOUT_MS = 5 * 60_000;

function vercelLoginUrl(text: string): string | undefined {
  return text.match(/https:\/\/vercel\.com\/oauth\/device\?[^\s]+/u)?.[0];
}

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
  runVercelLogin: ({ cwd, onOutput, signal }) =>
    runVercel(["login"], {
      cwd,
      nonInteractive: true,
      onOutput,
      timeoutMs: LOGIN_TIMEOUT_MS,
      signal,
    }),
};

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
    controller.abort();
    await work.catch(() => {});
    return "cancelled";
  } finally {
    prompt.close();
  }
}

export async function runLoginFlow(input: {
  appRoot: string;
  prompter: Prompter;
  force?: boolean;
  allowLogin?: boolean;
  signal?: AbortSignal;
  deps?: Partial<LoginFlowDeps>;
}): Promise<LoginFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: LoginFlowDeps = { ...defaultDeps, ...input.deps };
  const commandOutput = createPromptCommandOutput(prompter.log);
  let shownLoginUrl: string | undefined;
  const onOutput: ReturnType<typeof createPromptCommandOutput> = (line) => {
    commandOutput(line);
    const url = vercelLoginUrl(line.text);
    if (url !== undefined && url !== shownLoginUrl) {
      shownLoginUrl = url;
      prompter.log.info(`Open ${url}`);
    }
  };

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

  if (input.allowLogin === false) return { kind: "failed" };

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
