import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const composeFile = fileURLToPath(new URL("../compose.yaml", import.meta.url));

async function resolveComposeCommand(): Promise<{ command: string; prefix: string[] }> {
  try {
    await runFile("docker", ["compose", "version"]);
    return { command: "docker", prefix: ["compose"] };
  } catch {
    await runFile("docker-compose", ["version"]);
    return { command: "docker-compose", prefix: [] };
  }
}

export async function runCompose(arguments_: string[]): Promise<void> {
  const compose = await resolveComposeCommand();
  await runFile(compose.command, [...compose.prefix, "-f", composeFile, ...arguments_], {
    env: process.env,
  });
}
