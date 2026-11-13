import type * as Eve from "eve";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import type { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import type { getGatewayModel } from "@db/services/settings";

const services = vi.hoisted(() => ({
  getModel: vi.fn<typeof getGatewayModel>(),
  isActive: vi.fn<typeof isScheduledAgentRunLeaseActive>(),
}));

vi.mock("eve", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof Eve>())
);
vi.mock("@db/services/scheduled-agent-run-leases", () => ({
  isScheduledAgentRunLeaseActive: services.isActive,
}));
vi.mock("@db/services/settings", () => ({
  getGatewayModel: services.getModel,
}));

import agent from "@agent/agent";

const runId = "00000000-0000-4000-8000-000000000001";
const oldLeaseToken = "00000000-0000-4000-8000-000000000002";
const retryLeaseToken = "00000000-0000-4000-8000-000000000003";

beforeEach(() => {
  vi.clearAllMocks();
  services.getModel.mockResolvedValue("openai/gpt-5.6-sol-fast");
});

describe("root agent model resolution", () => {
  it("accepts a valid retry lease forwarded into an older Eve session", async () => {
    services.isActive.mockImplementation(async (_runId, leaseToken) => {
      return leaseToken === retryLeaseToken;
    });

    const model = await resolveModel();

    expect(services.isActive).toHaveBeenCalledExactlyOnceWith(
      runId,
      retryLeaseToken
    );
    expect(services.getModel).toHaveBeenCalledExactlyOnceWith({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(model).toBe("openai/gpt-5.6-sol-fast");
  });

  it("rejects a scheduled worker after its lease is replaced", async () => {
    services.isActive.mockResolvedValue(false);

    await expect(resolveModel()).rejects.toThrow(
      "The scheduled run lease is no longer active."
    );
    expect(services.getModel).not.toHaveBeenCalled();
  });
});

async function resolveModel() {
  return evaluateDynamic(agent.model, scheduledWorkerContext());
}

function scheduledWorkerContext() {
  return dynamicContextFor({
    auth: {
      current: {
        attributes: {
          scheduledRunId: runId,
          scheduledRunLeaseToken: retryLeaseToken,
          workspaceId: "workspace-1",
        },
        authenticator: "scheduled-worker",
        principalId: "user-1",
        principalType: "user",
      },
      initiator: {
        attributes: {
          scheduledRunId: runId,
          scheduledRunLeaseToken: oldLeaseToken,
          workspaceId: "workspace-1",
        },
        authenticator: "scheduled-worker",
        principalId: "user-1",
        principalType: "user",
      },
    },
    sessionId: "worker-session",
  });
}
