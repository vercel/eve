import { defineSandbox } from "eve/sandbox";
import { HostSandbox } from "eve/sandbox/host";

const unsetHarnessEnv = Object.fromEntries(
  Object.keys(process.env)
    .filter(
      (key) =>
        key.startsWith("EVE_BENCH_") ||
        key.startsWith("EVE_AGENT_") ||
        key === "EVE_PROJECT_DIR" ||
        key === "EVE_INSTRUCTION_PATH" ||
        key === "EVE_HOST" ||
        key === "EVE_PORT" ||
        key === "EVE_STARTUP_TIMEOUT_MS",
    )
    .map((key) => [key, undefined]),
);

export const environment = HostSandbox.environment({ env: unsetHarnessEnv });

export default defineSandbox(() => {
  const cwd = process.env.EVE_BENCH_TASK_WORKDIR;
  if (!cwd) {
    throw new Error("EVE_BENCH_TASK_WORKDIR must be set");
  }
  return environment.open({ cwd });
});
