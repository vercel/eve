import { getToken } from "@vercel/connect";
import { z } from "zod";
import { isE164PhoneNumber } from "@shared/identity/phone-number";

const LINQ_AVAILABLE_NUMBER_URL =
  "https://api.linqapp.com/api/partner/v3/available_number";
const LINQ_MESSAGES_URL = "https://api.linqapp.com/api/partner/v3/messages";
const linqAvailableNumberSchema = z.object({
  phone_number: z.string().refine(isE164PhoneNumber),
});
const linqErrorResponseSchema = z.object({
  code: z.number().int().optional(),
  error: z
    .object({
      code: z.number().int().optional(),
      message: z.string().min(1).optional(),
    })
    .optional(),
  message: z.string().min(1).optional(),
  trace_id: z.string().min(1).optional(),
});

export class LinqDeliveryError extends Error {
  readonly code: number | undefined;
  readonly linqMessage: string | undefined;
  readonly status: number;
  readonly traceId: string | undefined;

  constructor({
    code,
    linqMessage,
    status,
    traceId,
  }: {
    readonly code?: number;
    readonly linqMessage?: string;
    readonly status: number;
    readonly traceId?: string;
  }) {
    const diagnostics = [
      code === undefined ? undefined : `code ${String(code)}`,
      linqMessage,
      traceId === undefined ? undefined : `trace_id ${traceId}`,
    ].filter((value) => value !== undefined);
    super(
      `Linq message delivery failed with HTTP ${String(status)}${
        diagnostics.length === 0 ? "" : ` (${diagnostics.join("; ")})`
      }.`
    );
    this.name = "LinqDeliveryError";
    this.code = code;
    this.linqMessage = linqMessage;
    this.status = status;
    this.traceId = traceId;
  }
}

export function linqOtpFailure(error: LinqDeliveryError) {
  if (
    error.status === 409 &&
    /no eligible (?:sending )?(?:line|phone number)/i.test(
      error.linqMessage ?? ""
    )
  ) {
    return {
      code: "LINQ_SENDING_LINE_UNAVAILABLE",
      message:
        "No Linq line is currently eligible to send a code. If this is a new line, complete the first-time sign-in steps above; otherwise review the line's health in Linq and try again.",
    };
  }

  switch (error.code) {
    case 2006:
      return {
        code: "LINQ_SENDING_LINE_NOT_AUTHORIZED",
        message:
          "Linq has not authorized a sending line for this connector. If this is a new line, complete the first-time sign-in steps above; otherwise confirm the connector's API token can access the active line in Linq.",
      };
    case 2008:
      return {
        code: "LINQ_RECIPIENT_NOT_VERIFIED",
        message:
          "Complete the first-time sign-in steps above: text the deployment's Linq number once from this phone, then request another code.",
      };
    case 2024:
      return {
        code: "LINQ_RECIPIENT_OPTED_OUT",
        message:
          "This phone number has opted out of messages from this Linq line. Re-enable messages or use another phone number.",
      };
    case 2027:
      return {
        code: "LINQ_REPUTATION_BLOCKED",
        message:
          "This Linq line cannot send a code because of its messaging reputation. Review the line in Linq, then try again.",
      };
    default:
      return {
        code: "LINQ_DELIVERY_FAILED",
        message:
          "Linq could not send a sign-in code. Check the connector and its sending line, then try again.",
      };
  }
}

export async function readLinqOnboardingPhoneNumber(connector: string) {
  try {
    const token = await getToken(connector, {
      subject: { type: "app" },
    });
    const response = await fetch(LINQ_AVAILABLE_NUMBER_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json().catch(() => undefined);
    return linqAvailableNumberSchema.safeParse(body).data?.phone_number;
  } catch {
    return undefined;
  }
}

export async function sendLinqText({
  connector,
  idempotencyKey,
  message,
  to,
}: {
  readonly connector: string;
  readonly idempotencyKey: string;
  readonly message: string;
  readonly to: string;
}) {
  const token = await getToken(connector, {
    subject: { type: "app" },
  });
  const response = await fetch(LINQ_MESSAGES_URL, {
    body: JSON.stringify({
      message: { parts: [{ type: "text", value: message }] },
      to: [to],
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    method: "POST",
  });
  if (response.ok) return;

  const body: unknown = await response.json().catch(() => undefined);
  const linqError = linqErrorResponseSchema.safeParse(body).data;
  throw new LinqDeliveryError({
    code: linqError?.error?.code ?? linqError?.code,
    linqMessage: linqError?.error?.message ?? linqError?.message,
    status: response.status,
    traceId:
      linqError?.trace_id ?? response.headers.get("x-trace-id") ?? undefined,
  });
}
