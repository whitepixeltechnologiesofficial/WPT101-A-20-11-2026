import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "WPT Web",
  description: "WPT on your computer",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
