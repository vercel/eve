import { z } from "zod";

export const phoneLinkQuerySchema = z.object({
  phoneNumber: z.coerce.string().trim().min(1, "phoneNumber is required"),
});
