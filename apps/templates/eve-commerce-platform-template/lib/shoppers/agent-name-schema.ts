import { z } from "zod";

export const defaultAgentName = "evey";

export const agentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}\p{M} .’'-]*$/u);
