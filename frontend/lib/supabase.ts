import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials missing. Persistent storage will be disabled.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface Bot {
  id: string;
  user_id: string;
  name: string;
  avatar_id: string;
  voice_id: string;
  openclaw_url: string;
  gateway_token: string;
  session_key: string;
  created_at: string;
  updated_at: string;
}

export async function fetchBots(userId: string): Promise<Bot[]> {
  const { data, error } = await supabase
    .from('bots')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
    
  if (error) throw error;
  return data || [];
}

export async function createBot(bot: Partial<Bot>) {
  const { data, error } = await supabase
    .from('bots')
    .insert(bot)
    .select()
    .single();
    
  if (error) throw error;
  return data;
}

export async function updateBot(id: string, updates: Partial<Bot>) {
  const { data, error } = await supabase
    .from('bots')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
    
  if (error) throw error;
  return data;
}

export async function deleteBot(id: string) {
  const { error } = await supabase
    .from('bots')
    .delete()
    .eq('id', id);
    
  if (error) throw error;
}
