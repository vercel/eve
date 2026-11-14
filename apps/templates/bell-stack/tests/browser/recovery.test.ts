import { afterEach, describe, expect, it } from "vitest";

import {
  assessSnapshot,
  browserbaseLaunchOptions,
  browserProvider,
} from "../../server/browser/browser-session.js";

describe("browser recovery", () => {
  afterEach(() => {
    delete process.env.STAGEHAND_BROWSER;
    delete process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_CONTEXT_ID;
    delete process.env.BROWSERBASE_PROJECT_ID;
  });

  it("detects a common access block", () => {
    expect(assessSnapshot("You have been blocked.", "https://www.yelp.com").blocked).toBe(true);
  });

  it("detects an empty hosted page", () => {
    const tree =
      "PAGE CONTENT\n(No visible page text)\n\nINTERACTIVE TARGETS\n(No visible interactive targets)";
    expect(assessSnapshot(tree, "https://www.yelp.com/search")).toEqual({
      blocked: true,
      signal: "empty page",
    });
  });

  it("detects a login wall", () => {
    expect(
      assessSnapshot(
        "Log in to Foursquare\nEnter your email or phone to receive a login code\nContinue",
        "https://app.foursquare.com/login?continue=%2Fexplore",
      ),
    ).toEqual({ blocked: true, signal: "login wall" });
  });

  it("detects a not-found page", () => {
    expect(
      assessSnapshot("Page Not Found - Judy's Book", "https://www.judysbook.com/barbers"),
    ).toEqual({
      blocked: true,
      signal: "not found",
    });
  });

  it("uses Browserbase automatically when its key is present", () => {
    process.env.BROWSERBASE_API_KEY = "bb_test_example";
    expect(browserProvider()).toBe("browserbase");
  });

  it("always launches hosted browsers with a proxy and a verified identity", () => {
    expect(browserbaseLaunchOptions("bb_test_example")).toMatchObject({
      apiKey: "bb_test_example",
      proxies: true,
      keepAlive: true,
      browserSettings: { verified: true, solveCaptchas: true },
    });
  });

  it("passes a requested managed proxy location to Browserbase", () => {
    expect(
      browserbaseLaunchOptions("bb_test_example", undefined, {
        country: "US",
        state: "CA",
        city: "San Francisco",
      }),
    ).toMatchObject({
      proxies: [
        {
          type: "browserbase",
          geolocation: {
            country: "US",
            state: "CA",
            city: "San Francisco",
          },
        },
      ],
    });
  });

  it("adds the configured Browserbase project and persistent Context", () => {
    process.env.BROWSERBASE_PROJECT_ID = "project_example";
    process.env.BROWSERBASE_CONTEXT_ID = "context_example";
    expect(browserbaseLaunchOptions("bb_test_example")).toMatchObject({
      projectId: "project_example",
      browserSettings: {
        verified: true,
        context: { id: "context_example", persist: true },
      },
    });
  });

  it("prefers the durable task Context when the deployment default changes", () => {
    process.env.BROWSERBASE_CONTEXT_ID = "context_new_default";
    expect(browserbaseLaunchOptions("bb_test_example", "context_saved_task")).toMatchObject({
      browserSettings: {
        verified: true,
        solveCaptchas: true,
        context: { id: "context_saved_task", persist: true },
      },
    });
  });
});
