import { createHmac, timingSafeEqual } from "node:crypto";
import { isE164PhoneNumber } from "@shared/identity/phone-number";
import { applicationOrigin } from "@shared/environment/origin";

const contactPath = "/contacts/openinstinct.vcf";
const lifetimeSeconds = 7 * 24 * 60 * 60;

export function openInstinctContactUrl(phoneNumber: string, secret: string) {
  if (!isE164PhoneNumber(phoneNumber)) {
    throw new Error("OpenInstinct's contact number must use E.164 format.");
  }
  const url = new URL(contactPath, applicationOrigin());
  if (url.protocol !== "https:") {
    throw new Error("Contact sharing requires a public HTTPS application URL.");
  }
  url.searchParams.set("phone", phoneNumber);
  url.searchParams.set(
    "expires",
    String(Math.floor(Date.now() / 1000) + lifetimeSeconds)
  );
  url.searchParams.set("signature", signature(url, secret).toString("hex"));
  return url.href;
}

export function verifyOpenInstinctContactUrl(url: URL, secret: string) {
  const phone = url.searchParams.get("phone");
  const expires = Number(url.searchParams.get("expires"));
  const now = Math.floor(Date.now() / 1000);
  const provided = url.searchParams.get("signature") ?? "";
  if (
    url.pathname !== contactPath ||
    !phone ||
    !isE164PhoneNumber(phone) ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + lifetimeSeconds ||
    !/^[a-f0-9]{64}$/.test(provided)
  ) {
    return undefined;
  }
  return timingSafeEqual(signature(url, secret), Buffer.from(provided, "hex"))
    ? phone
    : undefined;
}

function signature(url: URL, secret: string) {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "openinstinct-contact-v1",
        url.pathname,
        url.searchParams.get("phone"),
        url.searchParams.get("expires"),
      ])
    )
    .digest();
}
