import { WizardCancelledError } from "#setup/step.js";

import { createTuiPrompter } from "./tui-prompter.js";
import { runRemoteAuthFlow, type RemoteAuthFlow } from "./remote-auth.js";
import { describeRemoteAuthCompletedMutations } from "./remote-auth-result.js";
import type { RemoteConnectionController, RemoteConnectionState } from "./remote-connection.js";
import type { SetupFlowPrompterRenderer, SetupFlowRenderer } from "./setup-flow.js";
import { remoteHost } from "./target.js";

interface RemoteAuthCommandInput {
  readonly connection: RemoteConnectionController;
  readonly flow?: RemoteAuthFlow;
  readonly renderer: SetupFlowRenderer;
}

function shouldConfigureTrustedSources(connection: RemoteConnectionState): boolean {
  switch (connection.state) {
    case "auth-required":
    case "auth-failed":
      return connection.challenge.kind === "vercel-deployment-protection";
    case "unavailable":
      return connection.failure.code === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH";
    case "checking":
    case "authenticating":
    case "ready":
      return false;
  }
}

function unavailableAfterAuthentication(host: string, message: string): string {
  const [reason = message, ...details] = message.split(/\n\s*\n/u);
  const sentence = /[.!?]$/u.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`;
  return [
    `Authentication was refreshed, but ${host} is unavailable: ${sentence}`,
    ...details.map((detail) => detail.trim()).filter((detail) => detail.length > 0),
  ].join("\n\n");
}

function mutedRenderer(
  renderer: SetupFlowPrompterRenderer,
  isMuted: () => boolean,
): SetupFlowPrompterRenderer {
  return {
    readSelect: (options) =>
      isMuted() ? Promise.resolve(undefined) : renderer.readSelect(options),
    readEditableSelect: (options) =>
      isMuted() ? Promise.resolve(undefined) : renderer.readEditableSelect(options),
    readText: (options) => (isMuted() ? Promise.resolve(undefined) : renderer.readText(options)),
    readAcknowledge: (options) =>
      isMuted() ? Promise.resolve() : renderer.readAcknowledge(options),
    readChoice: (options) =>
      isMuted()
        ? { choice: Promise.resolve(undefined), close: () => {} }
        : renderer.readChoice(options),
    setStatus: (text) => {
      if (!isMuted()) renderer.setStatus(text);
    },
    renderLine: (text, tone) => {
      if (!isMuted() || tone === "warning" || tone === "error") {
        renderer.renderLine(text, tone);
      }
    },
    renderOutput: (text) => {
      if (!isMuted()) renderer.renderOutput(text);
    },
  };
}

/** Runs remote `/vc:login` through one TUI panel, connection operation, and auth flow. */
export async function runRemoteAuthCommand(input: RemoteAuthCommandInput): Promise<string> {
  // The pulsing square, matching /vc:install and /vc:login (and model/channels).
  input.renderer.begin("Authenticate via Vercel OIDC", "pulse");
  let preserveFlowDiagnostics = true;
  let interrupted = false;
  const controller = new AbortController();
  const interrupt = input.renderer.waitForInterrupt();
  const target = input.connection.current().target;
  try {
    const runFlow = input.flow ?? runRemoteAuthFlow;
    const configureTrustedSources = shouldConfigureTrustedSources(
      input.connection.current().connection,
    );
    const prompter = createTuiPrompter(mutedRenderer(input.renderer, () => interrupted));
    const execution = input.connection.authenticate(async (signal) => {
      const result = await runFlow({
        workspaceRoot: target.workspaceRoot,
        serverUrl: target.serverUrl,
        configureTrustedSources,
        prompter,
        signal,
      });
      preserveFlowDiagnostics = result.kind === "failed";
      return result;
    }, controller.signal);
    const first = await Promise.race([
      execution.then((outcome) => ({ kind: "completed", outcome }) as const),
      interrupt.promise.then(() => ({ kind: "interrupted" }) as const),
    ]);
    if (first.kind === "interrupted") {
      interrupted = true;
      preserveFlowDiagnostics = true;
      controller.abort(new WizardCancelledError());
    }
    const outcome = first.kind === "completed" ? first.outcome : await execution;
    switch (outcome.kind) {
      case "authenticated":
        return `Authenticated ${remoteHost(target)} via Vercel OIDC.`;
      case "cancelled": {
        if (interrupted) {
          const completed = describeRemoteAuthCompletedMutations(outcome.completedMutations);
          return completed.length === 0
            ? "/vc:login interrupted."
            : `/vc:login interrupted. Completed before interruption: ${completed.join(", ")}.`;
        }
        return outcome.completedMutations.some((mutation) => mutation.kind === "vercel-login")
          ? "/vc:login cancelled after logging in to Vercel."
          : "/vc:login cancelled.";
      }
      case "failed":
        return outcome.message;
      case "unavailable":
        return unavailableAfterAuthentication(remoteHost(target), outcome.failure.message);
    }
  } finally {
    interrupt.dispose();
    input.renderer.setStatus(undefined);
    input.renderer.end({ preserveDiagnostics: preserveFlowDiagnostics });
  }
}
