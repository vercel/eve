import assert from "node:assert/strict";
import test from "node:test";

import { findDurableContractRegressions } from "./durable-contract-regression.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function manifest({
  dataContracts = [dataContract()],
  formatVersion = 2,
  workflows = [workflowContract()],
} = {}) {
  return {
    builtWithEve: "1.0.0",
    dataContracts,
    formatVersion,
    kind: "eve-durable-contracts",
    workflows,
  };
}

function dataContract(overrides = {}) {
  return {
    acceptedVersions: [0, 1],
    currentVersion: 1,
    name: "sessionInboxWire",
    schemaHashes: { 0: null, 1: HASH_A },
    ...overrides,
  };
}

function workflowContract(overrides = {}) {
  return {
    acceptedInputVersions: [0, 1],
    inputSchemaHashes: { 0: null, 1: null },
    inputVersion: 1,
    name: "turnWorkflow",
    workflowId: "workflow//eve//turnWorkflow",
    ...overrides,
  };
}

test("accepts a format-1 bootstrap manifest", () => {
  const base = manifest({
    dataContracts: [
      { currentVersion: 23, name: "messageStream" },
      { currentVersion: 1, name: "sessionInboxWire" },
    ],
    formatVersion: 1,
    workflows: [
      {
        inputVersion: 1,
        name: "turnWorkflow",
        workflowId: "workflow//eve//turnWorkflow",
      },
    ],
  });
  const candidate = manifest({
    dataContracts: [
      dataContract({
        acceptedVersions: null,
        currentVersion: 23,
        name: "messageStream",
        schemaHashes: null,
      }),
      dataContract(),
    ],
  });
  assert.deepEqual(findDurableContractRegressions(base, candidate), []);
});

test("requires a format-1 current version to remain accepted after a bump", () => {
  const base = manifest({
    dataContracts: [{ currentVersion: 1, name: "sessionInboxWire" }],
    formatVersion: 1,
    workflows: [],
  });
  const candidate = manifest({
    dataContracts: [
      dataContract({ acceptedVersions: [2], currentVersion: 2, schemaHashes: { 2: null } }),
    ],
    workflows: [],
  });
  assert.match(
    findDurableContractRegressions(base, candidate).join("\n"),
    /without accepting previous current version 1/u,
  );
});

test("rejects durable contract removal", () => {
  assert.deepEqual(findDurableContractRegressions(manifest(), manifest({ dataContracts: [] })), [
    'Removed durable data contract "sessionInboxWire".',
  ]);
});

test("rejects a stable workflow id change", () => {
  const candidate = manifest({
    workflows: [workflowContract({ workflowId: "workflow//eve//renamed" })],
  });
  assert.match(
    findDurableContractRegressions(manifest(), candidate).join("\n"),
    /stable workflow id/u,
  );
});

test("rejects a current-version decrease", () => {
  const candidate = manifest({
    dataContracts: [
      dataContract({ acceptedVersions: [0], currentVersion: 0, schemaHashes: { 0: null } }),
    ],
  });
  assert.match(findDurableContractRegressions(manifest(), candidate).join("\n"), /Decreased/u);
});

test("rejects accepted-version removal", () => {
  const candidate = manifest({
    dataContracts: [dataContract({ acceptedVersions: [1], schemaHashes: { 1: HASH_A } })],
  });
  assert.match(findDurableContractRegressions(manifest(), candidate).join("\n"), /version 0/u);
});

test("rejects a same-version schema hash change", () => {
  const candidate = manifest({
    dataContracts: [dataContract({ schemaHashes: { 0: null, 1: HASH_B } })],
  });
  assert.match(
    findDurableContractRegressions(manifest(), candidate).join("\n"),
    /Changed schema hash/u,
  );
});

test("rejects schema hash removal", () => {
  const candidate = manifest({
    dataContracts: [dataContract({ schemaHashes: { 0: null, 1: null } })],
  });
  assert.match(
    findDurableContractRegressions(manifest(), candidate).join("\n"),
    /Removed schema hash/u,
  );
});

test("rejects dropping the previous current version on a bump", () => {
  const candidate = manifest({
    dataContracts: [
      dataContract({ acceptedVersions: [2], currentVersion: 2, schemaHashes: { 2: null } }),
    ],
  });
  assert.match(
    findDurableContractRegressions(manifest(), candidate).join("\n"),
    /without accepting previous current version 1/u,
  );
});
