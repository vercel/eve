import { createHmac, timingSafeEqual } from "node:crypto";
import { isE164PhoneNumber } from "@/lib/auth/phone-number";
import { applicationOrigin } from "@/lib/environment/origin";
import { agentNameSchema, defaultAgentName } from "@/lib/shoppers/agent-name-schema";

const contactPath = "/contacts/evey.vcf";
const lifetimeSeconds = 7 * 24 * 60 * 60;

export function contactCardUrl(phoneNumber: string, secret: string, name: string) {
  if (!isE164PhoneNumber(phoneNumber)) {
    throw new Error("The contact number must use E.164 format.");
  }
  const url = new URL(contactPath, applicationOrigin());
  if (url.protocol !== "https:") {
    throw new Error("Contact sharing requires a public HTTPS application URL.");
  }
  url.searchParams.set("phone", phoneNumber);
  url.searchParams.set("name", agentNameSchema.parse(name));
  url.searchParams.set("expires", String(Math.floor(Date.now() / 1000) + lifetimeSeconds));
  url.searchParams.set("signature", signature(url, secret).toString("hex"));
  return url.href;
}

export function verifyContactCardUrl(url: URL, secret: string) {
  const phone = url.searchParams.get("phone");
  const name = agentNameSchema.safeParse(url.searchParams.get("name") ?? defaultAgentName);
  const expires = Number(url.searchParams.get("expires"));
  const now = Math.floor(Date.now() / 1000);
  const provided = url.searchParams.get("signature") ?? "";
  if (
    url.pathname !== contactPath ||
    !phone ||
    !isE164PhoneNumber(phone) ||
    !name.success ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + lifetimeSeconds ||
    !/^[a-f0-9]{64}$/.test(provided)
  ) {
    return undefined;
  }
  return timingSafeEqual(signature(url, secret), Buffer.from(provided, "hex"))
    ? { phone, name: name.data }
    : undefined;
}

function signature(url: URL, secret: string) {
  const fields = [
    "evey-contact-v1",
    url.pathname,
    url.searchParams.get("phone"),
    url.searchParams.get("expires"),
  ];
  if (url.searchParams.has("name")) fields.push(url.searchParams.get("name"));
  return createHmac("sha256", secret).update(JSON.stringify(fields)).digest();
}
