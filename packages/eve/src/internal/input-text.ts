export const inputTextKey = "__eveInputText";

type InputTextCarrier = {
  [inputTextKey]?: string;
};

export function attachInputText<T extends object>(target: T, text: string | undefined): T {
  if (text !== undefined) {
    (target as T & InputTextCarrier)[inputTextKey] = text;
  }
  return target;
}

export function readInputText(target: object | undefined): string | undefined {
  return (target as InputTextCarrier | undefined)?.[inputTextKey];
}

export function readAnswerText(
  target: (object & { readonly message?: unknown }) | undefined,
): string | undefined {
  if (typeof target?.message !== "string") return undefined;
  return readInputText(target) ?? target.message;
}
