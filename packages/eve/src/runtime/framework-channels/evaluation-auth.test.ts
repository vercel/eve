import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluationUser } from "#runtime/framework-channels/evaluation-auth.js";

const RUN_ID = "6c4f0a52-9f0f-4c05-9df1-2f2f4a3d7f11";

function requestWithBearer(token?: string): Request {
  return new Request("http://127.0.0.1:3000/eve/v1/session", {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe("evaluationUser", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("authenticates the run id bearer as a synthetic user principal", () => {
    vi.stubEnv("EVE_EVALUATION", "1");
    vi.stubEnv("EVE_EVALUATION_RUN_ID", RUN_ID);

    expect(evaluationUser()(requestWithBearer(RUN_ID))).toEqual({
      attributes: {},
      authenticator: "eve-eval",
      principalId: "eval-user",
      principalType: "user",
    });
  });

  it("skips outside an evaluation process even when the bearer matches the env", () => {
    vi.stubEnv("EVE_EVALUATION_RUN_ID", RUN_ID);

    expect(evaluationUser()(requestWithBearer(RUN_ID))).toBeNull();
  });

  it("skips a mismatched or missing bearer so the auth walk continues", () => {
    vi.stubEnv("EVE_EVALUATION", "1");
    vi.stubEnv("EVE_EVALUATION_RUN_ID", RUN_ID);

    expect(evaluationUser()(requestWithBearer("not-the-run-id"))).toBeNull();
    expect(evaluationUser()(requestWithBearer())).toBeNull();
  });

  it("skips when the evaluation process has no run id", () => {
    vi.stubEnv("EVE_EVALUATION", "1");
    vi.stubEnv("EVE_EVALUATION_RUN_ID", "");

    expect(evaluationUser()(requestWithBearer(""))).toBeNull();
  });
});
