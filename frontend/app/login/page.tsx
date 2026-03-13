"use client";
import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useGoogleLogin } from "@react-oauth/google";
import { saveUserToLocalStorage as saveUser } from "@/lib/auth";

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);

  // --- Google OAuth ---
  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setLoading(true);
      try {
        const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        const profile = await res.json();
        saveUser({
          email: profile.email,
          name: profile.name,
          picture: profile.picture,
          createdAt: new Date().toISOString(),
        });
        router.push("/");
      } catch {
        setError("Google sign-in failed. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    onError: () => setError("Google sign-in was cancelled or failed."),
    flow: "implicit",
  });

  // --- Email sign-in: check against verified users first ---
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotFound(false);
    if (!email || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/check-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (res.status === 404) {
          setNotFound(true);
          setError("No account found for this email.");
        } else {
          setError(data.error || "Sign in failed. Please try again.");
        }
        return;
      }

      // ✅ Verified user — log them in
      saveUser({ email: data.email, createdAt: new Date().toISOString() });
      router.push("/");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-4">
      <div className="w-full max-w-[420px]">
        <div className="bg-[#111111] border border-[#1f1f1f] rounded-2xl px-8 py-10 shadow-2xl">

          {/* Logo */}
          <div className="flex justify-center mb-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#1c2e28] flex items-center justify-center overflow-hidden shrink-0">
                <Image src="/openclaw.png" alt="ClawdFace" width={30} height={30} className="object-contain" />
              </div>
              <span className="text-white font-bold text-[22px] tracking-tight">ClawdFace</span>
            </div>
          </div>

          <div className="text-center mb-7">
            <h1 className="text-white font-bold text-[24px] mb-1.5 tracking-tight">Welcome back</h1>
            <p className="text-[#6b7280] text-sm">Sign in to manage your video assistant</p>
          </div>

          {/* Google Sign In */}
          <button
            onClick={() => googleLogin()}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 bg-white hover:bg-neutral-100 text-[#111] font-medium text-[14px] rounded-xl py-3 px-4 transition-all duration-200 mb-5 disabled:opacity-60 shadow-sm"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-5">
            <div className="flex-1 h-px bg-[#1f1f1f]" />
            <span className="text-[#4b5563] text-xs">or sign in with email</span>
            <div className="flex-1 h-px bg-[#1f1f1f]" />
          </div>

          {/* Email form */}
          <form onSubmit={handleSignIn} className="flex flex-col gap-4">
            <div>
              <label className="block text-[#9ca3af] text-[13px] font-medium mb-1.5">
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoFocus
                className="w-full bg-[#0A0A0A] border border-[#1f1f1f] hover:border-[#2a2a2a] focus:border-[#00E3AA]/60 outline-none text-white text-[14px] rounded-xl px-4 py-3 transition-colors placeholder:text-[#3a3a3a]"
              />
              {error && (
                <div className="mt-2 text-xs rounded-lg bg-red-950/40 border border-red-500/20 px-3 py-2 flex items-center gap-2">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                  <span className="text-red-400 flex-1">{error}</span>
                  {notFound && (
                    <Link href="/signup" className="text-[#00E3AA] font-semibold hover:underline whitespace-nowrap">Sign up →</Link>
                  )}
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={loading || !email}
              className="w-full bg-[#00E3AA] hover:bg-[#00c994] text-black font-semibold text-[14px] rounded-xl py-3 px-4 transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? (
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" opacity="0.25"/>
                  <path d="M22 12a10 10 0 0 1-10 10" opacity="0.9"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>
                </svg>
              )}
              {loading ? "Signing in…" : "Sign In"}
            </button>
          </form>

          <p className="text-center text-[#6b7280] text-[13px] mt-6">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="text-[#00E3AA] hover:underline font-medium">
              Sign up for free
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
