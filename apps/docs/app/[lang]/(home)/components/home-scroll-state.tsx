"use client";

import { useEffect } from "react";

export function HomeScrollState() {
  useEffect(() => {
    const sync = () => {
      document.body.dataset.homeScrolled = window.scrollY > 0 ? "true" : "false";
    };

    sync();
    window.addEventListener("scroll", sync, { passive: true });

    return () => {
      window.removeEventListener("scroll", sync);
      delete document.body.dataset.homeScrolled;
    };
  }, []);

  return null;
}
