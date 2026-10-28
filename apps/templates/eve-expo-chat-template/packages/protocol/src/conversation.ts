export type ChatMessage = { id: string; [key: string]: unknown };
export function compareChatMessages(a: ChatMessage, b: ChatMessage) {
  return (
    Number(a.createdAt) - Number(b.createdAt) ||
    Number(a.role !== "user") - Number(b.role !== "user") ||
    a.id.localeCompare(b.id)
  );
}
export type Conversation<M extends ChatMessage = ChatMessage> = {
  asOf: number;
  messages: M[];
  streams: M[];
  model?: string | null;
  activeResponse?: string | null;
};
export type ConversationPatch<M extends ChatMessage = ChatMessage> = Conversation<M> & {
  removedMessages: string[];
  removedStreams: string[];
};
export function conversationPatch<M extends ChatMessage>(
  before: Conversation<M>,
  after: Conversation<M>,
): ConversationPatch<M> {
  const changed = (old: M[], next: M[]) => {
    const known = new Map(old.map((item) => [item.id, JSON.stringify(item)]));
    return next.filter((item) => known.get(item.id) !== JSON.stringify(item));
  };
  const removed = (old: M[], next: M[]) => {
    const ids = new Set(next.map((item) => item.id));
    return old.filter((item) => !ids.has(item.id)).map((item) => item.id);
  };
  const patch: ConversationPatch<M> = {
    asOf: after.asOf,
    messages: changed(before.messages, after.messages),
    streams: changed(before.streams, after.streams),
    removedMessages: removed(before.messages, after.messages),
    removedStreams: removed(before.streams, after.streams),
  };
  // An absent key means "unchanged"; an explicit null clears it.
  if ("model" in after) patch.model = after.model;
  if ("activeResponse" in after) patch.activeResponse = after.activeResponse;
  return patch;
}
export function applyConversationPatch<M extends ChatMessage>(
  before: Conversation<M>,
  patch: ConversationPatch<M>,
): Conversation<M> {
  const merge = (old: M[], next: M[], removed: string[]) => {
    const items = new Map(old.map((item) => [item.id, item]));
    for (const id of removed) items.delete(id);
    for (const item of next) items.set(item.id, item);
    return [...items.values()].sort(compareChatMessages);
  };
  const next: Conversation<M> = {
    asOf: patch.asOf,
    messages: merge(before.messages, patch.messages, patch.removedMessages),
    streams: merge(before.streams, patch.streams, patch.removedStreams),
  };
  if ("model" in patch) next.model = patch.model;
  if ("activeResponse" in patch) next.activeResponse = patch.activeResponse;
  return next;
}

export function toolLabel(name: string) {
  const labels: Record<string, string> = {
    navigate: "Opening page",
    tabs: "Managing tabs",
    snapshot: "Inspecting page",
    read: "Reading page",
    get: "Reading page details",
    find: "Finding an element",
    click: "Clicking",
    fill: "Filling a field",
    press_key: "Using keyboard",
    hover: "Moving pointer",
    select_option: "Selecting an option",
    set_checked: "Setting a checkbox",
    scroll: "Scrolling",
    drag: "Dragging",
    upload: "Uploading a file",
    wait_for: "Waiting for page",
    screenshot: "Taking a screenshot",
    evaluate: "Running page script",
    console: "Checking page errors",
    network_requests: "Inspecting requests",
    close: "Closing browser",
    notify: "Sending notification",
  };
  return labels[name.split("__").at(-1)!] || name.replaceAll("__", " · ").replaceAll("_", " ");
}
// Offsets retain narration/tool ordering without mixing activity into assistant text.
export function messageSegments(message: {
  text: string;
  tools?: { id: string; name: string; status: string; offset: number }[];
}) {
  const result: (
    | { type: "text"; text: string }
    | { type: "tool"; id: string; name: string; status: string }
  )[] = [];
  let offset = 0;
  for (const tool of message.tools || []) {
    const next = Math.max(offset, Math.min(message.text.length, tool.offset));
    if (next > offset) result.push({ type: "text", text: message.text.slice(offset, next) });
    result.push({ type: "tool", id: tool.id, name: tool.name, status: tool.status });
    offset = next;
  }
  if (offset < message.text.length) result.push({ type: "text", text: message.text.slice(offset) });
  return result;
}
