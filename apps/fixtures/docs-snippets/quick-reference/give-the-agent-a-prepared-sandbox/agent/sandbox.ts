import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({
  // Runs once per build; every session sandbox starts from the snapshot.
  prepare: async (sandbox) => {
    const result = await sandbox.run({ command: "npm install -g pnpm@10" });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  },
});

export default defineSandbox(() => environment.open({ resources: { vcpus: 4 } }));
