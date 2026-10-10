import { createFileRoute } from "@tanstack/react-router";
import { AgentChat } from "@/app/_components/agent-chat";

export const Route = createFileRoute("/")({
  component: () => <AgentChat />,
});
