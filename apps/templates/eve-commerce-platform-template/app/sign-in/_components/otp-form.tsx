"use client";

import { useActionState, useState, useTransition, type SubmitEvent } from "react";
import { authClient } from "@/lib/auth/client";
import { formValue, verifyPhoneNumber } from "@/app/sign-in/_lib/phone-auth";
import {
  formatPhoneNumber,
  isE164PhoneNumber,
  LINQ_RECIPIENT_NOT_VERIFIED,
  normalizeAuthPhoneNumber,
  PHONE_CODE_RATE_LIMITED,
} from "@/lib/auth/phone-number";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "./phone-field";
import { formatPhoneInput } from "../_lib/phone-input";

type SendOtpError =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "text-first"; readonly linqPhoneNumber?: string };

export function PhoneOtpAuthForm({ callbackUrl }: { readonly callbackUrl: string }) {
  const [phone, setPhone] = useState<string>();
  const [error, sendOtp, sending] = useActionState(
    async (_previous: SendOtpError | null, form: FormData): Promise<SendOtpError | null> => {
      const phoneNumber = normalizeAuthPhoneNumber(String(form.get("phone-number") ?? ""));
      if (!phoneNumber) return { kind: "error", message: "Enter a valid phone number." };
      try {
        const result = await authClient.phoneNumber.sendOtp({ phoneNumber });
        if (result.error) return phoneOtpError(result.error);
      } catch {
        return phoneOtpError({});
      }
      setPhone(phoneNumber);
      return null;
    },
    null,
  );

  if (phone) {
    return (
      <VerificationCodeForm
        callbackUrl={callbackUrl}
        onUseDifferentNumber={() => setPhone(undefined)}
        phoneNumber={phone}
      />
    );
  }

  return (
    <form action={sendOtp} className="space-y-4">
      <p className="type-supporting-body text-muted-foreground">
        Enter your phone number. We’ll text you a code to sign in.
      </p>
      <FieldGroup>
        <PhoneNumberField />
        <FieldError>
          {error?.kind === "text-first" ? (
            <TextFirstInstructions phoneNumber={error.linqPhoneNumber} />
          ) : (
            error?.message
          )}
        </FieldError>
        <Button className="h-10 w-full" disabled={sending} type="submit">
          {sending ? "Sending…" : "Send code"}
        </Button>
      </FieldGroup>
    </form>
  );
}

function TextFirstInstructions({ phoneNumber }: { readonly phoneNumber?: string }) {
  if (!phoneNumber) return "Couldn’t load the number to text. Try again.";

  return (
    <>
      Text “Hi” to{" "}
      <a className="font-medium underline underline-offset-4" href={`sms:${phoneNumber}`}>
        {formatPhoneNumber(phoneNumber)}
      </a>
      , then select <strong>Send code</strong> again.
    </>
  );
}

function VerificationCodeForm({
  callbackUrl,
  onUseDifferentNumber,
  phoneNumber,
}: {
  readonly callbackUrl: string;
  readonly onUseDifferentNumber: () => void;
  readonly phoneNumber: string;
}) {
  const [error, setError] = useState<string>();
  const [verifying, startVerification] = useTransition();

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (verifying) return;
    const code = formValue(event.currentTarget, "code").trim();
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the six-digit code.");
      return;
    }
    setError(undefined);
    startVerification(async () => {
      const errorMessage = "That code could not be verified. Request a new code and try again.";
      try {
        await verifyPhoneNumber({ code, errorMessage, phoneNumber });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : errorMessage);
        return;
      }
      window.location.replace(callbackUrl);
    });
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="type-supporting-body text-muted-foreground" id="code-description">
        Enter the six-digit code sent to {formatPhoneInput(phoneNumber)}.
      </p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="code">Verification code</FieldLabel>
          <Input
            aria-describedby="code-description"
            autoComplete="one-time-code"
            className="h-10"
            id="code"
            inputMode="numeric"
            maxLength={6}
            name="code"
            pattern="[0-9]{6}"
            required
          />
        </Field>
        <FieldError>{error}</FieldError>
        <Button className="h-10 w-full" disabled={verifying} type="submit">
          {verifying ? "Verifying…" : "Verify code"}
        </Button>
        <Button
          className="w-full"
          disabled={verifying}
          onClick={onUseDifferentNumber}
          type="button"
          variant="ghost"
        >
          Use a different number
        </Button>
      </FieldGroup>
    </form>
  );
}

function phoneOtpError(error: {
  readonly code?: string;
  readonly linqPhoneNumber?: unknown;
  readonly message?: string;
}): SendOtpError {
  if (error.code === LINQ_RECIPIENT_NOT_VERIFIED) {
    const number = error.linqPhoneNumber;
    return {
      kind: "text-first",
      linqPhoneNumber: typeof number === "string" && isE164PhoneNumber(number) ? number : undefined,
    };
  }
  return {
    kind: "error",
    message:
      (error.code?.startsWith("LINQ_") || error.code === PHONE_CODE_RATE_LIMITED) && error.message
        ? error.message
        : "Unable to send a code. Please try again.",
  };
}
