import { AgentChat } from "@/app/_components/agent-chat";

export default async function SessionPage({
  params,
}: {
  readonly params: Promise<{ readonly sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <AgentChat sessionId={sessionId} />;
}
