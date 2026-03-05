import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

// Shared global OTP store (same singleton used by verify-otp route)
interface OtpRecord {
  otp: string;
  expiresAt: number;
  email: string;
}
declare global {
  // eslint-disable-next-line no-var
  var __otpStore: Map<string, OtpRecord> | undefined;
}
if (!global.__otpStore) {
  global.__otpStore = new Map<string, OtpRecord>();
}
const otpStore = global.__otpStore;

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // Gmail App Password
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "Invalid email address." }, { status: 400 });
    }

    const otp = generateOtp();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP keyed by email
    otpStore.set(email.toLowerCase(), { otp, expiresAt, email });

    // Send email
    const transporter = createTransporter();
    await transporter.sendMail({
      from: `"ClawdFace" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Your ClawdFace verification code",
      html: `
        <div style="font-family: Inter, sans-serif; max-width: 480px; margin: 0 auto; background: #111; color: #fff; border-radius: 16px; padding: 40px; border: 1px solid #222;">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom: 28px;">
            <div style="width:36px; height:36px; background:#1c2e28; border-radius:10px; display:flex; align-items:center; justify-content:center;">
              <span style="font-size:20px;">🦞</span>
            </div>
            <span style="font-size:20px; font-weight:700; color:#fff;">ClawdFace</span>
          </div>
          <h2 style="font-size:22px; font-weight:700; margin:0 0 8px 0;">Your verification code</h2>
          <p style="color:#9ca3af; font-size:14px; margin:0 0 28px 0;">Enter this code to sign in to ClawdFace. It expires in <strong style="color:#fff;">10 minutes</strong>.</p>
          <div style="background:#00E3AA; color:#000; font-size:36px; font-weight:800; letter-spacing:10px; text-align:center; border-radius:12px; padding:20px; margin-bottom:28px;">
            ${otp}
          </div>
          <p style="color:#4b5563; font-size:12px; margin:0;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    return NextResponse.json({ success: true, message: "OTP sent successfully." });
  } catch (error) {
    console.error("OTP send error:", error);
    return NextResponse.json({ error: "Failed to send OTP. Check server email config." }, { status: 500 });
  }
}
