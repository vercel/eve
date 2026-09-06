export function assistantHasReport(
  messages: readonly { role: string; text: string }[],
  reference: string,
): boolean {
  if (reference.length === 0) return false;

  const escapedReference = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const recordReference = new RegExp(`(?<![\\w/-])${escapedReference}(?![\\w/-])`);

  // Only successful tool results introduce these references. Requiring their
  // retention in assistant text proves they survived a checkpoint or trail.
  return messages.some(
    (message) => message.role === "assistant" && recordReference.test(message.text),
  );
}
