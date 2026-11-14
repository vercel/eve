import { z } from "zod";

export const databaseUrlSchema = z
  .string()
  .min(1, "Required")
  .refine(
    (value) =>
      value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "Must be a postgres:// or postgresql:// URL"
  );
