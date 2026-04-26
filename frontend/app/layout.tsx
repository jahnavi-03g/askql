import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AskQL — Natural Language to SQL",
  description: "Ask questions in plain English, get SQL and results instantly.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}