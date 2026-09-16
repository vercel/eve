import type { Command } from "#compiled/commander/index.js";

interface DoctorCommandLogger {
  log(message: string): void;
}

/** Registers the read-only environment and project diagnostic command. */
export function registerDoctorCommand(program: Command, logger: DoctorCommandLogger): void {
  program
    .command("doctor [path]")
    .description("Diagnose eve project, environment, and Vercel readiness.")
    .option("--offline", "Skip Vercel network checks")
    .option("--json", "Output diagnostics as JSON")
    .action(async (path: string | undefined, options: { json?: boolean; offline?: boolean }) => {
      const { runDoctorCommand } = await import("#cli/commands/doctor.js");
      await runDoctorCommand(logger, path, options);
    });
}
