import { expect, it } from "vitest";

import { interactionJson } from "#protocol/interaction-json.js";

it("projects a nested interaction without its private sign-in callback", () => {
  expect(
    interactionJson({
      interactionId: "sign-in-1",
      status: "open",
      turnId: "turn_0",
      stepIndex: 1,
      request: {
        kind: "sign-in",
        prompt: "Connect the calendar",
        signIn: {
          name: "calendar",
          url: "https://calendar.example/authorize",
          callbackUrl: "https://agent.example/internal/callback",
        },
      },
    }),
  ).toEqual({
    interactionId: "sign-in-1",
    status: "open",
    turnId: "turn_0",
    stepIndex: 1,
    request: {
      kind: "sign-in",
      prompt: "Connect the calendar",
      signIn: { name: "calendar", url: "https://calendar.example/authorize" },
    },
  });
});
