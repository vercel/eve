import { readRequestSession } from "@/lib/auth/next";
import { AuthenticatedSidebar } from "./_components/sidebar";

export default async function AuthenticatedLayout({ children }: LayoutProps<"/">) {
  const session = await readRequestSession();
  // Each page redirects to sign-in with its own return location.
  if (!session) return children;

  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:p-3 focus:ring-2 focus:ring-ring"
        href="#main-content"
      >
        Skip to content
      </a>
      <AuthenticatedSidebar phoneNumber={session.user.phoneNumber} />
      <main className="flex min-w-0 flex-1 flex-col outline-none" id="main-content" tabIndex={-1}>
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-8">{children}</div>
      </main>
    </div>
  );
}
