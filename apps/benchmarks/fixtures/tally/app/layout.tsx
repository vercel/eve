import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tally",
  description: "Invoicing for small studios.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
