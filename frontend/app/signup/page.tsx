"use client";
import { useState, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useGoogleLogin } from "@react-oauth/google";
import { saveUser } from "@/lib/auth";

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

type Stage = "email" | "otp";

export default function SignUpPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<Stage>("email");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setLoading(true);
      try {
        const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        const profile = await res.json();
        saveUser({ email: profile.email, name: profile.name, picture: profile.picture, createdAt: new Date().toISOString() });
        router.push("/");
      } catch { setError("Google sign-in failed. Please try again."); }
      finally { setLoading(false); }
    },
    onError: () => setError("Google sign-in was cancelled or failed."),
    flow: "implicit",
  });

  const handleSendOtp = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError("");
    if (!email || !email.includes("@")) { setError("Please enter a valid email address."); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/send-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Failed to send OTP."); return; }
      setStage("otp");
      setOtp(["", "", "", "", "", ""]);
      setResendCooldown(60);
      const interval = setInterval(() => {
        setResendCooldown((c) => { if (c <= 1) { clearInterval(interval); return 0; } return c - 1; });
      }, 1000);
    } catch { setError("Network error. Please try again."); }
    finally { setLoading(false); }
  };

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);
    if (value && index < 5) otpRefs.current[index + 1]?.focus();
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) otpRefs.current[index - 1]?.focus();
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 6) { setOtp(pasted.split("")); otpRefs.current[5]?.focus(); }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const otpValue = otp.join("");
    if (otpValue.length !== 6) { setError("Please enter the full 6-digit code."); return; }
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/verify-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, otp: otpValue }) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Invalid OTP."); return; }
      saveUser({ email: data.email, createdAt: new Date().toISOString() });
      router.push("/");
    } catch { setError("Network error. Please try again."); }
    finally { setLoading(false); }
  };

  return (
    <main className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-4">
      <div className="w-full max-w-[420px]">
        <div className="bg-[#111111] border border-[#1f1f1f] rounded-2xl px-8 py-10 shadow-2xl">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#1c2e28] flex items-center justify-center overflow-hidden shrink-0">
                <Image src="/openclaw.png" alt="ClawdFace" width={30} height={30} className="object-contain" />
              </div>
              <span className="text-white font-bold text-[22px] tracking-tight">ClawdFace</span>
            </div>
          </div>

          {stage === "email" ? (
            <>
              <div className="text-center mb-7">
                <h1 className="text-white font-bold text-[24px] mb-1.5 tracking-tight">Create your account</h1>
                <p className="text-[#6b7280] text-sm">Get your video assistant set up in under 2 minutes</p>
              </div>
              <button onClick={() => googleLogin()} disabled={loading}
                className="w-full flex items-center justify-center gap-3 bg-white hover:bg-neutral-100 text-[#111] font-medium text-[14px] rounded-xl py-3 px-4 transition-all duration-200 mb-5 disabled:opacity-60">
                <GoogleIcon /> Continue with Google
              </button>
              <div className="flex items-center gap-3 mb-5">
                <div className="flex-1 h-px bg-[#1f1f1f]" />
                <span className="text-[#4b5563] text-xs">or</span>
                <div className="flex-1 h-px bg-[#1f1f1f]" />
              </div>
              <form onSubmit={handleSendOtp} className="flex flex-col gap-4">
                <div>
                  <label className="block text-[#9ca3af] text-[13px] font-medium mb-1.5">Email address</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
                    className="w-full bg-[#0A0A0A] border border-[#1f1f1f] hover:border-[#2a2a2a] focus:border-[#00E3AA]/50 outline-none text-white text-[14px] rounded-xl px-4 py-3 transition-colors placeholder:text-[#3a3a3a]" />
                  {error && <p className="text-red-400 text-xs mt-1.5">{error}</p>}
                </div>
                <button type="submit" disabled={loading}
                  className="w-full bg-[#00E3AA] hover:bg-[#00c994] text-black font-semibold text-[14px] rounded-xl py-3 px-4 transition-all duration-200 disabled:opacity-60 flex items-center justify-center gap-2">
                  {loading && <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25"/><path d="M22 12a10 10 0 0 1-10 10" opacity="0.9"/></svg>}
                  {loading ? "Sending OTP…" : "Send OTP"}
                </button>
              </form>
              <p className="text-center text-[#6b7280] text-[13px] mt-6">
                Already have an account?{" "}
                <Link href="/login" className="text-[#00E3AA] hover:underline font-medium">Sign in</Link>
              </p>
            </>
          ) : (
            <>
              <div className="text-center mb-7">
                <div className="w-14 h-14 rounded-full bg-[#00E3AA]/10 flex items-center justify-center mx-auto mb-4">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#00E3AA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><path d="m16 19 2 2 4-4"/>
                  </svg>
                </div>
                <h1 className="text-white font-bold text-[22px] mb-1.5 tracking-tight">Check your email</h1>
                <p className="text-[#6b7280] text-sm">We sent a 6-digit code to</p>
                <p className="text-[#00E3AA] text-sm font-semibold mt-0.5 truncate">{email}</p>
              </div>
              <form onSubmit={handleVerifyOtp} className="flex flex-col gap-5">
                <div className="flex gap-2 justify-center" onPaste={handleOtpPaste}>
                  {otp.map((digit, i) => (
                    <input key={i}
                      ref={(el) => { otpRefs.current[i] = el; }}
                      type="text" inputMode="numeric" maxLength={1} value={digit}
                      onChange={(e) => handleOtpChange(i, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(i, e)}
                      className={`w-12 h-14 text-center text-[22px] font-bold rounded-xl border bg-[#0A0A0A] text-white outline-none transition-all duration-150
                        ${digit ? 'border-[#00E3AA] shadow-[0_0_0_1px_#00E3AA30]' : 'border-[#1f1f1f] focus:border-[#00E3AA]/50'}`} />
                  ))}
                </div>
                {error && <p className="text-red-400 text-xs text-center">{error}</p>}
                <button type="submit" disabled={loading || otp.join("").length !== 6}
                  className="w-full bg-[#00E3AA] hover:bg-[#00c994] text-black font-semibold text-[14px] rounded-xl py-3 px-4 transition-all duration-200 disabled:opacity-60 flex items-center justify-center gap-2">
                  {loading && <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25"/><path d="M22 12a10 10 0 0 1-10 10" opacity="0.9"/></svg>}
                  {loading ? "Verifying…" : "Verify & Create Account"}
                </button>
              </form>
              <div className="flex items-center justify-between mt-5">
                <button onClick={() => { setStage("email"); setError(""); setOtp(["","","","","",""]); }}
                  className="text-[#6b7280] hover:text-white text-[13px] transition-colors">← Change email</button>
                <button onClick={() => handleSendOtp()} disabled={resendCooldown > 0 || loading}
                  className="text-[#00E3AA] hover:underline text-[13px] disabled:text-[#4b5563] disabled:no-underline transition-colors">
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend code"}
                </button>
              </div>
            </>
          )}
        </div>
        {stage === "email" && (
          <p className="text-center text-[#3a3a3a] text-[12px] mt-6">
            By signing up, you agree to our{" "}
            <span className="text-[#4b5563] hover:text-[#9ca3af] cursor-pointer transition-colors">Terms of Service</span>{" "}and{" "}
            <span className="text-[#4b5563] hover:text-[#9ca3af] cursor-pointer transition-colors">Privacy Policy</span>.
          </p>
        )}
      </div>
    </main>
  );
}
