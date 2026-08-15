import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "eve multi-agent Next.js fixture",
  description: "Next.js fixture for withEve named agents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
