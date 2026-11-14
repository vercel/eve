import type { Metadata } from "next";

import { AgentChat } from "@/app/_components/agent-chat";

export const metadata: Metadata = {
  title: "New chat",
};

export default function NewChatPage() {
  return <AgentChat sessionless />;
}
