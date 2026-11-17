import type { ReactNode } from "react";
import "./style.css";

export const metadata = {
  title: "Bell | Personal assistant stack",
  description: "A small, independent browser assistant.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
