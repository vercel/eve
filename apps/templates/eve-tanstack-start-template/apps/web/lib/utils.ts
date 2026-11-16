import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names, resolving conflicting Tailwind classes in favor of the last one.
 *
 * @param inputs - Class names, arrays, or conditional class maps.
 * @returns The merged class string.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
