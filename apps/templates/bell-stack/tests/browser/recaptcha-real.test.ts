import { describe, expect, it } from "vitest";

import { BrowserSession } from "../../server/browser/browser-session.js";
import type { ConversationState } from "../../server/browser/types.js";

const live = process.env.BELL_REAL_CAPTCHA === "1" && Boolean(process.env.BROWSERBASE_API_KEY);

describe("opt-in real Browserbase CAPTCHA solve", () => {
  it.runIf(live)(
    "solves Google's reCAPTCHA demo and records useful events",
    async () => {
      const state: ConversationState = {
          id: "real-recaptcha-smoke",
          traces: [],
          browser: { provider: "not-started", status: "idle" },
        },
        session = new BrowserSession(state);
      try {
        await session.run([
          { action: "goto", url: "https://google.com/recaptcha/api2/demo" },
          { action: "wait", milliseconds: 2_000 },
        ]);
        const transitions = session.drainCaptchaTransitions();
        expect(transitions.map((event) => event.type)).toEqual(["started", "finished"]);

        await session.run([
          { action: "click", target: "#recaptcha-demo-submit" },
          { action: "wait", milliseconds: 1_000 },
        ]);
        const page = await session.snapshot();
        expect(page.tree).toContain("Verification Success");

        const eventLog = state.traces
          .filter((event) =>
            ["captcha.started", "captcha.finished", "captcha.observed"].includes(event.name),
          )
          .map(({ name, summary, at }) => ({ name, summary, at }));
        expect(eventLog.map((event) => event.name)).toEqual([
          "captcha.started",
          "captcha.finished",
          "captcha.observed",
        ]);
        console.log(JSON.stringify({ status: "pass", eventLog }, null, 2));
      } finally {
        await session.close();
      }
    },
    120_000,
  );
});
