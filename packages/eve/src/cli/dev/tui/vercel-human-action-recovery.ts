import { runInstallVercelCliFlow } from "#setup/flows/install-vercel-cli.js";
import { runLoginFlow } from "#setup/flows/login.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import type { Prompter } from "#setup/prompter.js";

export interface VercelHumanActionRecoveryFlows {
  readonly runInstallVercelCliFlow: typeof runInstallVercelCliFlow;
  readonly runLoginFlow: typeof runLoginFlow;
}

/** Repairs an interactive Vercel prerequisite and tells the caller whether to retry. */
export async function recoverVercelHumanAction(
  error: HumanActionRequiredError,
  flows: VercelHumanActionRecoveryFlows,
  input: { appRoot: string; prompter: Prompter; signal: AbortSignal },
): Promise<"retry" | "cancel"> {
  const action = error.action.kind;
  if (
    action !== "vercel-cli-missing" &&
    action !== "vercel-cli-upgrade" &&
    action !== "vercel-login" &&
    action !== "vercel-forbidden"
  ) {
    throw error;
  }

  const repair =
    action === "vercel-cli-missing"
      ? { label: "Install Vercel CLI", message: "The Vercel CLI is required. Install it now?" }
      : action === "vercel-cli-upgrade"
        ? {
            label: "Upgrade Vercel CLI",
            message: "Your Vercel CLI needs an update. Upgrade it now?",
          }
        : {
            label:
              action === "vercel-forbidden" ? "Re-authenticate with Vercel" : "Log in to Vercel",
            message:
              action === "vercel-forbidden"
                ? "Vercel denied access to that team. Re-authenticate and continue?"
                : "You need to log in to Vercel to continue.",
          };

  let choice: "repair" | "cancel";
  try {
    choice = await input.prompter.select({
      message: repair.message,
      options: [
        { value: "repair", label: `${repair.label} and continue` },
        { value: "cancel", label: "Choose another option" },
      ],
      initialValue: "repair",
    });
  } catch {
    return "cancel";
  }
  if (choice === "cancel") return "cancel";

  if (action === "vercel-cli-missing" || action === "vercel-cli-upgrade") {
    const result = await flows.runInstallVercelCliFlow({
      appRoot: input.appRoot,
      prompter: input.prompter,
      signal: input.signal,
      upgrade: action === "vercel-cli-upgrade",
    });
    if (result.kind === "installed" || result.kind === "already") return "retry";
    input.prompter.log.warning(
      result.kind === "failed" && result.reason !== undefined
        ? `Couldn't ${action === "vercel-cli-upgrade" ? "upgrade" : "install"} the Vercel CLI: ${result.reason}`
        : `Couldn't ${action === "vercel-cli-upgrade" ? "upgrade" : "install"} the Vercel CLI.`,
    );
    return "cancel";
  }

  const login = await flows.runLoginFlow({
    appRoot: input.appRoot,
    prompter: input.prompter,
    signal: input.signal,
    force: action === "vercel-forbidden",
  });
  input.prompter.replaceContent?.();
  return login.kind === "logged-in" || login.kind === "already" ? "retry" : "cancel";
}
