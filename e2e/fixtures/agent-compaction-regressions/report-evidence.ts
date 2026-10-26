export function assistantHasReport(
  messages: readonly { role: string; text: string }[],
  reference: string,
): boolean {
  if (reference.length === 0) return false;

  const escapedReference = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const recordReference = new RegExp(`(?<![\\w/-])${escapedReference}(?![\\w/-])`);

  // Only successful tool results introduce these references. Their presence in
  // what the model is shown (a surviving tool result, or assistant text after a
  // checkpoint or trail) proves they survived compaction.
  return messages.some(
    (message) =>
      (message.role === "assistant" || message.role === "tool") &&
      recordReference.test(message.text),
  );
}
