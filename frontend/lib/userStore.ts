/**
 * Persistent verified-users store backed by a JSON file on disk.
 * Survives server restarts. In production, replace with a database.
 */
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const USERS_FILE = path.join(DATA_DIR, "verified-users.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadUsers(): Set<string> {
  try {
    ensureDir();
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, "utf-8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set<string>(arr);
    }
  } catch (e) {
    console.error("[userStore] Failed to load users file:", e);
  }
  return new Set<string>();
}

function saveUsers(users: Set<string>) {
  try {
    ensureDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify([...users], null, 2), "utf-8");
  } catch (e) {
    console.error("[userStore] Failed to save users file:", e);
  }
}

// Keep an in-memory cache too for speed, backed by disk
let _cache: Set<string> | null = null;

function getStore(): Set<string> {
  if (!_cache) {
    _cache = loadUsers();
  }
  return _cache;
}

export function isVerifiedUser(email: string): boolean {
  return getStore().has(email.toLowerCase());
}

export function registerVerifiedUser(email: string): void {
  const store = getStore();
  store.add(email.toLowerCase());
  saveUsers(store); // persist immediately
}
