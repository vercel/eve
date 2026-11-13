/* oxlint-disable vitest/require-mock-type-parameters -- The connector mock needs only the token operation exercised here. */
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
const mocks = vi.hoisted(() => ({ getToken: vi.fn() }));

vi.mock("@vercel/connect", () => ({ getToken: mocks.getToken }));

const linqApiErrorSchema = z.object({
  code: z.string(),
  linqError: z.object({
    code: z.number(),
    message: z.string(),
    status: z.number(),
    trace_id: z.string(),
  }),
  message: z.string(),
});

describe("Linq phone authentication", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("preserves provider diagnostics and returns actionable client copy", async () => {
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "0123456789abcdefghijklmnopqrstuvwxyzABCD"
    );
    vi.stubEnv("LINQ_CONNECTOR", "linq/open-instinct");
    mocks.getToken.mockResolvedValue("test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: 2015,
              message: "no eligible sending line available",
              status: 409,
            },
            success: false,
            trace_id: "trace-123",
          },
          { status: 409 }
        )
      )
    );

    const { sendPhoneCode } = await import("@db/services/auth");
    const error: unknown = await sendPhoneCode({
      code: "123456",
      to: "+12025550123",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(APIError);
    if (!(error instanceof APIError)) throw new TypeError("Expected APIError");

    const body = linqApiErrorSchema.parse(error.body);
    expect(body).toMatchObject({
      code: "LINQ_SENDING_LINE_UNAVAILABLE",
      linqError: {
        code: 2015,
        message: "no eligible sending line available",
        status: 409,
        trace_id: "trace-123",
      },
    });
    expect(body.message).toContain("line's health");
  });
});
