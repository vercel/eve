import { z } from "zod";
import { authClient } from "@web/auth/client";

const formValueSchema = z.string().catch("");

export function formValue(form: HTMLFormElement, name: string) {
  return formValueSchema.parse(new FormData(form).get(name));
}

export async function verifyPhoneNumber({
  code,
  errorMessage,
  phoneNumber,
}: {
  readonly code: string;
  readonly errorMessage: string;
  readonly phoneNumber: string;
}) {
  const verified = await authClient.phoneNumber
    .verify({
      code,
      disableSession: false,
      phoneNumber,
      updatePhoneNumber: false,
    })
    .catch(() => {
      throw new Error(errorMessage);
    });
  if (verified.error) throw new Error(errorMessage);
}
