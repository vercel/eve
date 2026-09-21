import type { PhoneLinkRecord } from "../../shared/types/phone-link.js";
import { appOrigin, internalHeaders } from "./internal-api.js";

export async function fetchPhoneLinkForNumber(phoneNumber: string) {
  const response = await fetch(
    `${appOrigin()}/api/internal/phone/link?phoneNumber=${encodeURIComponent(phoneNumber)}`,
    { headers: internalHeaders() },
  );

  if (!response.ok) {
    return undefined;
  }

  const body = (await response.json()) as { link: PhoneLinkRecord | null };
  return body.link ?? undefined;
}
