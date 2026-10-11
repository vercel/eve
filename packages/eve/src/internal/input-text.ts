export const inputTextKey = "__eveInputText";

type InputTextCarrier = {
  [inputTextKey]?: string;
};

/**
 * Attaches the text a person typed, for channels whose model-visible message
 * wraps it in an envelope. Pending input requests resolve against this text, so
 * a typed `approve` or option label still answers them.
 */
export function attachInputText<T extends object>(target: T, text: string | undefined): T {
  if (text !== undefined) {
    (target as T & InputTextCarrier)[inputTextKey] = text;
  }
  return target;
}

export function readInputText(target: object | undefined): string | undefined {
  return (target as InputTextCarrier | undefined)?.[inputTextKey];
}

/** The text pending input resolves against: the typed text, else a plain string message. */
export function readAnswerText(
  target: (object & { readonly message?: unknown }) | undefined,
): string | undefined {
  if (typeof target?.message !== "string") return undefined;
  return readInputText(target) ?? target.message;
}
