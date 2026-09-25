import { AuthenticatedAgentChat } from "@/app/_components/authenticated-agent-chat";

export default async function SessionPage({
  params,
}: {
  readonly params: Promise<{ readonly sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <AuthenticatedAgentChat sessionId={sessionId} />;
}
