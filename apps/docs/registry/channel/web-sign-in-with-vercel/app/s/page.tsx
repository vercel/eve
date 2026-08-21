import { headers } from "next/headers";
import { AgentChat } from "@/app/_components/agent-chat";
import { AccountControl, SignIn } from "@/app/_components/web-chat-auth";
import { auth } from "@/lib/auth";

export default async function NewSessionPage() {
  if (process.env.NODE_ENV === "development") {
    return <AgentChat sessionless />;
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return <SignIn />;
  }

  return (
    <>
      <AgentChat sessionless />
      <AccountControl
        email={session.user.email}
        image={session.user.image}
        name={session.user.name}
      />
    </>
  );
}
