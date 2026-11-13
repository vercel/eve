import { z } from "zod";
import { publicUrl } from "../parallel";

export interface Owner { issuer: string; id: string }
export interface Destination { chat: string; sender: string; line: string }
export const queryInput = z.string().trim().min(1).max(2_000);
const phone = z.string().regex(/^\+[1-9]\d{1,14}$/);
export const destinationSchema = z.object({ chat: z.string().min(1).max(256), sender: phone, line: phone });
export function allowed(destination: Destination): boolean {
  const line = phone.safeParse(process.env.BELL_LINQ_PHONE_NUMBER?.trim());
  const senders = z.array(phone).nonempty().safeParse((process.env.BELL_LINQ_ALLOWED_SENDERS ?? "").split(",").map(s => s.trim()));
  return line.success && senders.success && line.data === destination.line && senders.data.includes(destination.sender);
}
export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Watches unavailable: configure ${name}.`);
  return value;
}
export function creationOrigin(): string {
  for (const name of ["DATABASE_URL", "PARALLEL_API_KEY", "PARALLEL_WEBHOOK_SECRET", "CRON_SECRET", "LINQ_API_KEY"]) required(name);
  const origin = required("BELL_PUBLIC_URL"), url = new URL(origin);
  if (!publicUrl.safeParse(origin).success || url.protocol !== "https:" || url.origin !== origin || !url.hostname.includes(".") || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new Error("Watches require a public HTTPS BELL_PUBLIC_URL origin.");
  return origin;
}
export function assertOwner(owner: Owner): void {
  if (owner.issuer !== "linq" || !/^linq:.{1,507}$/.test(owner.id)) throw new Error("Watches require an authenticated Linq sender.");
}

export const frequencyInput = z.string().regex(/^[1-9]\d{0,2}[hdw]$/, "Use whole hours, days, or weeks, between 1h and 30d.").refine(value => {
  const hours = Number(value.slice(0, -1)) * ({ h: 1, d: 24, w: 168 }[value.slice(-1)] ?? 0);
  return hours >= 1 && hours <= 720;
}, "Frequency must be between 1h and 30d.").transform(value => {
  const hours = Number(value.slice(0, -1)) * ({ h: 1, d: 24, w: 168 }[value.slice(-1)]!);
  return hours % 168 === 0 ? `${hours / 168}w` : hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
});

export const monitorTimestamp = z.string().datetime({ offset: true }).transform(value => {
  // Preserve sub-millisecond precision while giving equivalent instants one recovery identity.
  const fraction = (value.match(/\.(\d+)/)?.[1] ?? "").replace(/0+$/, "");
  const seconds = new Date(value.replace(/\.\d+/, "")).toISOString().slice(0, 19);
  return `${seconds}${fraction ? `.${fraction}` : ""}Z`;
});
