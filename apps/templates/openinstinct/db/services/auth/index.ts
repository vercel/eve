import { createHash } from "node:crypto";
import { link } from "@stripe/link-integrations-better-auth";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { account, db, session, user, verification } from "@db";
import { betterAuthBaseURL } from "@shared/environment/origin";
import { env, localPhoneAuthBypassEnabled } from "@shared/environment";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { LinqDeliveryError, linqOtpFailure, sendLinqText } from "./linq";
import { isE164PhoneNumber } from "@shared/identity/phone-number";

let authPromise: ReturnType<typeof initializeAuth> | undefined;

export function getAuth() {
  authPromise ??= initializeAuthWithRetry();
  return authPromise;
}

async function initializeAuthWithRetry() {
  try {
    return await initializeAuth();
  } catch (error) {
    authPromise = undefined;
    throw error;
  }
}

async function initializeAuth() {
  const { betterAuthSecret } = await getInstallationSecrets();
  const { LINK_CLIENT_ID, LINK_CLIENT_SECRET, STRIPE_PUBLISHABLE_KEY } = env;
  return betterAuth({
    appName: "Local Vault Assistant",
    baseURL: betterAuthBaseURL(),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { account, session, user, verification },
    }),
    disabledPaths: [
      "/change-email",
      "/request-password-reset",
      "/reset-password",
      "/reset-password/:token",
      "/send-verification-email",
      "/sign-in/email",
      "/sign-in/social",
      "/sign-up/email",
      "/verify-email",
      // Wallet disconnection must revoke the Link grant through its plugin.
      "/unlink-account",
    ],
    account: {
      encryptOAuthTokens: true,
      additionalFields: {
        issuer: {
          type: "string",
          required: true,
          input: false,
          defaultValue: "better-auth",
        },
      },
      accountLinking: {
        trustedProviders: ["link"],
        allowDifferentEmails: true,
        // Phone verification signs users in independently of OAuth accounts.
        allowUnlinkingAll: true,
      },
    },
    databaseHooks: {
      account: {
        create: {
          before: async (value) => {
            if (value.providerId === "link") {
              const [existing] = await db
                .select({ id: account.id })
                .from(account)
                .where(
                  and(
                    eq(account.userId, value.userId),
                    eq(account.providerId, "link")
                  )
                )
                .limit(1);
              // Reauthorization updates the same account. Replacing it requires
              // disconnecting first so the previous grant is revoked.
              if (existing) return false;
            }
            return { data: { ...value, issuer: value.providerId } };
          },
        },
      },
    },
    plugins: [
      ...(LINK_CLIENT_ID && LINK_CLIENT_SECRET && STRIPE_PUBLISHABLE_KEY
        ? [
            link({
              clientId: LINK_CLIENT_ID,
              clientSecret: LINK_CLIENT_SECRET,
              publishableKey: STRIPE_PUBLISHABLE_KEY,
            }),
          ]
        : []),
      phoneNumber({
        allowedAttempts: 3,
        expiresIn: 300,
        phoneNumberValidator: isE164PhoneNumber,
        requireVerification: true,
        sendOTP: localPhoneAuthBypassEnabled
          ? () => undefined
          : ({ code, phoneNumber: to }) => sendPhoneCode({ code, to }),
        signUpOnVerification: {
          getTempEmail: (phoneNumberValue) =>
            `phone-${createHash("sha256")
              .update(phoneNumberValue)
              .digest("hex")}@local-vault.invalid`,
          getTempName: () => "Phone user",
        },
        verifyOTP: localPhoneAuthBypassEnabled
          ? ({ phoneNumber: value }) => isE164PhoneNumber(value)
          : undefined,
      }),
    ],
    secret: betterAuthSecret,
  });
}

export async function sendPhoneCode({
  code,
  to,
}: {
  readonly code: string;
  readonly to: string;
}) {
  if (!env.LINQ_CONNECTOR) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "LINQ_NOT_CONFIGURED",
      message:
        "iMessage sign-in is not configured. Attach a Linq connector to this deployment.",
    });
  }

  try {
    await sendLinqText({
      connector: env.LINQ_CONNECTOR,
      idempotencyKey: `auth-otp-${createHash("sha256")
        .update(`${to}\u0000${code}`)
        .digest("hex")}`,
      message: `Local Vault Assistant sign-in code: ${code}. Expires in 5 minutes.`,
      to,
    });
  } catch (error) {
    if (error instanceof LinqDeliveryError) {
      const failure = linqOtpFailure(error);
      throw new APIError("BAD_GATEWAY", {
        code: failure.code,
        linqError: {
          code: error.code,
          message: error.linqMessage,
          status: error.status,
          trace_id: error.traceId,
        },
        message: failure.message,
      });
    }

    throw new APIError("BAD_GATEWAY", {
      code: "LINQ_CONNECTOR_UNAVAILABLE",
      message:
        "This deployment cannot access its Linq connector. Check LINQ_CONNECTOR and the connector's Vercel project attachment.",
    });
  }
}
