import { supabase, isSupabaseConfigured } from './supabaseClient';

const WORKSPACE_ID = 'main';

/**
 * Load shared designers + projects from Supabase.
 * @returns {Promise<{ designers: unknown[], projects: unknown[] } | null>}
 */
export async function loadWorkspacePayload() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('studio_workspace')
    .select('payload')
    .eq('id', WORKSPACE_ID)
    .maybeSingle();

  if (error) {
    console.error('[Supabase] load failed:', error.message);
    return null;
  }
  if (data?.payload == null) {
    return { designers: [], projects: [] };
  }

  const p = data.payload;
  const designers = Array.isArray(p.designers) ? p.designers : [];
  const projects = Array.isArray(p.projects) ? p.projects : [];
  return { designers, projects };
}

/**
 * Save full workspace (replace payload for id = main).
 */
export async function saveWorkspacePayload(payload) {
  if (!supabase) return { ok: false, error: 'not configured' };

  const { error } = await supabase.from('studio_workspace').upsert(
    {
      id: WORKSPACE_ID,
      payload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );

  if (error) {
    console.error('[Supabase] save failed:', error.message);
    return { ok: false, error };
  }
  return { ok: true };
}

export { isSupabaseConfigured };
