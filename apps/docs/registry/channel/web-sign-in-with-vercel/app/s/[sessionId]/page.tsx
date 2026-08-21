import { headers } from "next/headers";
import { AgentChat } from "@/app/_components/agent-chat";
import { AccountControl, SignIn } from "@/app/_components/web-chat-auth";
import { auth } from "@/lib/auth";

export default async function SessionPage({
  params,
}: {
  readonly params: Promise<{ readonly sessionId: string }>;
}) {
  const { sessionId } = await params;
  if (process.env.NODE_ENV === "development") {
    return <AgentChat sessionId={sessionId} />;
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return <SignIn />;
  }

  return (
    <>
      <AgentChat sessionId={sessionId} />
      <AccountControl
        email={session.user.email}
        image={session.user.image}
        name={session.user.name}
      />
    </>
  );
}
