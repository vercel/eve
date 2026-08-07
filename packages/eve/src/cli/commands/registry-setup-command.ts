import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "#compiled/zod/index.js";
import { createProcessOutputBuffer } from "#setup/primitives/process-output.js";
import type { Prompter, PrompterValue } from "#setup/prompter.js";
import {
  isRegistrySetupChildMessage,
  REGISTRY_SETUP_PROTOCOL_VERSION,
  type RegistrySetupChildMessage,
  type RegistrySetupCompletion,
  type RegistrySetupParentMessage,
} from "#setup/registry-setup-protocol.js";
import { WizardCancelledError } from "#setup/step.js";

export interface RegistrySetupCommand {
  package: string;
  bin: string;
  args: string[];
}

export type RegistrySetupCommandResult =
  | ({ kind: "completed" } & RegistrySetupCompletion)
  | { kind: "cancelled" };

export interface RegistrySetupCommandOptions {
  prompter: Prompter;
  signal?: AbortSignal;
}

const PackageJsonSchema = z.object({
  name: z.string().min(1),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
});

type PackageJson = z.infer<typeof PackageJsonSchema>;

function declaredBinPath(packageJson: PackageJson, binName: string): string | undefined {
  if (typeof packageJson.bin === "string") {
    const defaultBinName = packageJson.name.slice(packageJson.name.lastIndexOf("/") + 1);
    return binName === defaultBinName ? packageJson.bin : undefined;
  }
  return packageJson.bin?.[binName];
}

async function resolveNodePackageBin(packageJsonPath: string, binName: string): Promise<string> {
  const packageRoot = dirname(packageJsonPath);
  const packageJson = PackageJsonSchema.parse(JSON.parse(await readFile(packageJsonPath, "utf8")));
  const declaredPath = declaredBinPath(packageJson, binName);
  if (declaredPath === undefined) {
    throw new Error(`Package "${packageJson.name}" does not declare a "${binName}" binary.`);
  }

  const executable = resolve(packageRoot, declaredPath);
  const packageRelativePath = relative(packageRoot, executable);
  if (packageRelativePath.startsWith("..") || isAbsolute(packageRelativePath)) {
    throw new Error(
      `Package "${packageJson.name}" declares its "${binName}" binary outside the package directory.`,
    );
  }
  return executable;
}

function send(child: ChildProcess, message: RegistrySetupParentMessage): void {
  if (child.connected) child.send(message);
}

async function answerPrompt(
  child: ChildProcess,
  prompter: Prompter,
  message: Extract<RegistrySetupChildMessage, { type: "prompt" }>,
  openHandles: Map<number, () => void>,
): Promise<void> {
  try {
    let value: unknown;
    const request = message.prompt;
    switch (request.kind) {
      case "text":
        value = await prompter.text(request);
        break;
      case "password":
        value = await prompter.password(request);
        break;
      case "select":
        value = request.options.multiple
          ? await prompter.select(request.options)
          : await prompter.select(request.options);
        break;
      case "editable-select":
        if (prompter.selectEditable === undefined) {
          const selected = await prompter.select(request.options);
          value = { kind: "selected", value: selected };
        } else {
          value = await prompter.selectEditable({
            ...request.options,
            editable: {
              ...request.options.editable,
              formatHint: (text) => text,
            },
          });
        }
        break;
      case "acknowledge":
        await prompter.acknowledge?.(request.options);
        break;
      case "choice": {
        if (prompter.awaitChoice === undefined) {
          value = await prompter.select<PrompterValue>({
            message: request.options.context,
            options: [...request.options.actions],
          });
          break;
        }
        const choice = prompter.awaitChoice(request.options);
        openHandles.set(message.id, choice.close);
        try {
          value = await choice.choice;
        } finally {
          openHandles.delete(message.id);
        }
        break;
      }
    }
    send(child, { type: "prompt-result", id: message.id, value });
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      send(child, { type: "prompt-result", id: message.id, cancelled: true });
      return;
    }
    throw error;
  }
}

