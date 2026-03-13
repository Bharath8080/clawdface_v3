import { supabase } from "./supabase";

const AUTH_KEY = "clawdface_auth";
export const THEME_KEY = "clawdface_theme";

export interface AuthUser {
  email: string;
  name?: string;
  picture?: string;
  createdAt: string;
}

export function getUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveUser(user: AuthUser) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
  
  // Sync with Supabase
  try {
    const { data, error } = await supabase
      .from('profiles')
      .upsert({ email: user.email }, { onConflict: 'email' })
      .select()
      .single();
      
    if (error) throw error;
    return data;
  } catch (err) {
    console.error("Error syncing user to Supabase:", err);
    return null;
  }
}

export async function getLastConfig(email: string) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('last_config')
      .eq('email', email)
      .single();
      
    if (error) throw error;
    return data?.last_config;
  } catch (err) {
    console.error("Error fetching last config from Supabase:", err);
    return null;
  }
}

export async function updateLastConfig(email: string, config: any) {
  try {
    const { error } = await supabase
      .from('profiles')
      .update({ last_config: config })
      .eq('email', email);
      
    if (error) throw error;
  } catch (err) {
    console.error("Error updating last config in Supabase:", err);
  }
}

export function logout() {
  localStorage.removeItem(AUTH_KEY);
}

export function isAuthenticated(): boolean {
  return getUser() !== null;
}

export function getInitials(user: AuthUser | null): string {
  if (!user) return "?";
  if (user.name) {
    const parts = user.name.trim().split(" ");
    return parts.slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }
  return user.email.slice(0, 2).toUpperCase();
}

export function getTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  return (localStorage.getItem(THEME_KEY) as "dark" | "light") || "dark";
}

export function setTheme(theme: "dark" | "light") {
  localStorage.setItem(THEME_KEY, theme);
  if (theme === "light") {
    document.documentElement.classList.add("light");
  } else {
    document.documentElement.classList.remove("light");
  }
  // Notify all components about the theme change
  window.dispatchEvent(new CustomEvent("clawdface-theme-change", { detail: theme }));
}
