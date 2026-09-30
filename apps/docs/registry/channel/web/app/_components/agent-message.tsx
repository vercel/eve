"use client";

import type { EveMessage, EveMessagePart } from "eve/react";
import { ExternalLinkIcon, FileIcon, ImageIcon } from "lucide-react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Activity } from "./activity";
import { messageBlocks, type ViewContext } from "./conversation-view";
import { type AgentInputResponse, RequestGroup } from "./input-request";

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

export function UserMessage({ message }: { readonly message: EveMessage }) {
  return (
    <Message data-optimistic={message.metadata?.optimistic ? "true" : undefined} from="user">
      <MessageContent>
        {message.parts.map((part, index) =>
          part.type === "text" ? (
            <MessageResponse key={`text:${part.id ?? index}`}>{part.text}</MessageResponse>
          ) : part.type === "file" ? (
            <AttachmentPart key={`file:${index}`} part={part} />
          ) : null,
        )}
      </MessageContent>
    </Message>
  );
}

/**
 * One assistant turn: its prose in order, the work between each stretch folded, and anything
 * waiting on the person where it arrived.
 */
export function AssistantMessage({
  canRespond,
  context,
  isStreaming,
  message,
  onRespond,
}: {
  readonly canRespond: boolean;
  readonly context: ViewContext;
  readonly isStreaming: boolean;
  readonly message: EveMessage;
  readonly onRespond: (response: AgentInputResponse) => Promise<void>;
}) {
  const blocks = messageBlocks(message, context);
  const lastText = blocks.findLast((block) => block.kind === "text")?.key;
  const turnId = message.metadata?.turnId;
  const cancelled =
    turnId !== undefined && context.conversation.turns[turnId]?.status === "cancelled";

  return (
    <Message from="assistant">
      <MessageContent className="gap-3">
        {blocks.map((block) =>
          block.kind === "text" ? (
            <MessageResponse
              caret="block"
              isAnimating={isStreaming && block.streaming && block.key === lastText}
              key={block.key}
            >
              {block.text}
            </MessageResponse>
          ) : block.kind === "activity" ? (
            <Activity items={block.items} key={block.key} />
          ) : (
            <RequestGroup
              canRespond={canRespond}
              key={block.key}
              onRespond={onRespond}
              requests={block.requests}
            />
          ),
        )}
        {cancelled ? <p className="text-muted-foreground text-sm">Cancelled</p> : null}
      </MessageContent>
    </Message>
  );
}

function AttachmentPart({ part }: { readonly part: EveFilePart }) {
  const label = part.filename ?? "Attachment";
  const detail = [part.mediaType, formatBytes(part.size)].filter(Boolean).join(" - ");
  const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
  const Icon = isImage ? ImageIcon : FileIcon;
  const body = (
    <span className="flex max-w-sm items-center gap-3 rounded-md border bg-background/60 p-2 text-sm">
      {isImage ? (
        <img alt={label} className="size-12 shrink-0 rounded-sm object-cover" src={part.url} />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail ? <span className="block truncate text-muted-foreground">{detail}</span> : null}
      </span>
      {part.url ? <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" /> : null}
    </span>
  );

  return part.url ? (
    <a href={part.url} rel="noreferrer" target="_blank">
      {body}
    </a>
  ) : (
    body
  );
}

function formatBytes(size: number | undefined): string | undefined {
  if (size === undefined) return undefined;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
