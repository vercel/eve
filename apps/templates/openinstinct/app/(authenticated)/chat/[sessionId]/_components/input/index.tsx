import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@web/components/ai-elements/prompt-input";
import { messageContent } from "../../../_lib/message-input";
import { api } from "@web/trpc/client";
import type { ChatAgent } from "../chat-agent";

export function ChatInput({
  agent,
  sessionId,
}: {
  readonly agent: Pick<ChatAgent, "cancel" | "messages" | "send" | "status">;
  readonly sessionId?: string;
}) {
  const { mutate: saveChat } = api.chats.save.useMutation();
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isRestoring =
    agent.status === "resuming" && agent.messages.length === 0;
  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (
      (text.length === 0 && message.files.length === 0) ||
      agent.status === "submitted" ||
      isRestoring
    ) {
      return;
    }

    if (sessionId !== undefined) saveChat({ sessionId });
    await agent.send(
      messageContent(message),
      isBusy ? { turnPolicy: "steer" } : undefined
    );
  };

  return (
    <div className="absolute bottom-0 left-1/2 z-20 mx-auto w-full max-w-3xl -translate-x-1/2 bg-linear-to-t from-background via-background to-transparent px-4 pt-4 pb-6 sm:px-6">
      <PromptInput compact onSubmit={handleSubmit}>
        <PromptInputBody>
          <PromptInputTextarea
            className="min-h-0"
            disabled={agent.status === "submitted"}
            placeholder="Send a message…"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools />
          <PromptInputSubmit
            disabled={isRestoring}
            onStop={() => void agent.cancel()}
            status={isBusy ? agent.status : undefined}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
