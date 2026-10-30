import type { ResendEmailAuthentication } from "#public/channels/resend/inbound.js";

const DEFAULT_RESEND_API_BASE_URL = "https://api.resend.com";

/** A Resend credential, given directly or resolved lazily on each use. */
export type ResendCredentialValue = string | (() => string | Promise<string>);

/** Fetch implementation used for Resend API calls. */
export type ResendFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Options for Resend API calls. */
export interface ResendApiOptions {
  /** Resend API base URL. Defaults to `https://api.resend.com`. */
  readonly baseUrl?: string;
  /** Fetch implementation. Defaults to the global `fetch`. */
  readonly fetch?: ResendFetch;
}

/** A received email as the Resend API returns it, with only the fields the channel reads. */
export interface ResendReceivedEmailPayload {
  readonly id?: unknown;
  readonly message_id?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly cc?: unknown;
  readonly subject?: unknown;
  readonly text?: unknown;
  readonly html?: unknown;
  readonly headers?: unknown;
  readonly attachments?: unknown;
  readonly authentication?: ResendEmailAuthentication | null;
}

/** Body of `POST /emails`. */
export interface ResendSendEmailInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly cc?: readonly string[];
  readonly replyTo?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}

/** Error from a Resend API call. */
export class ResendApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ResendApiError";
    this.status = status;
  }
}

/** Resolves the Resend API key, falling back to `RESEND_API_KEY`. */
export async function resolveResendApiKey(apiKey?: ResendCredentialValue): Promise<string> {
  const value =
    typeof apiKey === "function" ? await apiKey() : (apiKey ?? process.env.RESEND_API_KEY);
  if (!value) throw new Error("resendChannel: RESEND_API_KEY is required.");
  return value;
}

/** Retrieves a received email, including its body and headers. */
export async function getReceivedEmail(input: {
  readonly apiKey?: ResendCredentialValue;
  readonly api?: ResendApiOptions;
  readonly emailId: string;
}): Promise<ResendReceivedEmailPayload> {
  const result = await callResendApi({
    api: input.api,
    apiKey: input.apiKey,
    method: "GET",
    // `cid` keeps inline images out of `html`; the default inlines them as base64 data URIs.
    path: `/emails/receiving/${encodeURIComponent(input.emailId)}?html_format=cid`,
  });
  if (typeof result !== "object" || result === null) {
    throw new ResendApiError(0, "resendChannel: Resend returned an unexpected received email.");
  }
  return result as ResendReceivedEmailPayload;
}

/** Sends an email through `POST /emails` and returns its Resend email ID. */
export async function sendResendEmail(input: {
  readonly apiKey?: ResendCredentialValue;
  readonly api?: ResendApiOptions;
  readonly email: ResendSendEmailInput;
}): Promise<{ readonly id: string }> {
  const { email } = input;
  const result = await callResendApi({
    api: input.api,
    apiKey: input.apiKey,
    body: {
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      ...(email.html !== undefined && { html: email.html }),
      ...(email.cc !== undefined && { cc: email.cc }),
      ...(email.replyTo !== undefined && { reply_to: email.replyTo }),
      ...(email.headers !== undefined && { headers: email.headers }),
    },
    method: "POST",
    path: "/emails",
  });
  const id = (result as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string") {
    throw new ResendApiError(0, "resendChannel: Resend did not return an email ID.");
  }
  return { id };
}

async function callResendApi(input: {
  readonly api: ResendApiOptions | undefined;
  readonly apiKey: ResendCredentialValue | undefined;
  readonly body?: unknown;
  readonly method: "GET" | "POST";
  readonly path: string;
}): Promise<unknown> {
  const apiKey = await resolveResendApiKey(input.apiKey);
  const fetchImpl = input.api?.fetch ?? fetch;
  const response = await fetchImpl(
    `${input.api?.baseUrl ?? DEFAULT_RESEND_API_BASE_URL}${input.path}`,
    {
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(input.body !== undefined && { "content-type": "application/json" }),
      },
      method: input.method,
    },
  );
  const json = parseJson(await response.text());
  if (!response.ok) {
    const message = (json as { message?: unknown } | undefined)?.message;
    throw new ResendApiError(
      response.status,
      `resendChannel: Resend API request failed with ${response.status}` +
        (typeof message === "string" ? `: ${message}` : "."),
    );
  }
  return json;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
