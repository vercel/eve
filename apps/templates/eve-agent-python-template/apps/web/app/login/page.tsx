import { LockIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAuthMode } from "@/lib/auth-mode";
import { LoginForm } from "./login-form";

export default function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ next?: string }>;
}) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <Suspense fallback={null}>
        <LoginCard searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/**
 * Reads the auth mode and `next` per request, so a static shell never bakes in the
 * build-time environment.
 */
async function LoginCard({
  searchParams,
}: {
  readonly searchParams: Promise<{ next?: string }>;
}) {
  const { next = "/" } = await searchParams;
  const mode = getAuthMode();
  if (mode === "local-dev") {
    redirect("/");
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="justify-items-center text-center">
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted">
          <LockIcon className="size-4 text-muted-foreground" />
        </div>
        <CardTitle className="text-xl">Sign In</CardTitle>
        <CardDescription>
          {mode === "password"
            ? "Enter the password for this agentic app."
            : "This agentic app has no password yet."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {mode === "password" ? (
          <LoginForm next={next} />
        ) : (
          <div className="rounded-lg border border-dashed bg-muted/50 p-4 text-sm text-muted-foreground">
            Set <code className="font-mono text-xs text-foreground">EVE_CHAT_PASSWORD</code> in
            the Vercel project&apos;s environment variables (16+ characters recommended), then
            redeploy.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
