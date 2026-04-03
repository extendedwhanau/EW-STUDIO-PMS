import { createClient } from '@supabase/supabase-js';

const url = process.env.REACT_APP_SUPABASE_URL;
const anonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

/** Single browser client — safe to import from anywhere. Uses anon key only. */
export const supabase =
  url && anonKey ? createClient(url, anonKey) : null;

export function isSupabaseConfigured() {
  return Boolean(url && anonKey);
}

if (process.env.NODE_ENV === 'development' && !isSupabaseConfigured()) {
  // eslint-disable-next-line no-console
  console.info(
    '[Supabase] Add REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY to .env.local (see .env.example).',
  );
}
