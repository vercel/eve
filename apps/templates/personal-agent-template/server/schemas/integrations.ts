import { z } from "zod";

export const connectorIdParamsSchema = z.object({
  id: z.string().trim().min(1, "Connector id is required"),
});

export const connectQuerySchema = z.object({
  resumeUrl: z.preprocess(
    (value) => (Array.isArray(value) ? value[0] : value),
    z.string().trim().min(1).optional(),
  ),
});
