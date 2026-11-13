import type { Page } from "@browserbasehq/stagehand";
import { allowedMerchantUrl, prepareMerchantAccess } from "./merchant-access";
import { navigateWithMerchantProof } from "./merchant-navigation";

export async function verifiedMerchantAccess(
  page: Page,
  connectUrl: string,
  value: string,
  signal: AbortSignal,
) {
  const url = allowedMerchantUrl(value);
  const access = await prepareMerchantAccess(url.href, signal);
  for (let attempt = 1; attempt <= 2; attempt++) {
    signal.throwIfAborted();
    const response = await navigateWithMerchantProof(
      page,
      connectUrl,
      url.href,
      await access.headers(),
      signal,
    );
    const httpStatus = response.status();
    const body = httpStatus === 200 ? "" : await response.text().catch(() => "");
    const code = body.match(
      /\b(?:STATUS_UNAVAILABLE|NONCE_INVALID|CREDENTIAL_MISSING|AUDIENCE_MISMATCH|CREDENTIAL_EXPIRED|INVALID_SIGNATURE|UNTRUSTED_ISSUER)\b/,
    )?.[0];
    if (attempt === 1 && httpStatus === 401 && code === "STATUS_UNAVAILABLE") continue;
    return {
      status: httpStatus === 200 ? "access_granted" : "access_denied",
      url: url.href,
      httpStatus,
      audience: access.audience,
      scope: access.scope,
      level: "L2",
      attempts: attempt,
      ...(code ? { code } : {}),
    };
  }
  throw new Error("Merchant verification did not complete.");
}
