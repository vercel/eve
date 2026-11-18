import type { SessionEvent, SessionStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import {
  browserBenchmarkActivity,
  browserBenchmarkActivityDurations,
  browserBenchmarkLiveViewUrl,
} from "../benchmark-activity";

function at(
  fact: SessionEvent,
  time: string,
  line: number,
  index = 0
): SessionStreamEvent {
  return { ...fact, meta: { at: time, position: { index, line } } };
}

function toolRequested(callId: string, name: string) {
  return {
    data: {
      callId,
      capability: { kind: "tool", name },
      input: {},
      owner: { runId: "run_1" },
    },
    scope: { turnId: "turn_1" },
    type: "call.requested",
  } satisfies SessionEvent;
}

const modelStarted = {
  data: { attempt: 1, modelId: "test/model", runId: "run_1" },
  scope: { turnId: "turn_1" },
  type: "model.started",
} satisfies SessionEvent;

describe("browser benchmark live activity", () => {
  it("shows the current tool in plain language", () => {
    expect(
      browserBenchmarkActivity([
        at(
          toolRequested("call_vault", "fill_from_vault"),
          "2026-08-31T17:00:00.000Z",
          0
        ),
      ])
    ).toBe("Securely filling saved user information");
  });

  it("joins calls requested on the same stored line", () => {
    expect(
      browserBenchmarkActivity([
        at(
          toolRequested("call_vault", "list_vault"),
          "2026-08-31T17:00:00.000Z",
          0
        ),
        at(
          toolRequested("call_search", "web_search"),
          "2026-08-31T17:00:00.000Z",
          0,
          1
        ),
      ])
    ).toBe("Checking saved user information and Searching for live options");
  });

  it("prefers the latest visible progress message", () => {
    expect(
      browserBenchmarkActivity([
        at(modelStarted, "2026-08-31T17:00:00.000Z", 0),
        at(
          {
            data: { delta: "Searching ", kind: "text", partId: "part_1" },
            scope: { turnId: "turn_1" },
            type: "content.delta",
          },
          "2026-08-31T17:00:01.000Z",
          1
        ),
        at(
          {
            data: {
              delta: "current Brooklyn showtimes",
              kind: "text",
              partId: "part_1",
            },
            scope: { turnId: "turn_1" },
            type: "content.delta",
          },
          "2026-08-31T17:00:02.000Z",
          2
        ),
      ])
    ).toBe("Searching current Brooklyn showtimes");
  });

  it("sums wall time by model and browser activity type", () => {
    const events = [
      at(modelStarted, "2026-08-31T17:00:00.000Z", 0),
      at(
        toolRequested("call_playwright", "playwright_execute"),
        "2026-08-31T17:00:01.000Z",
        1
      ),
      at(
        {
          data: {
            callId: "call_playwright",
            outcome: "completed",
            output: { ok: true },
          },
          scope: { turnId: "turn_1" },
          type: "call.settled",
        },
        "2026-08-31T17:00:04.000Z",
        2
      ),
      at(
        toolRequested("call_semantic", "browser_act"),
        "2026-08-31T17:00:07.000Z",
        3
      ),
    ];

    expect(
      browserBenchmarkActivityDurations(
        events,
        Date.parse("2026-08-31T17:00:10.000Z")
      )
    ).toEqual({ model: 4_000, playwright: 3_000, semantic: 3_000 });
  });

  it("finds the Kernel live browser stream from session creation", () => {
    const events = [
      at(
        toolRequested("call_browser", "manage_browsers"),
        "2026-08-31T17:00:00.000Z",
        0
      ),
      at(
        {
          data: {
            callId: "call_browser",
            outcome: "completed",
            output: {
              browser: {
                browser_live_view_url:
                  "https://live.kernel.test/browser/session-1",
              },
            },
          },
          scope: { turnId: "turn_1" },
          type: "call.settled",
        },
        "2026-08-31T17:00:01.000Z",
        1
      ),
    ];

    expect(browserBenchmarkLiveViewUrl(events)).toBe(
      "https://live.kernel.test/browser/session-1"
    );
  });
});
