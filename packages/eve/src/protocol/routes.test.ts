import { describe, expect, it } from "vitest";

import {
  createEveConnectionCallbackRoutePath,
  parseEveConnectionCallbackRoutePath,
} from "./routes.js";

describe("parseEveConnectionCallbackRoutePath", () => {
  it("reads back what a connection callback path names, under any prefix", () => {
    const cases = [
      ["github", "01JATTEMPT", "eve:inbox:v1:eve:session:child-1:inbox"],
      ["linear/team one", "a b", "token/with?odd#chars"],
    ] as const;
    for (const [name, attemptId, token] of cases) {
      const path = createEveConnectionCallbackRoutePath(name, attemptId, token);
      for (const prefix of ["", "/eve/v1", "/api/agent"]) {
        expect(parseEveConnectionCallbackRoutePath(`${prefix}${path}`)).toEqual({
          attemptId,
          name,
          token,
        });
      }
    }
  });

  it("reads nothing from another path", () => {
    for (const path of [
      "/eve/v1/callback/token",
      "/eve/v1/connections/github/callback/attempt",
      "/eve/v1/connections//callback/attempt/token",
    ])
      expect(parseEveConnectionCallbackRoutePath(path)).toBeUndefined();
  });

  it("reads nothing from a path whose name, attempt or token is malformed percent-encoding", () => {
    for (const path of [
      "/eve/v1/connections/%ZZ/callback/attempt-a/token",
      "/eve/v1/connections/github/callback/%E0%A4%A/token",
      "/eve/v1/connections/github/callback/attempt-a/%",
    ])
      expect(parseEveConnectionCallbackRoutePath(path), path).toBeUndefined();
  });
});
