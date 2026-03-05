import { NextRequest, NextResponse } from "next/server";
import { registerVerifiedUser } from "@/lib/userStore";

// Shared global OTP store
interface OtpRecord { otp: string; expiresAt: number; email: string; }
declare global { var __otpStore: Map<string, OtpRecord> | undefined; }
if (!global.__otpStore) global.__otpStore = new Map<string, OtpRecord>();
const otpStore = global.__otpStore;

export async function POST(req: NextRequest) {
  try {
    const { email, otp } = await req.json();

    if (!email || !otp) {
      return NextResponse.json({ error: "Email and OTP are required." }, { status: 400 });
    }

    const key = email.toLowerCase();
    const record = otpStore.get(key);

    if (!record) {
      return NextResponse.json(
        { error: "No OTP found for this email. Please request a new one." },
        { status: 400 }
      );
    }

    if (Date.now() > record.expiresAt) {
      otpStore.delete(key);
      return NextResponse.json(
        { error: "OTP expired. Please request a new one." },
        { status: 400 }
      );
    }

    if (record.otp !== otp.trim()) {
      return NextResponse.json(
        { error: "Incorrect OTP. Please try again." },
        { status: 400 }
      );
    }

    // ✅ Valid — register this email as verified and clean up OTP
    otpStore.delete(key);
    registerVerifiedUser(key);

    return NextResponse.json({ success: true, email: record.email });
  } catch (error) {
    console.error("OTP verify error:", error);
    return NextResponse.json({ error: "Verification failed." }, { status: 500 });
  }
}
