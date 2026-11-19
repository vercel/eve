import type * as EveInstructions from "eve/instructions";
import { describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";

vi.mock("eve/instructions", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveInstructions>())
);

import executionSafety from "@agent/instructions/10-execution-safety";
import roleInstructions from "@agent/instructions/20-role";
import workerCoordination from "@agent/instructions/25-worker-coordination";
import messageStyle from "@agent/instructions/30-message-style";

describe("agent instructions", () => {
  it.each([
    ["scheduled-worker", "isolated background session"],
    ["scheduled-result", "evaluating the completed outcome"],
    ["linq", "root coordinator"],
  ])("selects %s instructions for the current turn", async (role, phrase) => {
    const selected = await evaluateDynamic(
      roleInstructions,
      dynamicContext(role)
    );
    expect(selected?.content).toContain(phrase);
  });

  it("limits scheduled-result turns to reporting", async () => {
    const selected = await evaluateDynamic(
      roleInstructions,
      dynamicContext("scheduled-result")
    );
    expect(selected?.content).toContain(
      "Never invoke another agent, alter a schedule or profile, read or change vault contents, access an account"
    );
    expect(selected?.content).toContain(
      "call `request_vault_setup` with only the safe metadata"
    );
    expect(selected?.content).toContain(
      "After `send_message`, emit only `DELIVERY_COMPLETE`"
    );
  });

  it("omits execution safety from scheduled reports", async () => {
    expect(
      await evaluateDynamic(executionSafety, dynamicContext("scheduled-result"))
    ).toBeNull();
    const selected = await evaluateDynamic(
      executionSafety,
      dynamicContext("scheduled-worker")
    );
    expect(selected?.content).toContain("approval");
  });

  it("avoids tool approval loops and keeps Link purchases unavailable", async () => {
    const selected = await evaluateDynamic(
      executionSafety,
      dynamicContext("linq-message")
    );
    expect(selected?.content).toContain(
      "Tools run without a separate Eve approval step"
    );
    expect(selected?.content).toContain(
      "Link purchases are temporarily unavailable"
    );
    expect(selected?.content).not.toContain("approval in Link");
    expect(selected?.content).not.toContain("native approval card");
  });

  it("treats personal information as recalled context instead of a read tool", async () => {
    const selected = await evaluateDynamic(
      roleInstructions,
      dynamicContext("linq-message")
    );
    expect(selected?.content).toContain(
      "never call `personal_info__update` to read it"
    );
    expect(selected?.content).toContain(
      "say plainly when a requested value is not present"
    );
    expect(selected?.content).toContain(
      "never import third-party claims or task details into those slots"
    );
  });

  it("omits message style from scheduled workers", async () => {
    expect(
      await evaluateDynamic(messageStyle, dynamicContext("scheduled-worker"))
    ).toBeNull();
    const selected = await evaluateDynamic(
      messageStyle,
      dynamicContext("scheduled-result")
    );
    expect(selected?.content).toContain("natural text message");
  });

  it("shares the exact browser contract with scheduled workers", async () => {
    const selections = await Promise.all(
      ["linq", "scheduled-worker"].map((authenticator) =>
        evaluateDynamic(workerCoordination, dynamicContext(authenticator))
      )
    );
    for (const selected of selections) {
      expect(selected?.content).toContain(
        "tool supplies the required structured completion schema"
      );
      expect(selected?.content).toContain(
        "using the completion tool Eve supplies"
      );
    }

    expect(
      await evaluateDynamic(
        workerCoordination,
        dynamicContext("scheduled-result")
      )
    ).toBeNull();
  });

  it("reports Link purchases as temporarily unavailable while Link is disabled", async () => {
    const selected = await evaluateDynamic(
      workerCoordination,
      dynamicContext("linq")
    );
    expect(selected?.content).toContain(
      "Link purchases are temporarily unavailable"
    );
    expect(selected?.content).toContain(
      "do not tell the browser worker to use Link or `fill_from_link`"
    );
    expect(selected?.content).not.toContain("link__create_spend_request");
    expect(selected?.content).not.toContain("merchant_url");
    expect(selected?.content).toContain(
      "unless the worker's latest result says it kept the browser open"
    );
  });

  it("keeps resumed scheduled turns in worker mode", async () => {
    const selected = await evaluateDynamic(
      roleInstructions,
      dynamicContext("linq-message", "scheduled-worker")
    );
    expect(selected?.content).toContain("isolated background session");
  });
});

function dynamicContext(
  authenticator: string,
  initiatorAuthenticator?: string
) {
  return dynamicContextFor({
    auth: {
      current: {
        attributes: {},
        authenticator,
        principalId: "user-1",
        principalType: "user",
      },
      initiator:
        initiatorAuthenticator === undefined
          ? null
          : {
              attributes: {},
              authenticator: initiatorAuthenticator,
              principalId: "user-1",
              principalType: "user",
            },
    },
    channel: { kind: "channel:linq", metadata: {} },
    sessionId: "session-1",
  });
}
