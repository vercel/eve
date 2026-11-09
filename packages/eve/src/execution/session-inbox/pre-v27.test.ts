import { describe, expect, it } from "vitest";

import { withPreV27Answers } from "#execution/session-inbox/pre-v27.js";
import { decodeSessionInboxPayload } from "#execution/session-inbox/protocol.js";

describe("answers for pre-v27 owners", () => {
  const answers = [
    { interactionId: "req_1", optionId: "approve" },
    { interactionId: "req_2", text: "ship it" },
  ];

  it("carries each delivery's answers under the name a pre-v27 owner reads", () => {
    expect(
      withPreV27Answers({ kind: "deliver", payloads: [{ answers }, { message: "hi" }] }),
    ).toEqual({
      kind: "deliver",
      payloads: [
        {
          answers,
          inputResponses: [
            { requestId: "req_1", optionId: "approve" },
            { requestId: "req_2", text: "ship it" },
          ],
        },
        { message: "hi" },
      ],
    });
    expect(withPreV27Answers({ kind: "send", payload: { answers } })).toMatchObject({
      payload: { inputResponses: [{ requestId: "req_1" }, { requestId: "req_2" }] },
    });
    const cancel = { kind: "cancel" };
    expect(withPreV27Answers(cancel)).toBe(cancel);
  });

  it("keeps the alias from v27 owners", () => {
    const deliver = withPreV27Answers({ kind: "deliver", payloads: [{ answers }] });
    expect(decodeSessionInboxPayload(deliver)).toEqual({
      kind: "deliver",
      payloads: [{ answers }],
    });
    const send = withPreV27Answers({ kind: "send", payload: { answers } });
    expect(decodeSessionInboxPayload(send)).toMatchObject({ payloads: [{ answers }] });
  });
});
