const E164_PHONE_NUMBER = /^\+[1-9]\d{7,14}$/;
const PHONE_NUMBER_INPUT = /^\+?[\d\s().-]+$/;

export function isE164PhoneNumber(value: string) {
  return E164_PHONE_NUMBER.test(value);
}

export function formatPhoneNumber(phoneNumber: string) {
  return phoneNumber.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 ($1) $2-$3");
}

export function normalizeAuthPhoneNumber(value: string) {
  const trimmedValue = value.trim();
  if (!PHONE_NUMBER_INPUT.test(trimmedValue)) return undefined;

  const digits = trimmedValue.replace(/\D/g, "");
  const normalizedValue = trimmedValue.startsWith("+")
    ? `+${digits}`
    : digits.length === 11 && digits.startsWith("1")
      ? `+${digits}`
      : `+1${digits}`;

  return isE164PhoneNumber(normalizedValue) ? normalizedValue : undefined;
}

/** Error code the sign-in form shows when a number has requested too many codes. */
export const PHONE_CODE_RATE_LIMITED = "PHONE_CODE_RATE_LIMITED";

/** Linq requires an inbound text before it can deliver the sign-in code. */
export const LINQ_RECIPIENT_NOT_VERIFIED = "LINQ_RECIPIENT_NOT_VERIFIED";
