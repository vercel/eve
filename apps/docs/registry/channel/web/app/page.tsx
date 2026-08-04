import { headers } from "next/headers";
import { AgentChat } from "@/app/_components/agent-chat";
import { AccessForm } from "@/app/_components/access-form";
import { AuthSetup } from "@/app/_components/auth-setup";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { auth } from "@/lib/auth";

export default async function Page() {
  const isDevelopment = process.env.NODE_ENV === "development";
  const requiresLogin = !isDevelopment || process.env.EVE_REQUIRE_LOCAL_AUTH === "1";

  if (!requiresLogin) {
    return <AgentChat />;
  }

  if (!auth) {
    return <AuthSetup />;
  }

  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    return <AccessForm />;
  }

  return (
    <>
      <SignOutButton />
      <AgentChat />
    </>
  );
}
