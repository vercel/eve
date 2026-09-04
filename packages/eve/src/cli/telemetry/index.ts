import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";

import {
  createEveTelemetryIdentity,
  isEphemeralEveTelemetryEnvironment,
  resolveEveTelemetryProjectId,
} from "#cli/telemetry/identity.js";
import {
  markEveTelemetryNotified,
  readEveTelemetryPreference,
  readOrCreateEveTelemetryIdentity,
} from "#cli/telemetry/preference.js";

export type EveCliTelemetryEvent = {
  readonly id: string;
  readonly event_time: number;
  readonly key: string;
  readonly value: string;
};

export type EveCliSetupFlow = "init" | "extension_init" | "onboarding";
export type EveCliSetupStep =
  | "resolve_target"
  | "scaffold"
  | "install_dependencies"
  | "initialize_git"
  | "handoff"
  | "model_provider"
  | "model_settings"
  | "registry_channels"
  | "registry_integrations"
  | "registry_review"
  | "registry_install";
export type EveCliSetupTerminalResult = "completed" | "cancelled" | "error";

export type EveCliTelemetry = {
  trackCommand(command: string): void;
  trackDevContext(context: { target: "local" | "remote"; ui: "tui" | "headless" }): void;
  trackSetupStep(input: {
    flow: EveCliSetupFlow;
    step: EveCliSetupStep;
    registrySelectedCount?: number;
  }): void;
  trackSetupTerminal(input: {
    flow: EveCliSetupFlow;
    step: EveCliSetupStep;
    result: EveCliSetupTerminalResult;
  }): void;
  trackOutcome(outcome: "success" | "usage_error" | "error"): void;
  notify(logger: { error(message: string): void }): Promise<void>;
  flush(): Promise<void>;
};

async function isEnabled(): Promise<boolean> {
  return (
    process.env.NODE_ENV !== "test" &&
    !process.env.EVE_TELEMETRY_DISABLED &&
    (await readEveTelemetryPreference()).enabled
  );
}

function event(key: string, value: string): EveCliTelemetryEvent {
  return { id: randomUUID(), event_time: Date.now(), key, value };
}

const CLI_TELEMETRY_COMMANDS = new Map<string, string>([
  ["acp", "acp"],
  ["add", "add"],
  ["build", "build"],
  ["channels", "channels"],
  ["channels:list", "channels:list"],
  ["deploy", "deploy"],
  ["dev", "dev"],
  ["eval", "eval"],
  ["extension", "extension"],
  ["extension:build", "extension:build"],
  ["extension:init", "extension:init"],
  ["info", "info"],
  ["init", "init"],
  ["integration", "integration"],
  ["integration:connect", "integration:connect"],
  ["integration:setup", "integration:setup"],
  ["invoke", "invoke"],
  ["link", "link"],
  ["logs", "logs:show"],
  ["logs:ls", "logs:ls"],
  ["logs:show", "logs:show"],
  ["registry", "registry"],
  ["registry:add", "registry:add"],
  ["registry:list", "registry:list"],
  ["registry:search", "registry:search"],
  ["registry:view", "registry:view"],
  ["set", "set"],
  ["start", "start"],
  ["telemetry", "telemetry"],
  ["telemetry:disable", "telemetry:disable"],
  ["telemetry:enable", "telemetry:enable"],
  ["telemetry:status", "telemetry:status"],
  ["traces", "traces:show"],
  ["traces:ls", "traces:ls"],
]);

/** Explicit privacy allowlist for command values emitted by CLI telemetry. */
export const cliTelemetryCommandPaths = new Set(CLI_TELEMETRY_COMMANDS.keys());

/** Internal command paths that must never emit telemetry. */
export const internalCliCommandPaths = new Set(["telemetry:flush"]);

