import { describe, expect, expectTypeOf, it } from "vitest";

import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { AgentInfoResponseError } from "#client/agent-info-error.js";
import { ClientError, ClientSessionStrandedError } from "#client/client-error.js";
import { HealthResponseError } from "#client/health-response-error.js";
import { EveError } from "#shared/eve-error.js";

/** What an error thrown by a separately bundled copy of eve looks like to this copy. */
function fromAnotherCopy(error: EveError): Error {
  const foreign = Object.assign(new Error(error.message), { code: error.code });
  for (const key of Object.getOwnPropertySymbols(error)) {
    Object.defineProperty(foreign, key, { value: Reflect.get(error, key) });
  }
  return foreign;
}

describe("EveError", () => {
  it("narrows to the class and its subclasses, not its siblings", () => {
    const stranded = new ClientSessionStrandedError(409, '{"code":"session_stranded"}', undefined, {
      eveVersion: undefined,
    });

    expect(EveError.is(stranded)).toBe(true);
    expect(ClientError.is(stranded)).toBe(true);
    expect(ClientSessionStrandedError.is(stranded)).toBe(true);
    expect(ClientSessionStrandedError.is(new ClientError(500, "boom"))).toBe(false);
    expect(SessionNotActiveError.is(stranded)).toBe(false);
    expect(EveError.is(new Error("plain"))).toBe(false);
    expect(EveError.is({ code: "session_not_active" })).toBe(false);

    const unknownError: unknown = stranded;
    if (ClientSessionStrandedError.is(unknownError)) {
      expectTypeOf(unknownError).toEqualTypeOf<ClientSessionStrandedError>();
    }
  });

  it("recognizes errors created by another copy of eve", () => {
    const foreign = fromAnotherCopy(new SessionNotActiveError({ retryable: true }));

    expect(foreign instanceof SessionNotActiveError).toBe(false);
    expect(SessionNotActiveError.is(foreign)).toBe(true);
    expect(EveError.is(foreign)).toBe(true);
    expect(ClientError.is(foreign)).toBe(false);
  });

  it("gives every client-thrown error a stable name and snake_case code", () => {
    const errors = [
      [new SessionNotActiveError(), "SessionNotActiveError", "session_not_active"],
      [
        new SessionNotActiveError({ retryable: true }),
        "SessionNotActiveError",
        "session_not_ready",
      ],
      [new ClientError(502, "Bad Gateway"), "ClientError", "http_error"],
      [new HealthResponseError(), "HealthResponseError", "invalid_health_response"],
      [new AgentInfoResponseError(), "AgentInfoResponseError", "invalid_agent_info_response"],
    ] as const;

    for (const [error, name, code] of errors) {
      expect(error).toBeInstanceOf(EveError);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error.code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });
});
