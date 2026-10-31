import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { AppLayout } from "@/components/layout/app-layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { withBasePath } from "@/lib/base-path";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TINA Dashboard",
  description: "Open source meeting transcription dashboard for TINA",
  icons: {
    icon: [
      {
        url: withBasePath("/icons/tina-favicon.svg"),
        type: "image/svg+xml",
      },
    ],
    apple: [
      {
        url: withBasePath("/icons/tina-dark.svg"),
        type: "image/svg+xml",
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistMono.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider delayDuration={0}>
            <AppLayout>{children}</AppLayout>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
