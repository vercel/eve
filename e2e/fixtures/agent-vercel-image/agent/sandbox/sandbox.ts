import { DefaultSandbox, defineSandbox } from "eve/sandbox";
import { ExperimentalVercelDockerfile } from "eve/sandbox/vercel";

export const environment = process.env.VERCEL
  ? ExperimentalVercelDockerfile.environment()
  : DefaultSandbox.environment();

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await sandbox.writeTextFile({ content: environment.provider, path: ".eve/provider" });
  const path = ".eve/initialization-count";
  const current = await sandbox.readTextFile({ path });
  await sandbox.writeTextFile({ content: String(Number(current ?? "0") + 1), path });
  return sandbox;
});
