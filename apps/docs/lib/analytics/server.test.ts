import { track } from "@vercel/analytics/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsEvents } from "./events";
import { trackServerEvent } from "./server";

vi.mock("@vercel/analytics/server", () => ({ track: vi.fn() }));

describe("server analytics", () => {
  afterEach(() => {
    vi.mocked(track).mockClear();
  });

  it("does not call the SDK in a query-bearing request context", () => {
    const request = new Request("https://eve.dev/docs/missing?token=secret");

    trackServerEvent(request, analyticsEvents.smartMarkdownNotFound, { surface: "docs" });

    expect(track).not.toHaveBeenCalled();
  });

  it("tracks query-free requests with the original request context", () => {
    const request = new Request("https://eve.dev/api/chat", { method: "POST" });

    trackServerEvent(request, analyticsEvents.askAiSubmitted, { outcome: "accepted" });

    expect(track).toHaveBeenCalledWith(
      analyticsEvents.askAiSubmitted,
      { outcome: "accepted" },
      { request },
    );
  });
});
