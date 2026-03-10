import fs from "fs/promises";
import path from "path";

/**
 * Persistent verified-users store using Environment Variables or local JSON.
 * works on serverless (Vercel) via env vars.
 */

const VERIFIED_USERS_FILE = path.join(process.cwd(), "data", "verified-users.json");

export async function isVerifiedUser(email: string): Promise<boolean> {
  const cleanEmail = email.toLowerCase().trim();

  // 1. Check Environment Variable (Best for Vercel)
  const envEmails = process.env.VERIFIED_EMAILS || "";
  if (envEmails.split(",").map(e => e.trim().toLowerCase()).includes(cleanEmail)) {
    return true;
  }

  // 2. Check Local JSON (Fallback for local dev)
  try {
    const data = await fs.readFile(VERIFIED_USERS_FILE, "utf-8");
    const users: string[] = JSON.parse(data);
    return users.map(u => u.toLowerCase()).includes(cleanEmail);
  } catch (e) {
    return false;
  }
}

export async function registerVerifiedUser(email: string): Promise<void> {
  const cleanEmail = email.toLowerCase().trim();
  
  // NOTE: On Vercel, this won't persist to the file system.
  // The user should be added to the VERIFIED_EMAILS env var for permanent access.
  try {
    let users: string[] = [];
    try {
      const data = await fs.readFile(VERIFIED_USERS_FILE, "utf-8");
      users = JSON.parse(data);
    } catch {}

    if (!users.includes(cleanEmail)) {
      users.push(cleanEmail);
      await fs.mkdir(path.dirname(VERIFIED_USERS_FILE), { recursive: true });
      await fs.writeFile(VERIFIED_USERS_FILE, JSON.stringify(users, null, 2));
    }
  } catch (e) {
    console.error("[userStore] Local register failed (expected on Vercel):", e);
  }
}
