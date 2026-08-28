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
        currentVersion: Number(ATTACHMENT_REF_WIRE_VERSION),
        name: "attachmentRef",
      },
      durableSession: {
        currentVersion: DURABLE_SESSION_VERSION,
        name: "durableSession",
      },
      messageStream: {
        currentVersion: Number(EVE_MESSAGE_STREAM_VERSION),
        name: "messageStream",
      },
      sessionInboxWire: {
        currentVersion: SESSION_INBOX_WIRE_VERSION,
        name: "sessionInboxWire",
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
  });

  it("serializes deterministically", () => {
    const first = serializeDurableContractManifest("1.2.3-test");
    const second = serializeDurableContractManifest("1.2.3-test");

    expect(second).toBe(first);
    expect(first).toBe(`{
  "builtWithEve": "1.2.3-test",
  "dataContracts": [
    {
      "currentVersion": 1,
      "name": "attachmentRef"
    },
    {
      "currentVersion": 1,
      "name": "durableSession"
    },
    {
      "currentVersion": 23,
      "name": "messageStream"
    },
    {
      "currentVersion": 1,
      "name": "sessionInboxWire"
    }
  ],
  "formatVersion": 1,
  "kind": "eve-durable-contracts",
  "workflows": [
    {
      "inputVersion": 1,
      "name": "sessionTimeoutWorkflow",
      "workflowId": "workflow//eve//sessionTimeoutWorkflow"
    },
    {
      "inputVersion": 1,
      "name": "taskRunWorkflow",
      "workflowId": "workflow//eve//taskRunWorkflow"
    },
    {
      "inputVersion": 1,
      "name": "turnWorkflow",
      "workflowId": "workflow//eve//turnWorkflow"
    },
    {
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
