import type { Metadata } from "next";
import "./global.css";

export const metadata: Metadata = {
  title: "Page not found - eve",
  description: "The requested eve documentation page does not exist.",
};

const GlobalNotFound = () => (
  <html lang="en">
    <body className="flex min-h-screen items-center justify-center bg-background-100 px-6 text-gray-1000">
      <main className="max-w-md text-center">
        <h1 className="text-heading-32">Page not found</h1>
        <p className="mt-3 text-copy-16 text-gray-900">
          The requested page does not exist. Browse the eve documentation to continue.
        </p>
        <a
          className="mt-6 inline-flex rounded-md border px-4 py-2 text-label-14"
          href="/docs/getting-started"
        >
          Browse documentation
        </a>
      </main>
    </body>
  </html>
);

export default GlobalNotFound;
