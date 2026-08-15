import { headers } from "next/headers";
import { AgentChat } from "./_components/agent-chat";
import { AccountControl, SignIn } from "./_components/web-chat-auth";
import { auth } from "@/lib/auth";

export default async function Page() {
  if (process.env.NODE_ENV === "development") {
    return <AgentChat />;
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return <SignIn />;
  }

  return (
    <>
      <AgentChat />
      <AccountControl
        email={session.user.email}
        image={session.user.image}
        name={session.user.name}
      />
    </>
  );
}
