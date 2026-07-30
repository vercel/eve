#!/usr/bin/env node

import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrompter, WizardCancelledError } from "eve/setup";
import { readEveTargetInfo, resolveBundledEveBin } from "./eve-target.js";
import {
  buildHarnessDefinition,
  defaultHarnessDirectory,
  installHarness,
  uninstallHarness,
} from "./harness.js";
import {
  chooseInstallTarget,
  classifyRemoteTarget,
  classifyTarget,
  confirmInstall,
  type InstallPrompter,
  type InstallTarget,
} from "./install-flow.js";
import { runProxy } from "./proxy.js";
import { readInstallTargetInfo } from "./remote-target-auth.js";

interface CliOptions {
  command: "run" | "install" | "uninstall" | "doctor" | "help";
  target?: string;
  targetKind?: "local" | "remote";
  eveBin: string;
  buzzCli: string;
  harnessDirectory?: string;
  modelId?: string;
  yes: boolean;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }

  const cwd = process.env.EVE_APP_DIR || process.cwd();
  const explicitTarget = resolveExplicitTarget(options, cwd);
  if (options.command === "install") {
    await runInstall(options, cwd, explicitTarget);
    return;
  }

  if (options.command === "uninstall") {
    const directory =
      options.harnessDirectory ?? defaultHarnessDirectory(process.env, process.platform);
    const path = await uninstallHarness(directory);
    console.log(`Removed the eve Buzz harness at ${path}`);
    return;
  }

  if (options.command === "doctor") {
    await access(options.eveBin);
    const info = await readEveTargetInfo(
      explicitTarget
        ? eveTargetOptions(explicitTarget, options.eveBin)
        : { eveBin: options.eveBin, cwd },
    );
    console.log(`eve target: ${info.name}`);
    console.log(`authored model: ${info.modelId}`);
    console.log(`eve executable: ${options.eveBin}`);
    console.log(`Buzz CLI: ${options.buzzCli}`);
    return;
  }

  let modelId = options.modelId ?? process.env.EVE_MODEL_ID;
  if (!modelId) {
    try {
      modelId = (
        await readEveTargetInfo(
          explicitTarget
            ? eveTargetOptions(explicitTarget, options.eveBin)
            : { eveBin: options.eveBin, cwd },
        )
      ).modelId;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[eve-buzz-acp-adapter] could not discover the authored model: ${detail}`);
    }
  }

  const proxyOptions: Parameters<typeof runProxy>[0] = {
    buzzCli: options.buzzCli,
    cwd: explicitTarget?.kind === "local" ? explicitTarget.directory : cwd,
    environment: process.env,
    eveBin: options.eveBin,
    input: process.stdin,
    output: process.stdout,
    publishTimeoutMs: Number(process.env.BUZZ_PUBLISH_TIMEOUT_MS || 20_000),
  };
  if (modelId) proxyOptions.modelId = modelId;
  if (explicitTarget?.kind === "remote") proxyOptions.target = explicitTarget.url;
  await runProxy(proxyOptions);
}

async function runInstall(
  options: CliOptions,
  cwd: string,
  explicitTarget: InstallTarget | undefined,
): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const prompter = interactive ? createPrompter() : undefined;
  prompter?.intro("eve + Buzz", "Connect an eve agent to Buzz.");

  const chooseOptions: Parameters<typeof chooseInstallTarget>[0] = { cwd, interactive };
  if (explicitTarget) chooseOptions.explicitTarget = explicitTarget;
  if (prompter) chooseOptions.prompter = prompter as InstallPrompter;
  const target = await chooseInstallTarget(chooseOptions);
  const { info, vercelScope } = await readInstallTargetInfo({
    cwd,
    eveBin: options.eveBin,
    prompter,
    target,
  });
  const directory =
    options.harnessDirectory ?? defaultHarnessDirectory(process.env, process.platform);
  prompter?.log.success(`Found ${info.name}`);
  prompter?.log.info(`Authored model: ${info.modelId}`);
  prompter?.log.info(`Target: ${target.kind === "remote" ? target.url : target.directory}`);
  prompter?.log.info(`Buzz CLI: ${options.buzzCli}`);
  prompter?.log.info(`Harness: ${join(directory, "eve-buzz-acp-adapter.json")}`);

  const confirmOptions: Parameters<typeof confirmInstall>[0] = {
    interactive,
    yes: options.yes,
  };
  if (prompter) confirmOptions.prompter = prompter as InstallPrompter;
  if (!(await confirmInstall(confirmOptions))) {
    prompter?.outro("No changes made.");
    return;
  }

  const harnessOptions: Parameters<typeof buildHarnessDefinition>[0] = {
    buzzCli: options.buzzCli,
    cliPath: fileURLToPath(import.meta.url),
    modelId: options.modelId ?? info.modelId,
    nodePath: process.execPath,
  };
  if (vercelScope) harnessOptions.vercelScope = vercelScope;
  if (target.kind === "remote") harnessOptions.target = target.url;
  else harnessOptions.appDirectory = target.directory;
  const path = await installHarness(directory, buildHarnessDefinition(harnessOptions));

  if (prompter) {
    prompter.log.success(`Installed the Buzz harness at ${path}`);
    prompter.outro("Reopen Buzz, then select eve as the agent harness.");
  } else {
    console.log(`Installed the eve Buzz harness at ${path}`);
    console.log("Reopen Buzz, then select eve as the agent harness.");
  }
}

function eveTargetOptions(
  target: InstallTarget,
  eveBin: string,
): Parameters<typeof readEveTargetInfo>[0] {
  if (target.kind === "remote") return { eveBin, target: target.url, cwd: process.cwd() };
  return { eveBin, cwd: target.directory };
}

function resolveExplicitTarget(options: CliOptions, cwd: string): InstallTarget | undefined {
  if (!options.target) return undefined;
  if (options.targetKind === "local") {
    return { kind: "local", directory: resolve(cwd, options.target) };
  }
  if (options.targetKind === "remote") return classifyRemoteTarget(options.target);
  return classifyTarget(options.target, cwd);
}

function parseArguments(arguments_: string[]): CliOptions {
  let command: CliOptions["command"] = "run";
  let target: string | undefined;
  let targetKind: CliOptions["targetKind"];
  let eveBin = process.env.EVE_BIN || resolveBundledEveBin();
  let buzzCli = process.env.BUZZ_CLI || defaultBuzzCli();
  let harnessDirectory: string | undefined;
  let modelId: string | undefined;
  let yes = false;

  const argumentsCopy = [...arguments_];
  if (["install", "uninstall", "doctor"].includes(argumentsCopy[0] ?? "")) {
    command = argumentsCopy.shift() as CliOptions["command"];
  } else if (["help", "--help", "-h"].includes(argumentsCopy[0] ?? "")) {
    return { command: "help", eveBin, buzzCli, yes };
  }

  while (argumentsCopy.length > 0) {
    const argument = argumentsCopy.shift()!;
    if (argument === "--eve-bin") eveBin = requiredValue(argument, argumentsCopy.shift());
    else if (argument === "--buzz-cli") buzzCli = requiredValue(argument, argumentsCopy.shift());
    else if (argument === "--harness-dir") {
      harnessDirectory = requiredValue(argument, argumentsCopy.shift());
    } else if (argument === "--model") modelId = requiredValue(argument, argumentsCopy.shift());
    else if (argument === "--local" || argument === "--url") {
      if (target !== undefined) throw new Error("Specify only one target");
      target = requiredValue(argument, argumentsCopy.shift());
      targetKind = argument === "--local" ? "local" : "remote";
    } else if (argument === "--yes" || argument === "-y") yes = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (target === undefined) target = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }

  const options: CliOptions = { command, eveBin, buzzCli, yes };
  if (target) options.target = target;
  if (targetKind) options.targetKind = targetKind;
  if (harnessDirectory) options.harnessDirectory = harnessDirectory;
  if (modelId) options.modelId = modelId;
  return options;
}

function defaultBuzzCli(): string {
  const macOsBundledCli = "/Applications/Buzz.app/Contents/MacOS/buzz";
  return process.platform === "darwin" && existsSync(macOsBundledCli) ? macOsBundledCli : "buzz";
}

function requiredValue(option: string, value: string | undefined): string {
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  eve-buzz-acp-adapter [target]
  eve-buzz-acp-adapter install [target]
  eve-buzz-acp-adapter uninstall
  eve-buzz-acp-adapter doctor [target]

Targets may be a local eve application directory or an HTTP(S) deployment URL.
Running install without a target starts the interactive setup flow.

Options:
  --local <directory>    local eve application directory
  --url <url>            deployed eve application URL
  -y, --yes              confirm a non-interactive install
  --eve-bin <path>       eve executable to launch
  --buzz-cli <path>      Buzz CLI executable
  --harness-dir <path>   Buzz custom_harnesses directory
  --model <id>           authored eve model override`);
}

main().catch((error: unknown) => {
  if (error instanceof WizardCancelledError) {
    process.exitCode = 1;
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[eve-buzz-acp-adapter] ${detail}`);
  process.exitCode = 1;
});
