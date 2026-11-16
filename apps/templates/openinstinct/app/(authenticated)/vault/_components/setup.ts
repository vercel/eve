"use client";

import { useSearchParams } from "next/navigation";
import { parseVaultSetupSearchParams } from "@shared/vault/schema";

export function useVaultSetup() {
  const searchParams = useSearchParams();
  const requestedSetup = parseVaultSetupSearchParams(
    Object.fromEntries(searchParams.entries())
  );
  return requestedSetup.success ? requestedSetup.data : undefined;
}
