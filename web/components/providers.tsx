"use client";

import { ThemeProvider } from "next-themes";
import { SWRConfig } from "swr";
import { useMockSync } from "@/lib/hooks";
import { WalletProvider } from "@/lib/wallet";

function MockSync() {
  useMockSync();
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <SWRConfig value={{ errorRetryCount: 2 }}>
        <MockSync />
        <WalletProvider>{children}</WalletProvider>
      </SWRConfig>
    </ThemeProvider>
  );
}
