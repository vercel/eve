import type { Metadata } from "next";
import { Suspense } from "react";

import { AgentChat } from "@/app/_components/agent-chat";

export const metadata: Metadata = {
  title: "Chat",
};

export default function SessionPage(props: PageProps<"/s/[sessionId]">) {
  return (
    <Suspense fallback={null}>
      <SessionChat params={props.params} />
    </Suspense>
  );
}

/** The session id is only known per request, so the chat mounts inside Suspense. */
async function SessionChat({ params }: { readonly params: PageProps<"/s/[sessionId]">["params"] }) {
  const { sessionId } = await params;
  return <AgentChat key={sessionId} sessionId={sessionId} />;
}
