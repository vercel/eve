import { describe, expect, it } from "vitest";

import {
  desiredRegistration,
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
