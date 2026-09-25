import { describe, expect, it } from "vitest";
import { createSchedulePayload, parseSchedulePayload } from "#runtime/schedules/payload.js";

const binding = {
  application: "fixture",
  collection: "tasks",
  namespace: "eve-alice",
  name: "daily",
};
function context() {
  return {
    abortSignal: new AbortController().signal,
    channel: {
      kind: "slack",
      continuationToken: "thread",
      metadata: { ignored: "not a delivery contract" },
    },
    session: {
      id: "origin-session",
      auth: {
        current: {
          attributes: { team_id: "team", groups: ["staff"] },
          authenticator: "slack-webhook",
          issuer: "slack:team",
          principalId: "alice",
          principalType: "user",
        },
        initiator: null,
      },
    },
  };
}
const payload = () =>
  createSchedulePayload({
    request: "Review incidents",
    binding,
    runAs: "creator",
    context: context(),
  });

describe("schedule payload", () => {
  it("copies caller identity and bounded origin without channel metadata or live handles", () => {
    const source = context();
    const stored = createSchedulePayload({
      request: "Review incidents",
      binding,
      runAs: "creator",
      context: source,
    });
    source.session.auth.current.principalId = "bob";
    source.session.auth.current.attributes.groups.push("changed");
    expect(stored.origin.auth.current?.principalId).toBe("alice");
    expect(stored.origin.auth.current?.attributes.groups).toEqual(["staff"]);
    expect(stored.origin.channel).toEqual({ kind: "slack", continuationToken: "thread" });
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    expect(stored).not.toHaveProperty("abortSignal");
  });

  it.each([null, "anonymous", "runtime", "local-dev", "service"])(
    "rejects creator execution without an authenticated user (%s)",
    (principalType) => {
      const source = context();
      const auth = {
        current: principalType === null ? null : { ...source.session.auth.current, principalType },
        initiator: source.session.auth.current,
      };
      expect(() =>
        createSchedulePayload({
          request: "task",
          binding,
          runAs: "creator",
          context: { ...source, session: { id: "origin", auth } },
        }),
      ).toThrow("require an authenticated user");
      expect(
        createSchedulePayload({
          request: "task",
          binding,
          runAs: "app",
          context: { ...source, session: { id: "origin", auth } },
        }).runAs,
      ).toBe("app");
    },
  );

  it.each(["application", "collection", "namespace", "name", "runAs"] as const)(
    "rejects changed %s bindings",
    (key) => {
      const expected = { ...binding, runAs: "creator" as const };
      expect(() =>
        parseSchedulePayload(payload(), { ...expected, [key]: key === "runAs" ? "app" : "other" }),
      ).toThrow("identity or execution policy changed");
    },
  );

  it.each([
    "legacy string request",
    { version: 99 },
    { ...payload(), origin: { ...payload().origin, slack: { installationTeamId: "T999" } } },
    {
      ...payload(),
      origin: {
        ...payload().origin,
        slack: {
          installationTeamId: "T999",
          teamId: "T123",
          userId: "U123",
          channelId: "C123",
          threadTs: "1700000000.000001",
          botToken: "not-allowed",
        },
      },
    },
    { ...payload(), unexpected: true },
    {
      ...payload(),
      origin: {
        ...payload().origin,
        auth: {
          current: { ...context().session.auth.current, token: "not-allowed" },
          initiator: null,
        },
      },
    },
    {
      ...payload(),
      origin: {
        ...payload().origin,
        auth: {
          current: { ...context().session.auth.current, attributes: { huge: "x".repeat(65_536) } },
          initiator: null,
        },
      },
    },
  ])("rejects incompatible or oversized payloads without echoing their contents", (value) => {
    expect(() => parseSchedulePayload(value)).toThrow(
      "Invalid scheduled request payload; recreate the schedule.",
    );
  });
});
