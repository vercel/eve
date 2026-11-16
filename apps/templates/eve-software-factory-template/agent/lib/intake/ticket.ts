import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { FACTORY_BRANCH_PREFIX, FACTORY_REPO } from "../constants.js";
import { AUTONOMOUS_PRINCIPAL } from "../trust.js";

export const MAX_TICKET_BYTES = 64 * 1024;
export const TICKET_ID_PATTERN = /^[0-9a-f]{32}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject metadata line injection
const SINGLE_LINE = /^[^\u0000-\u001f\u007f\u2028\u2029]*$/;
const singleLine = (max: number) =>
  z.string().min(1).max(max).regex(SINGLE_LINE);

export const ticketSchema = z.strictObject({
  body: z.string().min(1).max(20_000),
  externalId: singleLine(200).optional(),
  labels: z.array(singleLine(50)).max(20).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  requester: singleLine(200).optional(),
  source: singleLine(100).optional(),
  title: singleLine(300),
});

const sha256 = (text: string): Buffer =>
  createHash("sha256").update(text).digest();

/** No local-dev or general project-OIDC fallback on this write entrypoint. */
export const intakeCaller = (request: Request): string | null => {
  const configured = process.env.FACTORY_INTAKE_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  if (
    !configured ||
    configured.length < 32 ||
    configured.length > 4096 ||
    header.length > 4103 ||
    !header.startsWith("Bearer ")
  ) {
    return null;
  }
  const presented = header.slice(7);
  return timingSafeEqual(sha256(presented), sha256(configured))
    ? `intake:${sha256(configured).toString("hex")}`
    : null;
};

export const ticketIdFor = (
  caller: string,
  externalId: string | undefined
): string =>
  externalId === undefined
    ? randomUUID().replaceAll("-", "")
    : sha256(JSON.stringify([caller, externalId]))
        .toString("hex")
        .slice(0, 32);

export const ticketAddress = (id: string, caller: string): string =>
  `ticket:${sha256(caller).toString("hex").slice(0, 16)}:${id}`;

/** Server-bound ticket authority; HTTP intake never inherits caller trust. */
export function autonomousForTicket(address: string): SessionAuthContext {
  const digest = sha256(address).toString("hex");
  return {
    attributes: {
      factoryRepository: FACTORY_REPO.toLowerCase(),
      ticketBranch: `${FACTORY_BRANCH_PREFIX}ticket-${digest}`,
    },
    authenticator: "intake-token",
    principalId: AUTONOMOUS_PRINCIPAL,
    principalType: "service",
  };
}

export const renderTicket = (ticket: z.infer<typeof ticketSchema>): string => {
  const metadata = [
    ticket.source && `Source: ${ticket.source}`,
    ticket.externalId && `External id: ${ticket.externalId}`,
    ticket.requester && `Requester (unverified): ${ticket.requester}`,
    ticket.priority && `Submitter's priority: ${ticket.priority}`,
    ticket.labels?.length && `Submitter's labels: ${ticket.labels.join(", ")}`,
  ].filter((line): line is string => typeof line === "string");
  return [`# ${ticket.title}`, ...metadata, "", ticket.body].join("\n");
};

/** Stop reading at the byte cap, including bodies with no Content-Length. */
export const readLimitedText = async (
  request: Request,
  maxBytes: number
): Promise<string | null> => {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    return null;
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      // biome-ignore lint/performance/noAwaitInLoops: bounded streaming read
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        return Buffer.concat(chunks).toString("utf8");
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
};
