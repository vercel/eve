import type { replaceUserProfile as replaceUserProfileType } from "../db/services/user-profile";
import { saveVaultItem } from "../db/services/vault";
import { accessScopeForUser } from "../shared/identity/access-scope";
import { serializePaymentCard } from "../shared/vault/schema";
import { z } from "zod";

const scope = accessScopeForUser("better-auth:browser-benchmark");
const nodeErrorSchema = z.object({ code: z.string() });

await seedStructuredProfileWhenSupported();

await saveVaultItem(scope, {
  account: "Visa · •••• 4242",
  kind: "payment",
  label: "Benchmark test card",
  secret: serializePaymentCard({
    billingPostalCode: "11201",
    cardholderName: "John Smith",
    expirationMonth: 12,
    expirationYear: 2034,
    kind: "payment-card",
    number: "4242424242424242",
    securityCode: "123",
    version: 1,
  }),
});

async function seedStructuredProfileWhenSupported() {
  let replaceUserProfile: typeof replaceUserProfileType;
  try {
    ({ replaceUserProfile } = await import("../db/services/user-profile"));
  } catch (error) {
    const parsed = nodeErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ERR_MODULE_NOT_FOUND") {
      console.warn(
        "Skipping structured benchmark profile for a revision that predates profile storage."
      );
      return;
    }
    throw error;
  }

  await replaceUserProfile(scope, {
    addressLine1: "123 Test Street",
    addressLine2: "Apartment 4B",
    city: "Brooklyn",
    countryCode: "US",
    dateOfBirth: "1990-01-01",
    email: "browser-benchmark@example.com",
    firstName: "John",
    lastName: "Smith",
    phone: "+12025550100",
    postalCode: "11201",
    region: "NY",
  });
}
