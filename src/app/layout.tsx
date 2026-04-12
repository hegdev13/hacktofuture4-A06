import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "react-hot-toast";
import { RootLayoutClient } from "@/components/RootLayoutClient";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KubePulse",
  description: "Production-grade Kubernetes monitoring dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#0B0F17] text-zinc-100">
        <RootLayoutClient>
          {children}
          <Toaster
            position="top-right"
            toastOptions={{
              style: {
                background: "#111827",
                color: "#E5E7EB",
                border: "1px solid rgba(255,255,255,0.08)",
              },
            }}
          />
        </RootLayoutClient>
      </body>
    </html>
  );
}
