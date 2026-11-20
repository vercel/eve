import { redirect } from "next/navigation";
import Link from "next/link";
import { EveLockup } from "@/components/logo";
import { LocalPhoneAuthForm } from "@/app/sign-in/_components/local-form";
import { PhoneOtpAuthForm } from "@/app/sign-in/_components/otp-form";
import { env, localPhoneAuthBypassEnabled } from "@/lib/environment/env";
import { readRequestSession } from "@/lib/auth/next";

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const params = await searchParams;
  const reauthenticate = params.reauthenticate === "true";
  if (!reauthenticate && (await readRequestSession())) redirect("/");

  const callbackValue = params.callbackUrl;
  const requestedCallback = Array.isArray(callbackValue) ? callbackValue[0] : callbackValue;
  const callbackUrl = signInCallbackUrl(requestedCallback);
  const linqConfigured = env.LINQ_CONNECTOR !== undefined;

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-6xl flex-col px-6 sm:px-10">
      <header className="mx-auto flex w-full max-w-5xl items-center py-8">
        <Link
          aria-label="Home"
          className="flex items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          href="/"
        >
          <EveLockup />
        </Link>
      </header>
      <main className="mx-auto grid w-full max-w-5xl flex-1 content-center items-center gap-12 pt-12 pb-32 md:grid-cols-2 md:gap-16">
        <div className="max-w-lg space-y-6">
          <h2 className="type-product-title text-3xl min-[380px]:text-4xl lg:text-5xl">
            Commerce Platform
          </h2>
          <p className="type-body max-w-md text-pretty text-muted-foreground md:text-lg">
            Shop over iMessage with an agent built on{" "}
            <a
              className="rounded-sm text-foreground underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
              href="https://eve.dev"
              rel="noreferrer"
              target="_blank"
            >
              eve
            </a>
            . Text what you need and get a link to review your cart and approve the purchase.
          </p>
        </div>
        <section
          aria-labelledby="sign-in-heading"
          className="w-full max-w-md space-y-3 md:justify-self-end"
        >
          <h1 className="type-page-title md:text-4xl" id="sign-in-heading">
            {reauthenticate ? "Sign in again" : "Sign in"}
          </h1>
          {!localPhoneAuthBypassEnabled && !linqConfigured ? (
            <p className="type-supporting-body text-muted-foreground">
              iMessage sign-in is not configured for this deployment. Attach a Linq connector
              through Vercel Connect.
            </p>
          ) : localPhoneAuthBypassEnabled ? (
            <LocalPhoneAuthForm callbackUrl={callbackUrl} />
          ) : (
            <PhoneOtpAuthForm callbackUrl={callbackUrl} />
          )}
        </section>
      </main>
    </div>
  );
}

function signInCallbackUrl(pathname: string | undefined) {
  switch (pathname) {
    case "/settings":
    case "/context":
    case "/deployment":
      return pathname;
    case "/personal-info":
    case "/settings/personal-info":
      return "/context";
    default:
      return "/";
  }
}
