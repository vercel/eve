import { useSyncedRef } from "phase/react";
import { useEffect, useState } from "react";

// Owns browser theme subscriptions for the Eve hero.
// INVARIANT: resolution order matches the old index.tsx hooks exactly.
// Imported only by index.tsx.

export function getCurrentTheme(prefersDarkTheme: boolean): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  const root = document.documentElement;
  if (root.classList.contains("dark") || root.dataset.theme === "dark") return "dark";
  if (root.classList.contains("light") || root.dataset.theme === "light") return "light";
  return prefersDarkTheme ? "dark" : "light";
}

export function useResolvedTheme(prefersDarkTheme: boolean) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const prefersDarkThemeRef = useSyncedRef(prefersDarkTheme);

  useEffect(() => {
    const syncTheme = () => setTheme(getCurrentTheme(prefersDarkThemeRef.current));
    const observer = new MutationObserver(syncTheme);

    syncTheme();
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    setTheme(getCurrentTheme(prefersDarkTheme));
  }, [prefersDarkTheme]);

  return theme;
}
