"use client";

import { useEffect } from "react";

/**
 * Tracks whether the page is scrolled and reflects it as `data-scrolled` on
 * <html>, so CSS can fade the home navbar border in only after scrolling.
 */
export function ScrollState() {
  useEffect(() => {
    const update = () => {
      document.documentElement.toggleAttribute("data-scrolled", window.scrollY > 4);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return null;
}
