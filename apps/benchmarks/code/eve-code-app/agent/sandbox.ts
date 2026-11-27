import { defineSandbox } from "eve/sandbox";
import { HostSandbox } from "eve/sandbox/host";

const unsetHarnessEnv = Object.fromEntries(
  Object.keys(process.env)
    .filter((key) => key.startsWith("CODE_BENCH_") || key.startsWith("EVE_CODE_BENCH_"))
    .map((key) => [key, undefined]),
);

export const environment = HostSandbox.environment({
  env: {
    ...unsetHarnessEnv,
    EVE_BENCH_TOKEN: undefined,
  },
});

export default defineSandbox(() =>
  environment.open({
    cwd: process.env.CODE_BENCH_TASK_WORKDIR,
  }),
);
