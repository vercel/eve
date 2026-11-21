import { AsYouType } from "libphonenumber-js/min";

export function formatPhoneInput(value: string) {
  const trimmed = value.trim();
  // Leave invalid input visible so the existing submission validation can explain it.
  if (!/^\+?[\d\s().-]*$/.test(trimmed)) return value;
  return new AsYouType("US").input(trimmed);
}

export function phoneInputCaret(raw: string, formatted: string, position: number) {
  if (raw === formatted) return position;
  if (position >= raw.length) return formatted.length;

  const beforeCaret = raw.slice(0, position).replace(/[^\d+]/g, "").length;
  if (beforeCaret === 0) return 0;

  let seen = 0;
  for (let index = 0; index < formatted.length; index++) {
    if (/[\d+]/.test(formatted.charAt(index))) seen++;
    if (seen === beforeCaret) return index + 1;
  }
  return formatted.length;
}
