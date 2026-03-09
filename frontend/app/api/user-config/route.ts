import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const CONFIG_DIR = path.join(process.cwd(), "data", "user-configs");

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get("email");

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  try {
    const filePath = path.join(CONFIG_DIR, `${email}.json`);
    const data = await fs.readFile(filePath, "utf-8");
    return NextResponse.json(JSON.parse(data));
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return NextResponse.json({});
    }
    return NextResponse.json({ error: "Failed to read config" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email, config } = body;

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    await fs.mkdir(CONFIG_DIR, { recursive: true });
    const filePath = path.join(CONFIG_DIR, `${email}.json`);
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: "Failed to save config" }, { status: 500 });
  }
}
