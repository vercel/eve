import { describe, expect, it } from "vitest";

import { DURABLE_SESSION_VERSION } from "#execution/durable-session-store.js";
import { SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION } from "#execution/durable-session-migrations/session-timeout-workflow.js";
import { TASK_RUN_WORKFLOW_INPUT_VERSION } from "#execution/durable-session-migrations/task-run-workflow.js";
import { TURN_WORKFLOW_INPUT_VERSION } from "#execution/durable-session-migrations/turn-workflow.js";
import { WORKFLOW_ENTRY_INPUT_VERSION } from "#execution/durable-session-migrations/workflow-entry.js";
import {
  sessionTimeoutWorkflowReference,
  taskRunWorkflowReference,
  turnWorkflowReference,
  workflowEntryReference,
} from "#execution/workflow-runtime.js";
import { SESSION_INBOX_WIRE_VERSION } from "#execution/wire/session-inbox-contract.js";
import { ATTACHMENT_REF_WIRE_VERSION } from "#internal/attachments/refs.js";
import {
  createDurableContractManifest,
  DURABLE_DATA_CONTRACTS,
  DURABLE_WORKFLOW_CONTRACTS,
  serializeDurableContractManifest,
  STABLE_WORKFLOW_NAMES,
} from "#internal/durable-contract-registry.js";
import { EVE_MESSAGE_STREAM_VERSION } from "#protocol/message.js";

describe("durable contract registry", () => {
  it("owns every stable workflow id used by the runtime", () => {
    expect({
      sessionTimeoutWorkflow: sessionTimeoutWorkflowReference,
      taskRunWorkflow: taskRunWorkflowReference,
      turnWorkflow: turnWorkflowReference,
      workflowEntry: workflowEntryReference,
    }).toEqual(
      Object.fromEntries(
        Object.entries(DURABLE_WORKFLOW_CONTRACTS).map(([name, contract]) => [
          name,
          { workflowId: contract.workflowId },
        ]),
      ),
    );
    expect([...STABLE_WORKFLOW_NAMES].sort()).toEqual(
      Object.keys(DURABLE_WORKFLOW_CONTRACTS).sort(),
    );
  });

  it("matches the explicit versions owned by existing durable contracts", () => {
    expect(DURABLE_WORKFLOW_CONTRACTS).toMatchObject({
      sessionTimeoutWorkflow: { inputVersion: SESSION_TIMEOUT_WORKFLOW_INPUT_VERSION },
      taskRunWorkflow: { inputVersion: TASK_RUN_WORKFLOW_INPUT_VERSION },
      turnWorkflow: { inputVersion: TURN_WORKFLOW_INPUT_VERSION },
      workflowEntry: { inputVersion: WORKFLOW_ENTRY_INPUT_VERSION },
    });
    expect(DURABLE_DATA_CONTRACTS).toEqual({
      attachmentRef: {
        acceptedVersions: [1],
        currentVersion: Number(ATTACHMENT_REF_WIRE_VERSION),
        name: "attachmentRef",
        schemaHashes: { 1: null },
      },
      durableSession: {
        acceptedVersions: [1],
        currentVersion: DURABLE_SESSION_VERSION,
        name: "durableSession",
        schemaHashes: { 1: null },
      },
      messageStream: {
        acceptedVersions: null,
        currentVersion: Number(EVE_MESSAGE_STREAM_VERSION),
        name: "messageStream",
        schemaHashes: null,
      },
      sessionInboxWire: {
        acceptedVersions: [0, 1],
        currentVersion: SESSION_INBOX_WIRE_VERSION,
        name: "sessionInboxWire",
        schemaHashes: { 0: null, 1: null },
      },
    });
  });

  it("creates sorted contract inventories", () => {
    const manifest = createDurableContractManifest("1.2.3-test");

    expect(manifest.dataContracts.map((contract) => contract.name)).toEqual([
      "attachmentRef",
      "durableSession",
      "messageStream",
      "sessionInboxWire",
    ]);
    expect(manifest.workflows.map((contract) => contract.name)).toEqual([
      "sessionTimeoutWorkflow",
      "taskRunWorkflow",
      "turnWorkflow",
      "workflowEntry",
    ]);
    expect(manifest.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          acceptedInputVersions: [0, 1],
          inputSchemaHashes: { 0: null, 1: null },
        }),
      ]),
    );
  });

  it("applies build-only schema hashes to declared versions", () => {
    const hash = `sha256:${"a".repeat(64)}`;

    expect(
      createDurableContractManifest("1.2.3-test", {
        dataContracts: { sessionInboxWire: { 1: hash } },
      }).dataContracts.find((contract) => contract.name === "sessionInboxWire"),
    ).toMatchObject({ schemaHashes: { 0: null, 1: hash } });
  });

  it("serializes deterministically", () => {
    const first = serializeDurableContractManifest("1.2.3-test");
    const second = serializeDurableContractManifest("1.2.3-test");

    expect(second).toBe(first);
    expect(first).toBe(`{
  "builtWithEve": "1.2.3-test",
  "dataContracts": [
    {
      "acceptedVersions": [
        1
      ],
      "currentVersion": 1,
      "name": "attachmentRef",
      "schemaHashes": {
        "1": null
      }
    },
    {
      "acceptedVersions": [
        1
      ],
      "currentVersion": 1,
      "name": "durableSession",
      "schemaHashes": {
        "1": null
      }
    },
    {
      "acceptedVersions": null,
      "currentVersion": 23,
      "name": "messageStream",
      "schemaHashes": null
    },
    {
      "acceptedVersions": [
        0,
        1
      ],
      "currentVersion": 1,
      "name": "sessionInboxWire",
      "schemaHashes": {
        "0": null,
        "1": null
      }
    }
  ],
  "formatVersion": 2,
  "kind": "eve-durable-contracts",
  "workflows": [
    {
      "acceptedInputVersions": [
        0,
        1
      ],
      "inputSchemaHashes": {
        "0": null,
        "1": null
      },
      "inputVersion": 1,
      "name": "sessionTimeoutWorkflow",
      "workflowId": "workflow//eve//sessionTimeoutWorkflow"
    },
    {
      "acceptedInputVersions": [
        0,
        1
      ],
      "inputSchemaHashes": {
        "0": null,
        "1": null
      },
      "inputVersion": 1,
      "name": "taskRunWorkflow",
      "workflowId": "workflow//eve//taskRunWorkflow"
    },
    {
      "acceptedInputVersions": [
        0,
        1
      ],
      "inputSchemaHashes": {
        "0": null,
        "1": null
      },
      "inputVersion": 1,
      "name": "turnWorkflow",
      "workflowId": "workflow//eve//turnWorkflow"
    },
    {
      "acceptedInputVersions": [
        0,
        1
      ],
      "inputSchemaHashes": {
        "0": null,
        "1": null
      },
      "inputVersion": 1,
      "name": "workflowEntry",
      "workflowId": "workflow//eve//workflowEntry"
    }
  ]
}
`);
  });

  it("rejects an empty producer version", () => {
    expect(() => createDurableContractManifest("")).toThrow(
      "Durable contract manifest requires a non-empty eve version.",
    );
  });
});
