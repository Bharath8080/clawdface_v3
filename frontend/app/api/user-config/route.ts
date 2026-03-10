import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

/**
 * Lightweight API route to sync localStorage config to local files.
 * This is for local development visibility in data/user-configs.
 */

const CONFIGS_DIR = path.join(process.cwd(), "data", "user-configs");

export async function POST(req: Request) {
  try {
    const { email, config } = await req.json();
    if (!email || !config) {
      return NextResponse.json({ error: "Email and config required" }, { status: 400 });
    }

    const fileName = `${email.toLowerCase().trim()}.json`;
    const filePath = path.join(CONFIGS_DIR, fileName);

    // Create directory if it doesn't exist
    await fs.mkdir(CONFIGS_DIR, { recursive: true });

    // Save config to file
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));

    return NextResponse.json({ success: true, path: filePath });
  } catch (error) {
    console.error("[user-config] Sync failed:", error);
    // We don't return 500 because on Vercel this will fail (read-only FS)
    // but the app should still work via localStorage.
    return NextResponse.json({ success: false, message: "Sync failed (likely read-only FS)" });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const email = searchParams.get("email");

    if (!email) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    const filePath = path.join(CONFIGS_DIR, `${email.toLowerCase().trim()}.json`);
    
    try {
      const data = await fs.readFile(filePath, "utf-8");
      return NextResponse.json(JSON.parse(data));
    } catch {
      return NextResponse.json(null); // File not found
    }
  } catch (error) {
    return NextResponse.json({ error: "Failed to read config" }, { status: 500 });
  }
}
