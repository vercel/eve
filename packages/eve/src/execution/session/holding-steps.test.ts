import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeHolderStep, redirectHolderStep } from "#execution/session/holding-steps.js";
import { createSessionResources } from "#execution/session/resources.js";
import type { AcceptedSubmission } from "#execution/turn/types.js";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  publish: vi.fn(),
  resolve: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("#execution/session/directory.js", () => ({
  initializeSessionResources: mocks.initialize,
  publishSessionDescriptor: mocks.publish,
  sessionDirectory: { resolveHolder: mocks.resolve },
}));
vi.mock("#execution/session/dispatch.js", () => ({ dispatchTurn: mocks.dispatch }));
beforeEach(() => vi.clearAllMocks());

describe("holder bootstrap", () => {
  it("prepares storage without publishing readiness before the first turn writes state", async () => {
    const resources = await initializeHolderStep("holder", "first");
    expect(mocks.initialize).toHaveBeenCalledWith(resources);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("publishes canonical resources only after dispatching the losing creation's accepted input", async () => {
    const resources = createSessionResources("winner", "initial");
    const submission: AcceptedSubmission = {
      eventId: "loser-message",
      acceptedDeploymentId: "deployment",
      command: { kind: "send", payload: { message: "Hello" } },
    };
    mocks.resolve.mockResolvedValue(resources);
    await redirectHolderStep("loser", "winner", submission);
    expect(mocks.resolve).toHaveBeenCalledWith("winner");
    expect(mocks.dispatch).toHaveBeenCalledWith(resources, submission);
    expect(mocks.publish).toHaveBeenCalledWith("loser", resources);
    expect(mocks.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0]!,
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
});
