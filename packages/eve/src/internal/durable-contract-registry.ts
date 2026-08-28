import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

/** Stable kind for eve's durable compatibility inventory. */
export const DURABLE_CONTRACT_MANIFEST_KIND = "eve-durable-contracts";

/** Current durable-contract manifest format. */
export const DURABLE_CONTRACT_MANIFEST_FORMAT_VERSION = 2;

/** Filename emitted at the root of the built eve package. */
export const DURABLE_CONTRACT_MANIFEST_FILENAME = "durable-contract-manifest.json";

interface DurableWorkflowContract {
  readonly acceptedInputVersions: readonly number[];
  readonly inputSchemaHashes: Readonly<Record<string, string | null>>;
  readonly inputVersion: number | null;
  readonly name: string;
  readonly workflowId: string;
}

interface DurableDataContract {
  readonly acceptedVersions: readonly number[] | null;
  readonly currentVersion: number;
  readonly name: string;
  readonly schemaHashes: Readonly<Record<string, string | null>> | null;
}

function stableWorkflowContract<TName extends string>(
  name: TName,
  inputVersion: number | null,
): DurableWorkflowContract & { readonly name: TName } {
  return {
    acceptedInputVersions: [0, 1],
    inputSchemaHashes: { 0: null, 1: null },
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
  attachmentRef: {
    acceptedVersions: [1],
    currentVersion: 1,
    name: "attachmentRef",
    schemaHashes: { 1: null },
  },
  durableSession: {
    acceptedVersions: [1],
    currentVersion: 1,
    name: "durableSession",
    schemaHashes: { 1: null },
  },
  messageStream: {
    acceptedVersions: null,
    currentVersion: 23,
    name: "messageStream",
    schemaHashes: null,
  },
  sessionInboxWire: {
    acceptedVersions: [0, 1],
    currentVersion: 1,
    name: "sessionInboxWire",
    schemaHashes: { 0: null, 1: null },
  },
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

export interface DurableContractSchemaHashes {
  readonly dataContracts?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly workflows?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Creates eve's deterministic durable compatibility inventory. */
export function createDurableContractManifest(
  builtWithEve: string,
  schemaHashes: DurableContractSchemaHashes = {},
): DurableContractManifest {
  assertDurableContractRegistry();
  if (builtWithEve.length === 0) {
    throw new Error("Durable contract manifest requires a non-empty eve version.");
  }

  return {
    builtWithEve,
    dataContracts: sortedContracts(DURABLE_DATA_CONTRACTS).map((contract) =>
      applySchemaHashes(contract, schemaHashes.dataContracts?.[contract.name]),
    ),
    formatVersion: DURABLE_CONTRACT_MANIFEST_FORMAT_VERSION,
    kind: DURABLE_CONTRACT_MANIFEST_KIND,
    workflows: sortedContracts(DURABLE_WORKFLOW_CONTRACTS).map((contract) => ({
      ...contract,
      inputSchemaHashes: mergeSchemaHashes(
        `${contract.name} input`,
        contract.inputSchemaHashes,
        schemaHashes.workflows?.[contract.name],
      ),
    })),
  };
}

/** Serializes eve's durable compatibility inventory deterministically. */
export function serializeDurableContractManifest(
  builtWithEve: string,
  schemaHashes: DurableContractSchemaHashes = {},
): string {
  return `${JSON.stringify(createDurableContractManifest(builtWithEve, schemaHashes), null, 2)}\n`;
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
      assertAcceptedVersions(
        `${contract.name} input`,
        contract.inputVersion,
        contract.acceptedInputVersions,
        contract.inputSchemaHashes,
      );
    }
    workflowNames.add(contract.name);
    workflowIds.add(contract.workflowId);
  }

  for (const [key, contract] of Object.entries(
    DURABLE_DATA_CONTRACTS as Record<string, DurableDataContract>,
  )) {
    if (key !== contract.name) {
      throw new Error(`Durable data registry key "${key}" must match name "${contract.name}".`);
    }
    assertPositiveVersion(contract.name, contract.currentVersion);
    if (contract.acceptedVersions === null) {
      if (contract.schemaHashes !== null) {
        throw new Error(
          `Durable contract "${contract.name}" has hashes without accepted versions.`,
        );
      }
    } else {
      if (contract.schemaHashes === null) {
        throw new Error(`Durable contract "${contract.name}" is missing per-version hashes.`);
      }
      assertAcceptedVersions(
        contract.name,
        contract.currentVersion,
        contract.acceptedVersions,
        contract.schemaHashes,
      );
    }
  }
}

function assertAcceptedVersions(
  name: string,
  currentVersion: number,
  acceptedVersions: readonly number[],
  schemaHashes: Readonly<Record<string, string | null>>,
): void {
  if (!acceptedVersions.includes(currentVersion)) {
    throw new Error(`Durable contract "${name}" must accept its current version.`);
  }
  for (const [index, version] of acceptedVersions.entries()) {
    if (
      !Number.isInteger(version) ||
      version < 0 ||
      (index > 0 && version <= acceptedVersions[index - 1]!)
    ) {
      throw new Error(`Durable contract "${name}" accepted versions must be sorted and unique.`);
    }
  }
  if (Object.keys(schemaHashes).join(",") !== acceptedVersions.join(",")) {
    throw new Error(`Durable contract "${name}" must identify every accepted version schema.`);
  }
}

function applySchemaHashes<TContract extends DurableDataContract>(
  contract: TContract,
  schemaHashes: Readonly<Record<string, string>> | undefined,
): TContract {
  if (contract.schemaHashes === null) {
    if (schemaHashes !== undefined) {
      throw new Error(`Durable contract "${contract.name}" has no declared accepted versions.`);
    }
    return contract;
  }
  return {
    ...contract,
    schemaHashes: mergeSchemaHashes(contract.name, contract.schemaHashes, schemaHashes),
  };
}

function mergeSchemaHashes(
  name: string,
  declared: Readonly<Record<string, string | null>>,
  provided: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string | null>> {
  if (provided === undefined) {
    return declared;
  }
  for (const [version, hash] of Object.entries(provided)) {
    if (!(version in declared)) {
      throw new Error(`Durable contract "${name}" has a hash for unaccepted version ${version}.`);
    }
    if (!/^sha256:[\da-f]{64}$/u.test(hash)) {
      throw new Error(`Durable contract "${name}" has an invalid SHA-256 schema hash.`);
    }
  }
  return { ...declared, ...provided };
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
