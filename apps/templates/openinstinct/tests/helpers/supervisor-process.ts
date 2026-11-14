import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

const LOG_POLL_INTERVAL_MS = 20;
const LOG_WAIT_TIMEOUT_MS = 5_000;

export const SUPERVISOR_TEST_TIMEOUT_MS = LOG_WAIT_TIMEOUT_MS + 5_000;

export function waitForSupervisorClose(supervisor: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.once("close", resolve);
  });
}

export async function waitForSupervisorLogEntry(
  path: string,
  expected: string
) {
  const deadline = Date.now() + LOG_WAIT_TIMEOUT_MS;
  let contents = "";
  let readError: unknown;

  /* oxlint-disable eslint/no-await-in-loop -- This bounded poll must observe each read before scheduling the next retry. */
  while (Date.now() < deadline) {
    try {
      contents = await readFile(path, "utf8");
      readError = undefined;
    } catch (error) {
      contents = "";
      readError = error;
    }

    if (contents.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, LOG_POLL_INTERVAL_MS));
  }
  /* oxlint-enable eslint/no-await-in-loop */

  const lastObservation =
    readError === undefined
      ? `Last log contents: ${JSON.stringify(contents)}`
      : `Last log read failed: ${
          readError instanceof Error ? readError.message : "Unknown read error"
        }`;
  throw new Error(
    `Timed out after ${String(LOG_WAIT_TIMEOUT_MS)}ms waiting for ${JSON.stringify(expected)} in ${path}. ${lastObservation}`
  );
}
