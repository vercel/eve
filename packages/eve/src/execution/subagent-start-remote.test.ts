import { describe, expect, it } from "vitest";

import {
  createRootProgressCallback,
  resolveRemoteProgressCallback,
} from "#execution/subagent-start-remote.js";

const session = {
  agent: {
    compaction: { recentWindowSize: 1, threshold: 1 },
    modelReference: "x",
    system: "",
    tools: [],
  },
  compaction: { recentWindowSize: 1, threshold: 1 },
  continuationToken: "parent",
  history: [],
  sessionId: "root",
} as never;

describe("createRootProgressCallback", () => {
  it("targets the root session command token", () => {
    expect(createRootProgressCallback(session, "https://agent.example.com")).toEqual({
      token: "eve:session:root:inbox",
      url: "https://agent.example.com/eve/v1/callback/eve%3Asession%3Aroot%3Ainbox",
      version: 1,
    });
  });

  it("remains absent when the root channel did not enable progress", () => {
    expect(
      resolveRemoteProgressCallback({
        callbackBaseUrl: "https://agent.example.com",
        enabled: false,
        session,
      }),
    ).toBeUndefined();
  });

  it("does not replace the callback inherited by a descendant", () => {
    expect(
      createRootProgressCallback(
        Object.assign({}, session, { rootSessionId: "root", sessionId: "child" }),
        "https://agent.example.com",
      ),
    ).toBeUndefined();
  });
});
