import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { SelfModificationHarness, SelfModificationRun } from "./harness";

export async function verifyRegistryHandoff(input: {
  readonly address: string;
  readonly run: SelfModificationRun;
  readonly selfMod: SelfModificationHarness;
}): Promise<void> {
  const { address, run, selfMod } = input;
  assertDiscovered(run, address);
  const pending = run.child.toolCalls.filter((call) => call.name === "registry_add");
  if (pending.length !== 1 || pending[0]?.input.address !== address) {
    throw new Error(`Self-modification did not request ${address} exactly once.`);
  }
  const handoff = await selfMod.approveRegistry(run);
  const result = handoff.toolCalls.find((call) => call.name === "registry_add");
  if (
    result?.status !== "completed" ||
    (result.output as { nextCommand?: unknown; status?: unknown } | undefined)?.status !==
      "needs-terminal" ||
    (result.output as { nextCommand?: unknown } | undefined)?.nextCommand !== `eve add ${address}`
  ) {
    throw new Error(`Self-modification did not hand ${address} off to the terminal.`);
  }
  await selfMod.assertOnlyChanged([]);
}

export async function verifyRegistryInstall(input: {
  readonly address: string;
  readonly source: string;
  readonly target: string;
  readonly run: SelfModificationRun;
  readonly selfMod: SelfModificationHarness;
}): Promise<void> {
  const { address, source, target, run, selfMod } = input;
  assertDiscovered(run, address);
  const pending = run.child.toolCalls.filter((call) => call.name === "registry_add");
  if (pending.length !== 1 || pending[0]?.input.address !== address) {
    throw new Error(`Self-modification did not request ${address} exactly once.`);
  }
  const installed = await selfMod.approveRegistry(run);
  const result = installed.toolCalls.find((call) => call.name === "registry_add");
  if (
    result?.status !== "completed" ||
    (result.output as { status?: unknown } | undefined)?.status !== "installed"
  ) {
    throw new Error(`Self-modification did not install ${address}.`);
  }
  await selfMod.assertOnlyChanged([target]);
  const expected = await readFile(resolve(process.cwd(), "../../../apps/docs", source), "utf8");
  const actual = await selfMod.readSource(target);
  if (actual !== expected) throw new Error(`${target} is not the official registry scaffold.`);
}

function assertDiscovered(run: SelfModificationRun, address: string): void {
  run.child.calledTool("search_registry");
  const discovered = run.child.toolCalls.some((call) => {
    if (call.name !== "search_registry" || call.status !== "completed") return false;
    const items = (call.output as { items?: unknown } | undefined)?.items;
    return Array.isArray(items) && items.some((item) => item.address === address);
  });
  if (!discovered)
    throw new Error(`Self-modification did not discover ${address} in the registry.`);
}