function handlePresentation(
  child: ChildProcess,
  prompter: Prompter,
  message: RegistrySetupChildMessage,
  openChoices: Map<number, () => void>,
): boolean {
  switch (message.type) {
    case "log":
      if (
        prompter.replaceContent === undefined ||
        message.level === "warning" ||
        message.level === "error" ||
        message.level === "commandOutput"
      ) {
        prompter.log[message.level](message.text);
      }
      return true;
    case "note":
      if (prompter.replaceContent === undefined || message.tone === "warning") {
        prompter.note(message.message, message.title, { tone: message.tone });
      }
      return true;
    case "intro":
      prompter.intro(message.text, message.subtitle);
      return true;
    case "outro":
      prompter.outro(message.text);
      return true;
    case "result":
      return false;
    case "status": {
      openChoices.get(message.id)?.();
      openChoices.delete(message.id);
      if (message.status !== undefined) {
        const spinner = prompter.log.spinner?.(message.status);
        if (spinner !== undefined) openChoices.set(message.id, () => spinner.stop());
      }
      return true;
    }
    case "close-prompt":
      openChoices.get(message.id)?.();
      openChoices.delete(message.id);
      return true;
    case "prompt":
      void answerPrompt(child, prompter, message, openChoices).catch((error: unknown) => {
        terminateChild(child, "SIGTERM");
        child.emit("error", error as Error);
      });
      return true;
    case "ready":
      return false;
  }
}

/** Executes a trusted setup binary while the parent prompter owns all terminal interaction. */
export async function runRegistrySetupCommand(
  appRoot: string,
  setup: RegistrySetupCommand,
  item: string,
  options?: RegistrySetupCommandOptions,
): Promise<RegistrySetupCommandResult> {
  const packageJsonPath = findPackageJSON(
    setup.package,
    pathToFileURL(resolve(appRoot, "package.json")),
  );
  if (packageJsonPath === undefined) {
    throw new Error(
      `Setup package "${setup.package}" is not installed. Run \`eve add ${item}\` first.`,
    );
  }
  const executable = await resolveNodePackageBin(packageJsonPath, setup.bin);
  if (options === undefined) {
    throw new Error("Registry setup commands require a parent prompter.");
  }

  return new Promise<RegistrySetupCommandResult>((resolveResult, reject) => {
    const child = spawn(process.execPath, [executable, ...setup.args], {
      cwd: appRoot,
      env: {
        ...process.env,
        EVE_SETUP: "1",
        EVE_SETUP_ITEM: item,
        EVE_SETUP_PROTOCOL: String(REGISTRY_SETUP_PROTOCOL_VERSION),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    let ready = false;
    let outcome: Extract<RegistrySetupChildMessage, { type: "result" }>["outcome"] | undefined;
    const openHandles = new Map<number, () => void>();
    const output = createProcessOutputBuffer(({ text }) =>
      options.prompter.log.commandOutput(text),
    );
    child.stdout?.on("data", (chunk: Buffer) => output.write("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.write("stderr", chunk));

    let cancelTimer: NodeJS.Timeout | undefined;
    const cancel = (): void => {
      send(child, { type: "cancel" });
      cancelTimer = setTimeout(() => terminateChild(child, "SIGTERM"), 3_000);
      cancelTimer.unref();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const cleanup = (): void => {
      output.flush();
      options.signal?.removeEventListener("abort", cancel);
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      for (const close of openHandles.values()) close();
      openHandles.clear();
    };
    child.on("message", (value: unknown) => {
      if (!isRegistrySetupChildMessage(value)) {
        cancel();
        reject(new Error("Setup command sent an invalid registry protocol message."));
        return;
      }
      if (value.type === "ready") {
        if (value.version !== REGISTRY_SETUP_PROTOCOL_VERSION) {
          cancel();
          reject(
            new Error(
              `Setup command does not support registry setup protocol v${REGISTRY_SETUP_PROTOCOL_VERSION}.`,
            ),
          );
          return;
        }
        ready = true;
        return;
      }
      if (value.type === "result") {
        outcome = value.outcome;
        return;
      }
      handlePresentation(child, options.prompter, value, openHandles);
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (outcome?.kind === "completed") {
        if (code !== 0) {
          reject(
            new Error(
              `Setup command reported success, then exited with code ${code ?? "unknown"}.`,
            ),
          );
          return;
        }
        const result: RegistrySetupCommandResult = {
          kind: "completed",
          facts: outcome.facts,
        };
        if (outcome.deploymentRequired === true) result.deploymentRequired = true;
        resolveResult(result);
        return;
      }
      if (outcome?.kind === "cancelled") {
        resolveResult({ kind: "cancelled" });
        return;
      }
      if (outcome?.kind === "failed") {
        reject(new Error(outcome.error.message));
        return;
      }
      if (options.signal?.aborted === true || code === 130 || signal === "SIGINT") {
        resolveResult({ kind: "cancelled" });
        return;
      }
      if (code === 0 && ready) {
        reject(new Error("Setup command exited without reporting a result."));
        return;
      }
      reject(
        new Error(
          signal === null
            ? `Setup command exited with code ${code ?? "unknown"} before reporting a result.`
            : `Setup command was terminated by ${signal} before reporting a result.`,
        ),
      );
    });
  });
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}
