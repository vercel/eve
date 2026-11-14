const E164_PHONE_NUMBER = /^\+[1-9]\d{7,14}$/;
const PHONE_NUMBER_INPUT = /^\+?[\d\s().-]+$/;

export function isE164PhoneNumber(value: string) {
  return E164_PHONE_NUMBER.test(value);
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
