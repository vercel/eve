import { z } from "#compiled/zod/index.js";

const LINQ_PARTNER_API_URL = "https://api.linqapp.com/api/partner/v3/phone_numbers";

const PhoneNumbersSchema = z.object({
  phone_numbers: z.array(z.object({ phone_number: z.string().min(1) })),
});

export interface LinqManagementDeps {
  fetch: typeof fetch;
}

const defaultDeps: LinqManagementDeps = { fetch };

/** Lists the phone numbers assigned to a Linq partner API token. */
export async function listLinqPhoneNumbers(
  apiToken: string,
  signal?: AbortSignal,
  deps: LinqManagementDeps = defaultDeps,
): Promise<string[]> {
  const response = await deps.fetch(LINQ_PARTNER_API_URL, {
    headers: { accept: "application/json", authorization: `Bearer ${apiToken}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Could not fetch Linq phone numbers (${response.status}). Confirm the partner API token is valid.`,
    );
  }
  const result = PhoneNumbersSchema.safeParse(await response.json());
  if (!result.success) throw new Error("Linq returned invalid phone number data.");
  const phoneNumbers = result.data.phone_numbers.map(({ phone_number }) => phone_number);
  if (phoneNumbers.length === 0) {
    throw new Error("No phone numbers are assigned to this Linq partner API token.");
  }
  return phoneNumbers;
}
