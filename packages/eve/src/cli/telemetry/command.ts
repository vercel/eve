import type { Command } from "#compiled/commander/index.js";
import { flushEveCliTelemetry } from "#cli/telemetry/flush.js";
import { readEveTelemetryPreference, setEveTelemetryEnabled } from "#cli/telemetry/preference.js";

type TelemetryLogger = {
  log(message: string): void;
};

export function registerEveTelemetryCommands(program: Command, logger: TelemetryLogger): void {
  const telemetry = program
    .command("telemetry")
    .description("Enable or disable CLI telemetry collection.");
  telemetry
    .command("status")
    .description("Show whether telemetry collection is enabled.")
    .action(async () => {
      await showEveTelemetryStatus(logger);
    });
  telemetry
    .command("enable")
    .description("Enable telemetry collection.")
    .action(async () => {
      await enableEveTelemetry(logger);
    });
  telemetry
    .command("disable")
    .description("Disable telemetry collection.")
    .action(async () => {
      await disableEveTelemetry(logger);
    });
  telemetry.command("flush <payload>", { hidden: true }).action(async (payload: string) => {
    await flushEveCliTelemetry(payload);
  });
}

export async function showEveTelemetryStatus(logger: TelemetryLogger): Promise<void> {
  const { enabled } = await readEveTelemetryPreference();
  logger.log(`Telemetry status: ${enabled ? "Enabled" : "Disabled"}`);
}

export async function enableEveTelemetry(logger: TelemetryLogger): Promise<void> {
  await setEveTelemetryEnabled(true);
  logger.log("Telemetry collection enabled.");
}

export async function disableEveTelemetry(logger: TelemetryLogger): Promise<void> {
  await setEveTelemetryEnabled(false);
  logger.log("Telemetry collection disabled. No data will be collected from this machine.");
}
