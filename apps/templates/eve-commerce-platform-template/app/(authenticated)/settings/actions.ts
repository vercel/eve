"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { selectGatewayModel } from "@/lib/shoppers/model";
import { requireRequestScope } from "@/lib/auth/next";

export async function updateGatewayModel(modelId: string) {
  const scope = await requireRequestScope();
  const selected = z.string().trim().min(1).max(300).parse(modelId);
  await selectGatewayModel(scope, selected);
  revalidatePath("/settings");
}
