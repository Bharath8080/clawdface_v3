import { NextRequest, NextResponse } from "next/server";
import { isVerifiedUser } from "@/lib/userStore";

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email) {
      return NextResponse.json({ error: "Email is required." }, { status: 400 });
    }

    const verified = isVerifiedUser(email.toLowerCase());

    if (!verified) {
      return NextResponse.json(
        { error: "No account found for this email. Please sign up first." },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, email: email.toLowerCase() });
  } catch (error) {
    console.error("Check user error:", error);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
