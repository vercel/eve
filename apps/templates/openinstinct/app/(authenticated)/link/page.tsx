import { z } from "zod";
import { getLinkAccount, linkConfigured } from "@db/services/auth/link";
import { requireRequestScope } from "@web/auth/request-scope";
import { Button } from "@web/components/ui/button";
import { applicationOrigin } from "@shared/environment/origin";

export const metadata = {
  title: "Link wallet",
  // Native form POSTs need their Origin header for the route's CSRF check.
  // Cross-origin navigations still receive no referrer.
  referrer: "same-origin" as const,
};

export default async function Page({ searchParams }: PageProps<"/link">) {
  const scope = await requireRequestScope();
  const params = await searchParams;
  const attempt = z.uuid().safeParse(params.attempt);
  const configured = linkConfigured();
  const callbackUrl = new URL("/api/auth/callback/link", applicationOrigin())
    .href;
  const connected =
    configured &&
    Boolean(await getLinkAccount(scope.userId.slice("better-auth:".length)));
  const reauthenticationRequired =
    connected && params.error === "reauthentication_required";
  const disconnectError =
    params.error === "reauthentication_required" ||
    params.error === "disconnection_failed";
  const returnUrl = attempt.success ? `/link?attempt=${attempt.data}` : "/link";
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <div className="space-y-2">
        <h1 className="type-page-title">Link wallet</h1>
        <p className="type-body text-muted-foreground">
          {configured
            ? connected
              ? "Your Link wallet is connected. Purchases still require approval in Link."
              : "Connect your Link wallet to use it with OpenInstinct. Purchases require your approval in Link."
            : "Link is not available on this installation yet."}
        </p>
      </div>
      {!configured && (
        <section aria-labelledby="link-setup-heading" className="space-y-4">
          <h2 id="link-setup-heading" className="type-section-title">
            Set up Link for this installation
          </h2>
          <p className="type-supporting-body text-muted-foreground">
            OpenInstinct works without Link. To enable wallet connections, the
            person managing this deployment needs to complete these steps.
          </p>
          <ol className="type-supporting-body list-decimal space-y-4 pl-5">
            <li className="space-y-2">
              <p>
                <a
                  href="https://docs.stripe.com/agentic-commerce/link-agent-wallet/oauth"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  Register a Link OAuth client with Stripe
                </a>
                . Include this exact callback URL in the registration:
              </p>
              <code className="type-code block rounded-md border border-border bg-muted/50 p-3 break-all">
                {callbackUrl}
              </code>
              <p className="text-muted-foreground">
                Register each deployment or local development URL you plan to
                use. Keep the app’s configured origin consistent with that URL.
              </p>
            </li>
            <li className="space-y-2">
              <p>
                Add these environment variables in your Vercel project’s
                Settings, or in <code>.env.local</code> for local development:
              </p>
              <ul className="space-y-1">
                <li>
                  <code>LINK_CLIENT_ID</code> — issued by Stripe
                </li>
                <li>
                  <code>LINK_CLIENT_SECRET</code> — issued by Stripe
                </li>
                <li>
                  <code>STRIPE_PUBLISHABLE_KEY</code> — from your Stripe account
                </li>
              </ul>
              <p className="text-muted-foreground">
                Keep the client secret in server settings. Do not paste it into
                a conversation or commit it to your repository.
              </p>
            </li>
            <li>
              Redeploy the app, or restart the local server. Return here and
              choose Connect Link to authorize your own wallet.
            </li>
          </ol>
        </section>
      )}
      {params.error && (
        <p role="alert" className="type-supporting text-destructive">
          {disconnectError && !connected
            ? "Your wallet is no longer connected."
            : reauthenticationRequired
              ? "Sign in again before disconnecting your wallet. Your wallet is still connected."
              : disconnectError
                ? "Your wallet could not be disconnected. It is still connected. Try again shortly."
                : "The wallet connection could not be completed. Try again. To use a different wallet, disconnect the current wallet first."}
        </p>
      )}
      {configured && (
        <div className="flex flex-wrap gap-3">
          {(!connected || attempt.success) && (
            <form action="/api/link" method="post">
              <input type="hidden" name="operation" value="connect" />
              {attempt.success && (
                <input type="hidden" name="attempt" value={attempt.data} />
              )}
              <Button type="submit">
                {connected ? "Reconnect Link and continue" : "Connect Link"}
              </Button>
            </form>
          )}
          {reauthenticationRequired ? (
            <Button
              nativeButton={false}
              render={
                <a
                  aria-label="Sign in again"
                  href={`/sign-in?reauthenticate=true&callbackUrl=${encodeURIComponent(returnUrl)}`}
                />
              }
            >
              Sign in again
            </Button>
          ) : (
            connected && (
              <form action="/api/link" method="post">
                <input type="hidden" name="operation" value="disconnect" />
                <Button type="submit" variant="outline">
                  Disconnect wallet
                </Button>
              </form>
            )
          )}
        </div>
      )}
      {configured && (
        <section aria-labelledby="link-usage-heading" className="space-y-3">
          <h2 id="link-usage-heading" className="type-section-title">
            Using your wallet
          </h2>
          <p className="type-supporting-body text-muted-foreground">
            After connecting, ask OpenInstinct to help with a purchase. It will
            send you a Link approval request before using payment credentials.
            Connecting your wallet does not approve a purchase.
          </p>
          <p className="type-supporting-body text-muted-foreground">
            You can connect one Link wallet to your OpenInstinct account. To
            switch wallets, disconnect the current one first. Disconnecting
            revokes OpenInstinct’s access; your phone sign-in still works.
          </p>
        </section>
      )}
    </main>
  );
}
