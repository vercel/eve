import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HarnessDefinition {
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  installInstructionsUrl: string;
  installHint: string;
}

export function buildHarnessDefinition(options: {
  buzzCli: string;
  cliPath: string;
  modelId: string;
  nodePath: string;
  target?: string;
  appDirectory?: string;
  vercelScope?: string;
}): HarnessDefinition {
  const env: Record<string, string> = {
    BUZZ_CLI: options.buzzCli,
    EVE_MODEL_ID: options.modelId,
  };
  if (options.appDirectory) env.EVE_APP_DIR = options.appDirectory;
  if (options.vercelScope) env.EVE_VERCEL_SCOPE = options.vercelScope;
  return {
    id: "eve-buzz-acp-adapter",
    label: "eve",
    command: options.nodePath,
    args: [options.cliPath, ...(options.target ? [options.target] : [])],
    env,
    installInstructionsUrl:
      "https://github.com/vercel/eve/tree/main/packages/eve-buzz-acp-adapter#readme",
    installHint: "Install @eve/buzz-acp-adapter globally, then run eve-buzz-acp-adapter install.",
  };
}

export function defaultHarnessDirectory(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (environment.BUZZ_CUSTOM_HARNESS_DIR) return environment.BUZZ_CUSTOM_HARNESS_DIR;
  if (platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "xyz.block.buzz.app",
      "custom_harnesses",
    );
  }
  throw new Error("Set BUZZ_CUSTOM_HARNESS_DIR to the Buzz custom_harnesses directory");
}

export async function installHarness(
  directory: string,
  definition: HarnessDefinition,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${definition.id}.json`);
  await writeFile(path, `${JSON.stringify(definition, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function uninstallHarness(directory: string): Promise<string> {
  const path = join(directory, "eve-buzz-acp-adapter.json");
  await rm(path, { force: true });
  return path;
}
