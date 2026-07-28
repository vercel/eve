import { spawn } from "node:child_process";

export interface RegistrySetupCommand {
  command: string;
  args: string[];
}

/** Executes a trusted registry setup command in the consuming project. */
export function runRegistrySetupCommand(
  appRoot: string,
  setup: RegistrySetupCommand,
): Promise<void> {
  const command = setup.command;
  const args = setup.args;

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: appRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal === null
            ? `Setup command exited with code ${code ?? "unknown"}.`
            : `Setup command was terminated by ${signal}.`,
        ),
      );
    });
  });
}
