"use client";

import { ThemeProvider as NextThemeProvider } from "next-themes";
import type { ReactNode } from "react";

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      storageKey="evey-theme"
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}
