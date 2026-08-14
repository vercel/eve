import { resolve } from "node:path";

import { runLocalDoctor } from "#doctor/doctor.js";
import { renderDoctorHuman, renderDoctorJson } from "#doctor/render.js";

export interface DoctorLogger {
  log(message: string): void;
}

export async function runDoctorCommand(
  logger: DoctorLogger,
  path: string | undefined,
  options: { json?: boolean },
): Promise<void> {
  const result = await runLocalDoctor(resolve(path ?? process.cwd()));
  logger.log(options.json ? renderDoctorJson(result) : renderDoctorHuman(result));
  if (result.summary.fail > 0) process.exitCode = 1;
}