/** Returns only an allowlisted command path; it never includes user input. */
export function canonicalCommand(argv: readonly string[]): string {
  const firstArgument = argv[0];
  if (firstArgument === "--help" || firstArgument === "-h") return "help";
  if (firstArgument === "--version" || firstArgument === "-V") return "version";

  const commandIndex = argv.findIndex((argument) => !argument.startsWith("-"));
  const command = argv[commandIndex];
  if (command === undefined || /^https?:\/\//.test(command)) return "dev";

  const nested = argv.slice(commandIndex + 1).find((argument) => !argument.startsWith("-"));
  if (nested !== undefined) {
    const nestedCommand = CLI_TELEMETRY_COMMANDS.get(`${command}:${nested}`);
    if (nestedCommand !== undefined) return nestedCommand;
  }
  return CLI_TELEMETRY_COMMANDS.get(command) ?? "unknown";
}

export function createEveCliTelemetry(version: string): EveCliTelemetry {
  const events: EveCliTelemetryEvent[] = [
    event("version", version),
    event("platform", os.platform()),
    event("arch", os.arch()),
    event("stdin_is_tty", process.stdin.isTTY ? "true" : "false"),
  ];
  const sessionId = randomUUID();
  const setupEvents: EveCliTelemetryEvent[] = [];
  let activeSetup: { flow: EveCliSetupFlow; step: EveCliSetupStep } | undefined;
  let setupTerminalRecorded = false;

  return {
    trackCommand(command) {
      events.push(event("command", command));
    },
    trackDevContext(context) {
      events.push(event("target", context.target), event("ui", context.ui));
    },
    trackSetupStep(input) {
      activeSetup = { flow: input.flow, step: input.step };
      setupEvents.push(event("setup_flow", input.flow), event("setup_step", input.step));
      if (input.registrySelectedCount !== undefined) {
        setupEvents.push(event("registry_selected_count", String(input.registrySelectedCount)));
      }
    },
    trackSetupTerminal(input) {
      setupTerminalRecorded = true;
      setupEvents.push(
        event("setup_flow", input.flow),
        event("setup_terminal_step", input.step),
        event("setup_terminal_result", input.result),
      );
    },
    trackOutcome(outcome) {
      if (activeSetup !== undefined && !setupTerminalRecorded) {
        this.trackSetupTerminal({
          ...activeSetup,
          result: outcome === "success" ? "completed" : "error",
        });
      }
      events.push(event("outcome", outcome));
    },
    async notify(logger) {
      const preference = await readEveTelemetryPreference();
      if (
        process.env.NODE_ENV === "test" ||
        process.env.EVE_TELEMETRY_DISABLED ||
        !preference.enabled ||
        preference.notified ||
        !process.stderr.isTTY
      ) {
        return;
      }
      logger.error(
        "Attention: eve collects CLI telemetry to improve the command-line interface.\n" +
          "Disable it with `eve telemetry disable`, or for one command set EVE_TELEMETRY_DISABLED=1.\n" +
          "Learn more: https://eve.dev/docs/reference/telemetry",
      );
      try {
        await markEveTelemetryNotified();
      } catch {
        // Failing to persist the notice must not affect the command.
      }
    },
    async flush() {
      if (!(await isEnabled()) || events.length === 0) return;
      try {
        const ephemeralIdentity = isEphemeralEveTelemetryEnvironment();
        const identity = ephemeralIdentity
          ? createEveTelemetryIdentity()
          : await readOrCreateEveTelemetryIdentity();
        events.push(
          event("identity_kind", ephemeralIdentity ? "ephemeral" : "persistent"),
          event("installation_id", identity.installationId),
          event("project_id", await resolveEveTelemetryProjectId({ identity })),
        );
        events.push(...setupEvents);
      } catch {
        return;
      }
      if (process.env.EVE_TELEMETRY_DEBUG) {
        process.stderr.write(`[eve telemetry] ${JSON.stringify(events)}\n`);
        return;
      }
      try {
        const child = spawn(
          process.execPath,
          [process.argv[1] ?? "", "telemetry", "flush", JSON.stringify({ events, sessionId })],
          {
            detached: true,
            env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" },
            stdio: "ignore",
            windowsHide: true,
          },
        );
        child.on("error", () => {});
        child.unref();
      } catch {
        // Telemetry must never affect command output or exit status.
      }
    },
  };
}
