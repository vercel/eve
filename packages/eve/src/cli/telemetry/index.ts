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

export type EveCliTelemetry = {
  trackCommand(command: string): void;
  trackDevContext(context: { target: "local" | "remote"; ui: "tui" | "headless" }): void;
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

/** Returns only an allowlisted command path; it never includes user input. */
export function canonicalCommand(argv: readonly string[]): string {
  const command = argv.find((argument) => !argument.startsWith("-"));
  if (command === undefined || /^https?:\/\//.test(command)) return "dev";

  const topLevel = new Set([
    "acp",
    "add",
    "build",
    "channels",
    "deploy",
    "dev",
    "eval",
    "extension",
    "info",
    "init",
    "integration",
    "invoke",
    "link",
    "logs",
    "registry",
    "set",
    "start",
    "telemetry",
    "traces",
  ]);
  if (!topLevel.has(command)) return "unknown";

  const nested = argv
    .slice(argv.indexOf(command) + 1)
    .find((argument) => !argument.startsWith("-"));
  const subcommands: Record<string, ReadonlySet<string>> = {
    channels: new Set(["list"]),
    extension: new Set(["build", "init"]),
    integration: new Set(["connect", "setup"]),
    logs: new Set(["ls", "show"]),
    registry: new Set(["add", "list", "search", "view"]),
    traces: new Set(["ls"]),
  };
  const defaults: Record<string, string> = { logs: "show", traces: "show" };
  if (nested && subcommands[command]?.has(nested)) return `${command}:${nested}`;
  return defaults[command] ? `${command}:${defaults[command]}` : command;
}

export function createEveCliTelemetry(version: string): EveCliTelemetry {
  const events: EveCliTelemetryEvent[] = [
    event("version", version),
    event("platform", os.platform()),
    event("arch", os.arch()),
    event("stdin_is_tty", process.stdin.isTTY ? "true" : "false"),
  ];
  const sessionId = randomUUID();

  return {
    trackCommand(command) {
      events.push(event("command", command));
    },
    trackDevContext(context) {
      events.push(event("target", context.target), event("ui", context.ui));
    },
    trackOutcome(outcome) {
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
        const identity = isEphemeralEveTelemetryEnvironment()
          ? createEveTelemetryIdentity()
          : await readOrCreateEveTelemetryIdentity();
        events.push(
          event("installation_id", identity.installationId),
          event("project_id", await resolveEveTelemetryProjectId({ identity })),
        );
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
