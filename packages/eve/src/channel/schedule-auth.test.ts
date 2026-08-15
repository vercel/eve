import { describe, expect, it } from "vitest";

import { isScheduleAppAuth, SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";

describe("isScheduleAppAuth", () => {
  it("recognizes eve's schedule principal", () => {
    expect(isScheduleAppAuth(SCHEDULE_APP_AUTH)).toBe(true);
    expect(
      isScheduleAppAuth({
        ...SCHEDULE_APP_AUTH,
        attributes: { deployment: "preview" },
        issuer: "eve",
      }),
    ).toBe(true);
  });

  it("rejects other principals and missing auth", () => {
    expect(isScheduleAppAuth(null)).toBe(false);
    expect(isScheduleAppAuth(undefined)).toBe(false);
    expect(isScheduleAppAuth({ ...SCHEDULE_APP_AUTH, authenticator: "oidc" })).toBe(false);
    expect(isScheduleAppAuth({ ...SCHEDULE_APP_AUTH, principalId: "another-app" })).toBe(false);
    expect(isScheduleAppAuth({ ...SCHEDULE_APP_AUTH, principalType: "user" })).toBe(false);
  });
});
