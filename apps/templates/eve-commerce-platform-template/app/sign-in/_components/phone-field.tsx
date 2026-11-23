"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { formatPhoneInput, phoneInputCaret } from "../_lib/phone-input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function PhoneNumberField() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  return (
    <Field>
      <FieldLabel htmlFor="phone-number">Phone number</FieldLabel>
      <Input
        autoComplete="tel"
        className="h-10"
        id="phone-number"
        inputMode="tel"
        name="phone-number"
        onBlur={() => {
          setValue(formatPhoneInput(value));
        }}
        onChange={(event) => {
          const input = event.currentTarget;
          const raw = input.value;
          const nativeEvent = event.nativeEvent;
          const deleting =
            nativeEvent instanceof InputEvent && nativeEvent.inputType.startsWith("delete");
          // Let backspace remove separators rather than immediately putting them back.
          const formatted = deleting ? raw : formatPhoneInput(raw);
          pendingCaret.current = phoneInputCaret(
            raw,
            formatted,
            input.selectionStart ?? raw.length,
          );
          setValue(formatted);
        }}
        placeholder="(202) 555-0123"
        ref={inputRef}
        required
        size="xl"
        type="tel"
        value={value}
      />
    </Field>
  );
}
