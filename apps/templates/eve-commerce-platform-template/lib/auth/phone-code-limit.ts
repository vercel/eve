import { createHmac } from "node:crypto";
import { lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { phoneCodeLimits } from "@/lib/db/schema";

const sendsPerWindow = 3;
const windowSeconds = 300;

/** Reserve a send before Better Auth creates a code, independent of verification state. */
export async function reservePhoneCodeSend(phoneNumber: string, secret: string) {
  const recipientKey = createHmac("sha256", secret)
    .update(`phone-code-limit:${phoneNumber}`)
    .digest("hex");
  const windowEnd = sql`now() + (${windowSeconds}::integer * interval '1 second')`;
  const expired = lte(phoneCodeLimits.windowEndsAt, sql`now()`);
  const [reservation] = await db
    .insert(phoneCodeLimits)
    .values({ recipientKey, sends: 1, windowEndsAt: windowEnd })
    .onConflictDoUpdate({
      target: phoneCodeLimits.recipientKey,
      set: {
        sends: sql`case when ${expired} then 1 else ${phoneCodeLimits.sends} + 1 end`,
        windowEndsAt: sql`case when ${expired} then ${windowEnd} else ${phoneCodeLimits.windowEndsAt} end`,
      },
      setWhere: or(expired, lt(phoneCodeLimits.sends, sendsPerWindow)),
    })
    .returning({ recipientKey: phoneCodeLimits.recipientKey });
  return reservation !== undefined;
}
