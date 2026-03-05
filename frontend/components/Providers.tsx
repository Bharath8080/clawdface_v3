"use client";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { useEffect } from "react";
import { getTheme } from "@/lib/auth";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Always enforce dark mode on mount — remove any stale light class
    const theme = getTheme();
    if (theme === "light") {
      document.documentElement.classList.remove("light");
    }
  }, []);

  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      {children}
    </GoogleOAuthProvider>
  );
}
