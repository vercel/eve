/* oxlint-disable vitest/require-mock-type-parameters -- The connector mock needs only the token operation exercised here. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LinqDeliveryError,
  linqOtpFailure,
  readLinqOnboardingPhoneNumber,
  sendLinqText,
} from "@db/services/auth/linq";

const mocks = vi.hoisted(() => ({ getToken: vi.fn() }));

vi.mock("@vercel/connect", () => ({ getToken: mocks.getToken }));

describe("Linq delivery", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the configured connector and sends the OTP", async () => {
    mocks.getToken.mockResolvedValue("test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendLinqText({
      connector: "linq/open-instinct",
      idempotencyKey: "otp-idempotency-key",
      message: "Your code is 123456.",
      to: "+12025550123",
    });

    expect(mocks.getToken).toHaveBeenCalledWith("linq/open-instinct", {
      subject: { type: "app" },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.linqapp.com/api/partner/v3/messages");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Idempotency-Key": "otp-idempotency-key",
    });
    expect(init?.method).toBe("POST");
  });

  it("retrieves the Linq number used for first-time onboarding", async () => {
    mocks.getToken.mockResolvedValue("test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ phone_number: "+12025550123" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readLinqOnboardingPhoneNumber("linq/open-instinct")
    ).resolves.toBe("+12025550123");
    expect(mocks.getToken).toHaveBeenCalledWith("linq/open-instinct", {
      subject: { type: "app" },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.linqapp.com/api/partner/v3/available_number");
    expect(init?.headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("fails soft when Linq cannot provide an onboarding number", async () => {
    mocks.getToken.mockRejectedValue(new Error("connector unavailable"));

    await expect(
      readLinqOnboardingPhoneNumber("linq/open-instinct")
    ).resolves.toBeUndefined();
  });

  it("preserves diagnostics from Linq's current error envelope", async () => {
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

    const error = await captureLinqDeliveryError();
    expect(error).toMatchObject({
      code: 2015,
      linqMessage: "no eligible sending line available",
      status: 409,
      traceId: "trace-123",
    });
    expect(error.message).toContain("trace_id trace-123");
  });

  it("preserves diagnostics from Linq's legacy error envelope", async () => {
    mocks.getToken.mockResolvedValue("test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            code: 2024,
            message: "Recipient opted out",
            trace_id: "legacy-trace",
          },
          { status: 403 }
        )
      )
    );

    const error = await captureLinqDeliveryError();

    expect(error).toMatchObject({
      code: 2024,
      linqMessage: "Recipient opted out",
      status: 403,
      traceId: "legacy-trace",
    });
  });

  it("falls back to Linq's trace response header", async () => {
    mocks.getToken.mockResolvedValue("test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: { code: 2008, message: "Recipient not allowed" },
            success: false,
          },
          { headers: { "x-trace-id": "trace-header" }, status: 403 }
        )
      )
    );

    const error = await captureLinqDeliveryError();

    expect(error).toMatchObject({
      code: 2008,
      linqMessage: "Recipient not allowed",
      status: 403,
      traceId: "trace-header",
    });
  });

  it.each([
    [2006, "LINQ_SENDING_LINE_NOT_AUTHORIZED", "API token"],
    [2008, "LINQ_RECIPIENT_NOT_VERIFIED", "first-time sign-in steps"],
    [2024, "LINQ_RECIPIENT_OPTED_OUT", "opted out"],
    [2027, "LINQ_REPUTATION_BLOCKED", "messaging reputation"],
  ])("maps Linq code %i to actionable OTP copy", (code, expectedCode, copy) => {
    const failure = linqOtpFailure(
      new LinqDeliveryError({ code, status: 409 })
    );

    expect(failure.code).toBe(expectedCode);
    expect(failure.message).toContain(copy);
  });

  it("explains how to verify a newly provisioned sending line", () => {
    const failure = linqOtpFailure(
      new LinqDeliveryError({
        code: 2015,
        linqMessage: "no eligible sending line available",
        status: 409,
      })
    );

    expect(failure.code).toBe("LINQ_SENDING_LINE_UNAVAILABLE");
    expect(failure.message).toContain("line's health");
  });

  it("does not mislabel unrelated Linq conflicts as verification failures", () => {
    const failure = linqOtpFailure(
      new LinqDeliveryError({
        code: 2015,
        linqMessage: "Operation conflicts with current state",
        status: 409,
      })
    );

    expect(failure.code).toBe("LINQ_DELIVERY_FAILED");
  });
});

async function captureLinqDeliveryError(): Promise<LinqDeliveryError> {
  try {
    await sendLinqText({
      connector: "linq/open-instinct",
      idempotencyKey: "otp-idempotency-key",
      message: "Your code is 123456.",
      to: "+12025550123",
    });
  } catch (error) {
    if (error instanceof LinqDeliveryError) return error;
    throw error;
  }
  throw new Error("Expected Linq delivery to fail.");
}
