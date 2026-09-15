import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { encodeLegacyCommand, resumeLegacyInbox } from "./inbox.js";
const { get, resume } = vi.hoisted(() => ({ get: vi.fn(), resume: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({ getHookByToken: get, resumeHook: resume }));
beforeEach(() => {
  get.mockReset();
  resume.mockReset();
});
describe("legacy ingress", () => {
  it.each([1, 2, 3, 4, 5, 6, 7])("encodes generation %s", (version) => {
    const value = encodeLegacyCommand(
      {
        kind: "send",
        payload: { message: "Alice continues." },
        delivery: {
          acceptedDeploymentId: "new",
          channelKind: "http",
          channelName: "test",
          deliveryId: "delivery",
        },
      },
      version,
    );
    expect(value).toMatchObject({
      kind: "deliver",
      version,
      payload: { message: "Alice continues." },
      payloads: [{ message: "Alice continues." }],
    });
    if (version >= 3)
      expect(value).toHaveProperty("deliveryMetadata.0.acceptedDeploymentId", "new");
    else expect(value).not.toHaveProperty("deliveryMetadata.0.acceptedDeploymentId");
  });
  it("supports both unversioned inbox shapes", () => {
    const command = { kind: "send" as const, payload: { message: "hello" } };
    expect(encodeLegacyCommand(command, undefined, "send")).toMatchObject(command);
    expect(encodeLegacyCommand(command, undefined, "deliver")).toMatchObject({
      kind: "deliver",
      payloads: [command.payload],
    });
  });
  it("routes an old alias to its imported owner before writing", async () => {
    const token = sessionInboxHookToken(sessionCommandHookToken("old"));
    get.mockImplementation(async (name: string) =>
      name === "slack:old"
        ? { runId: "old", token: name, metadata: { sessionInboxWireVersion: 7 } }
        : { runId: "new", token, metadata: { sessionId: "old" } },
    );
    resume.mockResolvedValue({ runId: "new" });
    const receipt = await resumeLegacyInbox("slack:old", { kind: "clear" });
    expect(resume).toHaveBeenCalledExactlyOnceWith(token, { kind: "clear" });
    await expect(receipt.sessionId).resolves.toBe("old");
  });
  it("delivers to an original driver when it has not imported yet", async () => {
    get.mockImplementation(async (token: string) => {
      if (token.startsWith("eve:inbox:")) throw new HookNotFoundError(token);
      return { runId: "old", token, metadata: { sessionInboxWireVersion: 7 } };
    });
    resume.mockResolvedValue({ runId: "old" });
    await resumeLegacyInbox("slack:old", { kind: "send", payload: { message: "hello" } });
    expect(resume).toHaveBeenCalledExactlyOnceWith(
      "slack:old",
      expect.objectContaining({ kind: "deliver", version: 7 }),
    );
  });
  it("does not retry ambiguous delivery errors", async () => {
    get.mockResolvedValue({ runId: "old", token: "alias", metadata: {} });
    resume.mockRejectedValue(new Error("accepted but wake failed"));
    await expect(resumeLegacyInbox("alias", { kind: "clear" })).rejects.toThrow("wake failed");
    expect(resume).toHaveBeenCalledOnce();
  });
});
