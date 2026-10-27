import { describe, expect, it } from "vitest";

import { splitBoardText } from "#public/channels/board/boardChannel.js";
import {
  desiredRegistration,
  reachedOnWakeHost,
  type BoardWatcherConfig,
} from "#public/channels/board/registration.js";

const watcher: BoardWatcherConfig = {
  previews: false,
  profile: "eve",
  tail: "dev --mentions @eve",
  when: "matches",
};
const watch = { eve: { tail: "dev --mentions @eve", when: "matches" } };

describe("desiredRegistration", () => {
  it.each([
    {
      name: "pulls on its own outside a hosted deployment",
      env: {},
      discovery: { wake_by_path: true },
      expected: { url: null, watch },
    },
    {
      name: "registers production's wake path on a board that wakes by path",
      env: { VERCEL_ENV: "production", EVE_PUBLIC_ROUTE_PREFIX: "/agents" },
      discovery: { wake_by_path: true },
      expected: { branch: null, path: "/agents/eve/v1/board", url: null, watch },
    },
    {
      name: "registers production's URL on a board that wakes only URLs",
      env: { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "agent.example.com" },
      discovery: {},
      expected: { url: "https://agent.example.com/eve/v1/board", watch },
    },
    {
      name: "skips previews unless they opt in",
      env: { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature" },
      discovery: { wake_by_path: true },
      expected: undefined,
    },
  ])("$name", ({ env, discovery, expected }) => {
    expect(desiredRegistration(watcher, discovery, env)).toEqual(expected);
  });

  it("names a preview's branch when previews opt in", () => {
    expect(
      desiredRegistration(
        { ...watcher, previews: true },
        { wake_by_path: true },
        { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature" },
      ),
    ).toEqual({ branch: "feature", path: "/eve/v1/board", url: null, watch });
  });

  it("explains a missing wake URL instead of registering a broken one", () => {
    expect(() => desiredRegistration(watcher, {}, { VERCEL_ENV: "production" })).toThrow(
      /VERCEL_PROJECT_PRODUCTION_URL is unset/u,
    );
  });
});

describe("reachedOnWakeHost", () => {
  const production = {
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "agent.example.com",
  };
  const wake = (host: string) =>
    new Request(`https://${host}/eve/v1/board/wake`, { method: "POST" });

  it.each([
    {
      name: "accepts production's domain",
      host: "agent.example.com",
      env: production,
      expected: true,
    },
    {
      name: "refuses an older deployment's own URL",
      host: "agent-abc123.vercel.app",
      env: production,
      expected: false,
    },
    {
      name: "accepts a preview's branch URL",
      host: "agent-git-feature.vercel.app",
      env: { VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "agent-git-feature.vercel.app" },
      expected: true,
    },
    {
      name: "refuses outside a hosted deployment",
      host: "localhost:3000",
      env: {},
      expected: false,
    },
  ])("$name", ({ host, env, expected }) => {
    expect(reachedOnWakeHost(wake(host), env)).toBe(expected);
  });
});

describe("splitBoardText", () => {
  it("never splits a surrogate pair across messages", () => {
    const chunks = splitBoardText(`${"a".repeat(9)}😀b`, 10);
    expect(chunks).toEqual(["a".repeat(9), "😀b"]);
  });
});
