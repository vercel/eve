import { describe, expect, it } from "vitest";

import { toEmbeddedBrowserbaseLiveViewUrl } from "../../lib/browser/live-view.js";

describe("Browserbase live view URLs", () => {
  it("accepts a signed debugger URL and hides the Browserbase navigation bar", () => {
    const result = toEmbeddedBrowserbaseLiveViewUrl(
      "https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com%2Fdebug%2Fsession",
    );
    expect(result).toContain("devtools-fullscreen/inspector.html");
    expect(result).toContain("navbar=false");
  });

  it("rejects the dashboard session URL", () => {
    expect(
      toEmbeddedBrowserbaseLiveViewUrl("https://www.browserbase.com/sessions/session-id"),
    ).toBeUndefined();
  });

  it("rejects debugger URLs from another host", () => {
    expect(
      toEmbeddedBrowserbaseLiveViewUrl(
        "https://example.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com%2Fdebug",
      ),
    ).toBeUndefined();
  });
});
