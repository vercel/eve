import { beforeEach, describe, expect, it, vi } from "vitest";

import { localDevAuth, slackAuth } from "../testing/session";
import { installTestState, testState } from "../testing/state";
import { conflictsWithThreadRoles, recordThreadRole } from "./thread-roles";

const alice = slackAuth({ userId: "U0ALICE" });
const bob = slackAuth({ userId: "U0BOB" });
const carol = slackAuth({ userId: "U0CAROL" });

beforeEach(() => {
  installTestState();
  testState.reset();
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv(
    "ANALYST_ROLE_MAP",
    JSON.stringify({
      U0ALICE: "analyst_finance",
      U0BOB: "",
      U0CAROL: "analyst_finance",
    })
  );
});

describe(conflictsWithThreadRoles, () => {
  it("has no conflict before any role is recorded", () => {
    expect(conflictsWithThreadRoles(bob)).toBe(false);
    expect(conflictsWithThreadRoles(slackAuth())).toBe(false);
  });

  it("has no conflict for the same role, even from another person", () => {
    recordThreadRole(alice);
    expect(conflictsWithThreadRoles(alice)).toBe(false);
    expect(conflictsWithThreadRoles(carol)).toBe(false);
  });

  it("conflicts for a different role", () => {
    recordThreadRole(alice);
    expect(conflictsWithThreadRoles(slackAuth())).toBe(true);
  });

  it("conflicts for a denied or unauthenticated caller once a role is recorded", () => {
    recordThreadRole(alice);
    expect(conflictsWithThreadRoles(bob)).toBe(true);
    expect(conflictsWithThreadRoles(null)).toBe(true);
  });

  it("conflicts when the history mixes roles, even for one of them", () => {
    recordThreadRole(alice);
    recordThreadRole(slackAuth());
    expect(conflictsWithThreadRoles(alice)).toBe(true);
  });

  it("does not conflict when settings are invalid", () => {
    recordThreadRole(alice);
    vi.stubEnv("ANALYST_ROLE_MAP", "not json");
    expect(conflictsWithThreadRoles(slackAuth())).toBe(false);
  });

  it("never blocks local development against itself", () => {
    recordThreadRole(localDevAuth());
    expect(conflictsWithThreadRoles(localDevAuth())).toBe(false);
  });
});

describe(recordThreadRole, () => {
  it("records each role once", () => {
    recordThreadRole(alice);
    recordThreadRole(carol);
    expect(testState.get("analyst.thread-roles")).toStrictEqual({
      roles: ["analyst_finance"],
    });
  });

  it("records nothing for a denied caller or invalid settings", () => {
    recordThreadRole(bob);
    vi.stubEnv("ANALYST_ROLE_MAP", "not json");
    recordThreadRole(alice);
    expect(testState.get("analyst.thread-roles")).toBeUndefined();
  });
});
