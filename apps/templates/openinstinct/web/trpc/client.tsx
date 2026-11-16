"use client";

import { useQueryClient } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { useState, type ReactNode } from "react";
import type { AppRouter } from "./router";

export const api = createTRPCReact<AppRouter>();

export function TRPCProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const [trpcClient] = useState(() =>
    api.createClient({
      links: [httpBatchLink({ url: "/api/trpc" })],
    })
  );

  return (
    <api.Provider client={trpcClient} queryClient={queryClient}>
      {children}
    </api.Provider>
  );
}
