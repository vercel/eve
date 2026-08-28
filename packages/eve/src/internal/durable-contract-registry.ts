import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

/** Stable kind for eve's durable compatibility inventory. */
export const DURABLE_CONTRACT_MANIFEST_KIND = "eve-durable-contracts";

/** Current durable-contract manifest format. */
export const DURABLE_CONTRACT_MANIFEST_FORMAT_VERSION = 1;

/** Filename emitted at the root of the built eve package. */
export const DURABLE_CONTRACT_MANIFEST_FILENAME = "durable-contract-manifest.json";

interface DurableWorkflowContract {
  readonly inputVersion: number | null;
  readonly name: string;
  readonly workflowId: string;
}

interface DurableDataContract {
  readonly currentVersion: number;
  readonly name: string;
}

function stableWorkflowContract<TName extends string>(
  name: TName,
  inputVersion: number | null,
): DurableWorkflowContract & { readonly name: TName } {
  return {
    inputVersion,
    name,
    workflowId: `workflow//${EVE_PACKAGE_NAME}//${name}`,
  };
}

/** Cross-deployment workflow entrypoints and their existing input versions. */
export const DURABLE_WORKFLOW_CONTRACTS = {
  sessionTimeoutWorkflow: stableWorkflowContract("sessionTimeoutWorkflow", 1),
  taskRunWorkflow: stableWorkflowContract("taskRunWorkflow", 1),
  turnWorkflow: stableWorkflowContract("turnWorkflow", 1),
  workflowEntry: stableWorkflowContract("workflowEntry", 1),
} as const satisfies Record<string, DurableWorkflowContract>;

/** Existing explicitly versioned values that cross durable boundaries. */
export const DURABLE_DATA_CONTRACTS = {
  attachmentRef: { currentVersion: 1, name: "attachmentRef" },
  durableSession: { currentVersion: 1, name: "durableSession" },
  messageStream: { currentVersion: 23, name: "messageStream" },
  sessionInboxWire: { currentVersion: 1, name: "sessionInboxWire" },
} as const satisfies Record<string, DurableDataContract>;

/** Workflow names whose ids intentionally omit the eve package version. */
export const STABLE_WORKFLOW_NAMES: ReadonlySet<string> = new Set(
  Object.values(DURABLE_WORKFLOW_CONTRACTS).map((contract) => contract.name),
);

export interface DurableContractManifest {
  readonly builtWithEve: string;
  readonly dataContracts: readonly DurableDataContract[];
  readonly formatVersion: typeof DURABLE_CONTRACT_MANIFEST_FORMAT_VERSION;
  readonly kind: typeof DURABLE_CONTRACT_MANIFEST_KIND;
  readonly workflows: readonly DurableWorkflowContract[];
}

/** Creates eve's deterministic durable compatibility inventory. */
export function createDurableContractManifest(builtWithEve: string): DurableContractManifest {
  assertDurableContractRegistry();
  if (builtWithEve.length === 0) {
    throw new Error("Durable contract manifest requires a non-empty eve version.");
  }

  return {
    builtWithEve,
    dataContracts: sortedContracts(DURABLE_DATA_CONTRACTS),
    formatVersion: DURABLE_CONTRACT_MANIFEST_FORMAT_VERSION,
    kind: DURABLE_CONTRACT_MANIFEST_KIND,
    workflows: sortedContracts(DURABLE_WORKFLOW_CONTRACTS),
  };
}

/** Serializes eve's durable compatibility inventory deterministically. */
export function serializeDurableContractManifest(builtWithEve: string): string {
  return `${JSON.stringify(createDurableContractManifest(builtWithEve), null, 2)}\n`;
}

function assertDurableContractRegistry(): void {
  const workflowNames = new Set<string>();
  const workflowIds = new Set<string>();

  for (const [key, contract] of Object.entries(DURABLE_WORKFLOW_CONTRACTS)) {
    if (key !== contract.name) {
      throw new Error(`Durable workflow registry key "${key}" must match name "${contract.name}".`);
    }
    if (workflowNames.has(contract.name) || workflowIds.has(contract.workflowId)) {
      throw new Error(`Duplicate durable workflow contract "${contract.name}".`);
    }
    if (contract.workflowId !== `workflow//${EVE_PACKAGE_NAME}//${contract.name}`) {
      throw new Error(`Durable workflow "${contract.name}" has an unstable workflow id.`);
    }
    if (contract.inputVersion !== null) {
      assertPositiveVersion(`${contract.name} input`, contract.inputVersion);
    }
    workflowNames.add(contract.name);
    workflowIds.add(contract.workflowId);
  }

  for (const [key, contract] of Object.entries(DURABLE_DATA_CONTRACTS)) {
    if (key !== contract.name) {
      throw new Error(`Durable data registry key "${key}" must match name "${contract.name}".`);
    }
    assertPositiveVersion(contract.name, contract.currentVersion);
  }
}

function assertPositiveVersion(name: string, version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Durable contract "${name}" must have a positive integer version.`);
  }
}

function sortedContracts<TContract extends { readonly name: string }>(
  contracts: Readonly<Record<string, TContract>>,
): TContract[] {
  return Object.values(contracts).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}
