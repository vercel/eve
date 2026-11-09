import { connection } from "next/server";
import { SignIn } from "@/components/sign-in";
import { SignOut } from "@/components/sign-out";
import { VoiceCall } from "@/components/voice-call";
import { getServerViewer } from "@/lib/session";
import { getSetupStatus } from "@/lib/setup";

export default async function Home() {
  // Setup status and the viewer come from runtime env and cookies, never the build.
  await connection();
  const status = await getSetupStatus();
  const viewer = status.appReady ? await getServerViewer(status) : null;

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="mx-auto flex h-14 w-full max-w-3xl shrink-0 items-center justify-between px-4 sm:px-6">
        <h1 className="text-sm text-muted-foreground">eve voice</h1>
        {viewer ? <SignOut authMode={status.authMode} /> : null}
      </header>

      {!status.appReady ? (
        <div className="mx-auto mt-10 w-full max-w-sm rounded-lg border bg-card p-6 text-sm">
          <p className="font-medium">This app is not configured yet.</p>
          <p className="mt-2 text-muted-foreground">Missing: {status.missing.join("; ")}.</p>
        </div>
      ) : viewer ? (
        <VoiceCall />
      ) : (
        <SignIn authMode={status.authMode} />
      )}
    </main>
  );
}
