import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, like } from "drizzle-orm";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { db } from "@/lib/db";
import { account, session, user, verification } from "@/lib/db/schema";
import { betterAuthBaseURL } from "@/lib/environment/origin";
import { env, isLoopbackHostname, localPhoneAuthBypassEnabled } from "@/lib/environment/env";
import { getInstallationSecrets } from "@/lib/auth/installation-secrets";
import { reservePhoneCodeSend } from "@/lib/auth/phone-code-limit";
import {
  LinqDeliveryError,
  linqOtpFailure,
  readLinqOnboardingPhoneNumber,
  sendLinqText,
} from "@/lib/linq/sign-in";
import {
  isE164PhoneNumber,
  LINQ_RECIPIENT_NOT_VERIFIED,
  PHONE_CODE_RATE_LIMITED,
} from "@/lib/auth/phone-number";

const PHONE_CODE_EXPIRES_IN_SECONDS = 300;

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
  return betterAuth({
    appName: "evey",
    baseURL: betterAuthBaseURL(),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { account, session, user, verification },
    }),
    // Users sign in only with a phone number verified over iMessage.
    disabledPaths: [
      "/change-email",
      "/request-password-reset",
      "/reset-password",
      "/reset-password/:token",
      "/send-verification-email",
      "/sign-in/email",
      "/sign-in/phone-number",
      "/sign-in/social",
      "/sign-up/email",
      "/verify-email",
      "/phone-number/request-password-reset",
      "/phone-number/reset-password",
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/phone-number/verify" && ctx.body?.updatePhoneNumber === true) {
          throw new APIError("FORBIDDEN", {
            message: "Changing the sign-in phone number is not supported.",
          });
        }
        if (ctx.path !== "/phone-number/send-otp" || localPhoneAuthBypassEnabled) return;
        requireLinqConnector();
        const to: unknown = ctx.body?.phoneNumber;
        if (typeof to !== "string" || !isE164PhoneNumber(to)) return;
        if (!(await reservePhoneCodeSend(to, betterAuthSecret))) {
          throw new APIError("TOO_MANY_REQUESTS", {
            code: PHONE_CODE_RATE_LIMITED,
            message:
              "Too many codes were requested for this number. Use the latest code you received, or wait a few minutes and try again.",
          });
        }
      }),
    },
    plugins: [
      phoneNumber({
        allowedAttempts: 3,
        expiresIn: PHONE_CODE_EXPIRES_IN_SECONDS,
        phoneNumberValidator: isE164PhoneNumber,
        requireVerification: true,
        sendOTP: localPhoneAuthBypassEnabled
          ? () => undefined
          : ({ code, phoneNumber: to }) => sendPhoneCode({ code, to }),
        signUpOnVerification: {
          getTempEmail: (phoneNumberValue) =>
            `phone-${createHash("sha256").update(phoneNumberValue).digest("hex")}@users.invalid`,
          getTempName: () => "Phone user",
        },
        verifyOTP: localPhoneAuthBypassEnabled
          ? ({ phoneNumber: value, code }, ctx) =>
              code === "000000" &&
              isE164PhoneNumber(value) &&
              ctx?.request !== undefined &&
              isLoopbackHostname(new URL(ctx.request.url).hostname)
          : undefined,
      }),
    ],
    secret: betterAuthSecret,
  });
}

function requireLinqConnector() {
  if (!env.LINQ_CONNECTOR) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "LINQ_NOT_CONFIGURED",
      message: "iMessage sign-in is not configured. Attach a Linq connector to this deployment.",
    });
  }
  return env.LINQ_CONNECTOR;
}

async function sendPhoneCode({ code, to }: { readonly code: string; readonly to: string }) {
  const connector = requireLinqConnector();
  try {
    await sendLinqText({
      connector,
      idempotencyKey: `auth-otp-${createHash("sha256").update(`${to}\u0000${code}`).digest("hex")}`,
      message: `${code} is your evey sign-in code. It expires in 5 minutes.`,
      to,
    });
  } catch (error) {
    // Better Auth inserts before delivery; do not leave an unsent code active.
    await db
      .delete(verification)
      .where(and(eq(verification.identifier, to), like(verification.value, `${code}:%`)));
    if (error instanceof LinqDeliveryError) {
      const failure = linqOtpFailure(error);
      const linqPhoneNumber =
        failure.code === LINQ_RECIPIENT_NOT_VERIFIED
          ? (env.LINQ_PHONE_NUMBER ?? (await readLinqOnboardingPhoneNumber(connector, to)))
          : undefined;
      if (failure.code !== LINQ_RECIPIENT_NOT_VERIFIED) {
        console.warn("[linq] sign-in code delivery failed", {
          code: error.code,
          status: error.status,
          traceId: error.traceId,
        });
      }
      throw new APIError("BAD_GATEWAY", {
        code: failure.code,
        linqPhoneNumber,
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
