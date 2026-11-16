import { ChatSession } from "./_components/chat-session";
import { readChat } from "@db/services/chats";
import { requireRequestScope } from "@web/auth/request-scope";

export default async function ChatSessionPage({
  params,
}: PageProps<"/chat/[sessionId]">) {
  const { sessionId } = await params;
  const scope = await requireRequestScope();
  const chat = await readChat(scope, sessionId);
  return (
    <ChatSession
      initialUsage={chat?.usage}
      key={sessionId}
      sessionId={sessionId}
    />
  );
}
