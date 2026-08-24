#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildEmbeddedApplication, createEmbeddedLocalExecutor } from "eve/embedded";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = "embedded-agent.mjs";
const help = `Usage: embedded-triage <command>

Commands:
  run <ticket.json>  Triage the support ticket in a JSON file
  build              Build the production application

Options:
  -h, --help         Show this help message`;
const [command, argument, ...extraArguments] = process.argv.slice(2);

try {
  if ((command === "-h" || command === "--help") && argument === undefined) {
    console.log(help);
  } else if (command === "run" && argument !== undefined && extraArguments.length === 0) {
    await runTicket(argument);
  } else if (command === "build" && argument === undefined) {
    await buildApplication();
  } else {
    throw new Error(`${help}\n\nRun "embedded-triage --help" for usage information.`);
  }
} catch (error) {
  console.error(`Ticket triage failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function runTicket(ticketPath) {
  const ticket = JSON.parse(await readFile(resolve(process.cwd(), ticketPath), "utf8"));
  if (typeof ticket !== "object" || ticket === null || Array.isArray(ticket)) {
    throw new Error("The ticket file must contain a JSON object.");
  }

  console.error("Triaging support ticket...");
  const executor = await createEmbeddedLocalExecutor({ appRoot, entrypoint });
  try {
    const completed = await executor.run({ input: ticket });
    process.stdout.write(`${JSON.stringify(completed.result, null, 2)}\n`);
    console.error("Support ticket triage complete.");
  } finally {
    await executor.close();
  }
}

async function buildApplication() {
  console.error("Building support triage application...");
  const built = await buildEmbeddedApplication({ appRoot, entrypoint });
  process.stdout.write(`${built.outputDirectory}\n`);
  console.error("Support triage application build complete.");
}
