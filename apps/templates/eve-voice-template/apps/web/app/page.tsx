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
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center gap-10 px-4 py-10">
      <header className="flex w-full items-center justify-between">
        <h1 className="text-lg font-semibold">eve voice</h1>
        {viewer ? <SignOut authMode={status.authMode} /> : null}
      </header>

      {!status.appReady ? (
        <div className="w-full rounded-lg border border-border bg-card p-6 text-sm">
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
