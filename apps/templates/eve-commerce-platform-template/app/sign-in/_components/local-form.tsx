"use client";

import { useActionState } from "react";
import { verifyPhoneNumber } from "@/app/sign-in/_lib/phone-auth";
import { normalizeAuthPhoneNumber } from "@/lib/auth/phone-number";
import { Button } from "@/components/ui/button";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { PhoneNumberField } from "./phone-field";

export function LocalPhoneAuthForm({ callbackUrl }: { readonly callbackUrl: string }) {
  const [error, signIn, pending] = useActionState(
    async (_previous: string | null, form: FormData) => {
      const phoneNumber = normalizeAuthPhoneNumber(String(form.get("phone-number") ?? ""));
      if (!phoneNumber) return "Enter a valid phone number.";
      try {
        await verifyPhoneNumber({
          code: "000000",
          errorMessage: "Unable to sign in locally. Please try again.",
          phoneNumber,
        });
      } catch {
        return "Unable to sign in locally. Please try again.";
      }
      window.location.replace(callbackUrl);
      return null;
    },
    null,
  );

  return (
    <form action={signIn} className="space-y-4">
      <p className="type-supporting-body text-muted-foreground">
        Enter your phone number to sign in locally. No text is sent.
      </p>
      <FieldGroup>
        <PhoneNumberField />
        <FieldError>{error}</FieldError>
        <Button className="h-10 w-full" disabled={pending} size="lg" type="submit">
          {pending ? "Signing in…" : "Continue"}
        </Button>
      </FieldGroup>
    </form>
  );
}
