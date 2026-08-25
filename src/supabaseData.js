import { supabase, isSupabaseConfigured } from './supabaseClient';

const WORKSPACE_ID = 'main';

/**
 * Load shared designers + projects from Supabase.
 * @returns {Promise<{ designers: unknown[], projects: unknown[], todos: unknown[], updatedAt: string | null } | null>}
 */
export async function loadWorkspacePayload() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('studio_workspace')
    .select('payload, updated_at')
    .eq('id', WORKSPACE_ID)
    .maybeSingle();

  if (error) {
    console.error('[Supabase] load failed:', error.message);
    return null;
  }
  if (data?.payload == null) {
    return { designers: [], projects: [], todos: [], updatedAt: data?.updated_at ?? null };
  }

  const p = data.payload;
  const designers = Array.isArray(p.designers) ? p.designers : [];
  const projects = Array.isArray(p.projects) ? p.projects : [];
  const todos = Array.isArray(p.todos) ? p.todos : [];
  return { designers, projects, todos, updatedAt: data.updated_at ?? null };
}

/**
 * Lightweight check — used when the tab regains focus.
 * @returns {Promise<string | null>}
 */
export async function fetchWorkspaceUpdatedAt() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('studio_workspace')
    .select('updated_at')
    .eq('id', WORKSPACE_ID)
    .maybeSingle();

  if (error) {
    console.error('[Supabase] updated_at check failed:', error.message);
    return null;
  }
  return data?.updated_at ?? null;
}

/**
 * Save full workspace (replace payload for id = main).
 * Protects to-dos from accidental wipes: never replace a non-empty cloud
 * list with a missing or empty todos array (deploy / sign-in races).
 */
export async function saveWorkspacePayload(payload) {
  if (!supabase) return { ok: false, error: 'not configured' };

  let nextPayload = payload;
  try {
    const { data: existing, error: readError } = await supabase
      .from('studio_workspace')
      .select('payload')
      .eq('id', WORKSPACE_ID)
      .maybeSingle();

    if (!readError) {
      const existingTodos = Array.isArray(existing?.payload?.todos)
        ? existing.payload.todos
        : [];
      const hasTodosKey = payload && Object.prototype.hasOwnProperty.call(payload, 'todos');
      const incomingTodos = hasTodosKey && Array.isArray(payload.todos) ? payload.todos : null;

      if (existingTodos.length > 0 && (!hasTodosKey || incomingTodos?.length === 0)) {
        nextPayload = { ...payload, todos: existingTodos };
      }
    }
  } catch (err) {
    console.error('[Supabase] todo overwrite guard failed:', err);
  }

  const { data, error } = await supabase
    .from('studio_workspace')
    .upsert({ id: WORKSPACE_ID, payload: nextPayload }, { onConflict: 'id' })
    .select('updated_at')
    .single();

  if (error) {
    console.error('[Supabase] save failed:', error.message);
    return { ok: false, error };
  }
  return { ok: true, updatedAt: data?.updated_at ?? null };
}

/**
 * Subscribe to remote workspace updates (Supabase Realtime).
 * @param {(updatedAt: string) => void} onRemoteUpdate
 * @returns {() => void} unsubscribe
 */
export function subscribeWorkspaceChanges(onRemoteUpdate) {
  if (!supabase) return () => {};

  const channel = supabase
    .channel('studio_workspace_main')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'studio_workspace',
        filter: `id=eq.${WORKSPACE_ID}`,
      },
      (payload) => {
        const updatedAt = payload.new?.updated_at;
        if (updatedAt) onRemoteUpdate(updatedAt);
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export { isSupabaseConfigured };
