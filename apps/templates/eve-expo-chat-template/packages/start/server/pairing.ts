import { randomInt } from "node:crypto";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const pairingLifetimeMs = 60000;
export const pairingRotationMs = 30000;
export function pairingCode() {
  const raw = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return raw.slice(0, 4) + "-" + raw.slice(4);
}
export function normalizePairingToken(value: string) {
  const compact = value.trim().toUpperCase().replace(/[\s-]/g, "");
  if (/^[A-Z0-9]{8}$/.test(compact) || /^EVE[A-HJ-NP-Z2-9]{12}$/.test(compact)) return compact;
  return value.trim();
}
