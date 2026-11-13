import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import { PhoneOtpAuthForm } from "@app/sign-in/_components/otp-form";
import { env, localPhoneAuthBypassEnabled } from "@shared/environment";
import { getAuthSession } from "@db/services/auth/session";
import { readLinqOnboardingPhoneNumber } from "@db/services/auth/linq";

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const params = await searchParams;
  const reauthenticate = params.reauthenticate === "true";
  if (!reauthenticate && (await getAuthSession(await headers()))) redirect("/");

  const callbackValue = params.callbackUrl;
  const requestedCallback = Array.isArray(callbackValue)
    ? callbackValue[0]
    : callbackValue;
  const callbackUrl =
    requestedCallback?.startsWith("/") && !requestedCallback.startsWith("//")
      ? requestedCallback
      : "/";
  const linqConfigured = env.LINQ_CONNECTOR !== undefined;
  const linqPhoneNumber =
    localPhoneAuthBypassEnabled || !env.LINQ_CONNECTOR
      ? undefined
      : (env.LINQ_PHONE_NUMBER ??
        (await readLinqOnboardingPhoneNumber(env.LINQ_CONNECTOR)));

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm space-y-6">
        <div className="flex flex-col gap-2">
          <h1 className="type-page-title">
            {reauthenticate ? "Sign in again" : "Sign In"}
          </h1>
          <p className="type-supporting-body text-muted-foreground">
            Enter your phone number to sign in.
          </p>
        </div>
        {!localPhoneAuthBypassEnabled && !linqConfigured ? (
          <p className="type-supporting-body text-muted-foreground">
            iMessage sign-in is not configured for this deployment. Attach a
            Linq connector through Vercel Connect.
          </p>
        ) : localPhoneAuthBypassEnabled ? (
          <LocalPhoneAuthForm callbackUrl={callbackUrl} />
        ) : (
          <PhoneOtpAuthForm
            callbackUrl={callbackUrl}
            linqPhoneNumber={linqPhoneNumber}
          />
        )}
      </section>
    </main>
  );
}
