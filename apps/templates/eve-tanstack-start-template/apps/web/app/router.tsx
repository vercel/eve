import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

/**
 * Creates the app router. TanStack Start calls this once per request on the
 * server and once in the browser.
 *
 * @returns The router.
 */
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
  });
}

/**
 * Fallback for unknown routes.
 *
 * @returns The not-found page.
 */
function NotFound() {
  return (
    <main className="text-muted-foreground flex min-h-dvh items-center justify-center text-sm">
      Page not found.
    </main>
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
