import type { PromptOption, PromptValue } from "./prompt-ui.js";

export interface SelectOptionCodec<T extends PromptValue> {
  readonly options: PromptOption<string>[];
  encode(value: T): string;
  decode(key: string): T;
}

/**
 * Gives prompt options opaque transport keys while preserving their typed
 * values. Primitive stringification is not injective (`1` and `"1"` collide),
 * so renderer-facing keys must not be derived from option values.
 */
export function createSelectOptionCodec<T extends PromptValue>(
  options: readonly PromptOption<T>[],
): SelectOptionCodec<T> {
  const valuesByKey = new Map<string, T>();
  const keysByValue = new Map<T, string>();
  const encoded = options.map((option, index) => {
    if (keysByValue.has(option.value)) {
      throw new Error(`Select option values must be unique; duplicate at index ${index}.`);
    }

    const key = `option-${index}`;
    keysByValue.set(option.value, key);
    valuesByKey.set(key, option.value);
    return { ...option, value: key };
  });

  return {
    options: encoded,
    encode(value) {
      const key = keysByValue.get(value);
      if (key === undefined) {
        throw new Error("Select initial value does not match an option.");
      }
      return key;
    },
    decode(key) {
      const value = valuesByKey.get(key);
      if (value === undefined) {
        throw new Error(`Select returned an unknown option key: ${key}`);
      }
      return value;
    },
  };
}
