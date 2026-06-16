"use client";

import { signIn, signOut } from "@/lib/auth-client";
import { authProvidersList, type AuthProviderId } from "@/lib/auth-providers";
import { useEffect, useRef, useState, useTransition } from "react";

const buttonClass =
  "rounded-md border border-neutral-200 px-3 py-1.5 font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-800 dark:hover:bg-neutral-900";
const menuItemClass =
  "block w-full px-3 py-2 text-left hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-900";

export function SignInButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  const handleSignIn = (providerId: AuthProviderId) => {
    setIsOpen(false);
    startTransition(async () => {
      const currentPath = window.location.pathname + window.location.search;
      await signIn(providerId, { returnTo: currentPath });
    });
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className={`${buttonClass} inline-flex items-center gap-2`}
        disabled={isPending}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span>{isPending ? "Signing in..." : "Sign in"}</span>
        <span
          aria-hidden
          className="mt-[-2px] size-1.5 rotate-45 border-b border-r border-current"
        />
      </button>
      {isOpen ? (
        <div
          className="absolute right-0 z-10 mt-2 min-w-36 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
          role="menu"
        >
          {authProvidersList.map((provider) => (
            <button
              className={menuItemClass}
              disabled={isPending}
              key={provider.id}
              onClick={() => handleSignIn(provider.id)}
              role="menuitem"
              type="button"
            >
              {provider.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SignOutButton() {
  const [isPending, startTransition] = useTransition();

  const handleSignOut = () => {
    startTransition(async () => {
      const currentPath = window.location.pathname + window.location.search;
      await signOut({ returnTo: currentPath });
    });
  };

  return (
    <button className={buttonClass} disabled={isPending} onClick={handleSignOut} type="button">
      {isPending ? "Signing out..." : "Sign out"}
    </button>
  );
}
