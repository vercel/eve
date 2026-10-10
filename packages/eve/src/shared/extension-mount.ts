import { z } from "#compiled/zod/index.js";

export const mountIdSchema = z.string().min(1);
