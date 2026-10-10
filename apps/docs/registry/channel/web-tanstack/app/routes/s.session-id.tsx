import { createFileRoute } from "@tanstack/react-router";
import { AgentChat } from "@/app/_components/agent-chat";

export const Route = createFileRoute("/s/$sessionId")({
  component: SessionPage,
});

function SessionPage() {
  const { sessionId } = Route.useParams();
  return <AgentChat sessionId={sessionId} />;
}
