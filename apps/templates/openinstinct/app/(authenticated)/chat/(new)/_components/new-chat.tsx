"use client";

import { useEveAgent } from "eve/react";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@web/components/ai-elements/prompt-input";
import { chatTitle, messageContent } from "../../_lib/message-input";
import { api } from "@web/trpc/client";

export function NewChat() {
  const router = useRouter();
  const { mutateAsync: saveChat } = api.chats.save.useMutation();
  const pendingTitle = useRef<string | undefined>(undefined);
  const isSubmitting = useRef(false);
  const navigationStarted = useRef(false);
  const agent = useEveAgent({
    onSessionChange(session) {
      if (session === undefined || navigationStarted.current) return;
      navigationStarted.current = true;
      const path = `/chat/${encodeURIComponent(session.sessionId)}`;
      void saveChat({
        sessionId: session.sessionId,
        title: pendingTitle.current,
      })
        .catch(() => undefined)
        .then(() => {
          router.replace(path);
          return undefined;
        });
      pendingTitle.current = undefined;
    },
  });

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (
      (text.length === 0 && message.files.length === 0) ||
      isSubmitting.current
    ) {
      return;
    }
    isSubmitting.current = true;
    pendingTitle.current = chatTitle(message);
    try {
      await agent.send(messageContent(message));
    } finally {
      isSubmitting.current = false;
    }
  };

  return (
    <PromptInput compact onSubmit={handleSubmit}>
      <PromptInputBody>
        <PromptInputTextarea
          className="min-h-0"
          placeholder="Send a message…"
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools />
        <PromptInputSubmit />
      </PromptInputFooter>
    </PromptInput>
  );
}
