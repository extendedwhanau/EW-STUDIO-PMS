import { supabase, isSupabaseConfigured } from './supabaseClient';

const WORKSPACE_ID = 'main';

function todoStamp(todo) {
  if (!todo) return 0;
  const candidates = [todo.doneAt, todo.createdAt, todo.archivedAt]
    .map((v) => Date.parse(String(v || '')) || 0);
  return Math.max(0, ...candidates);
}

/**
 * Union merge to-dos by id.
 * Prefer higher doneAt/createdAt stamp; on equal stamp, `prefer` side wins field merges.
 * Ids in deletedIds are omitted (intentional deletes).
 */
export function unionMergeTodos(primary, secondary, {
  deletedIds = [],
  prefer = 'secondary',
} = {}) {
  const deleted = new Set((deletedIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const byId = new Map();

  const consider = (item, isPreferredSide) => {
    if (!item) return;
    const id = String(item.id || '').trim();
    if (!id || deleted.has(id)) return;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, item);
      return;
    }
    const prevStamp = todoStamp(prev);
    const nextStamp = todoStamp(item);
    if (nextStamp > prevStamp) {
      byId.set(id, { ...prev, ...item });
    } else if (nextStamp < prevStamp) {
      byId.set(id, { ...item, ...prev });
    } else if (isPreferredSide) {
      byId.set(id, { ...prev, ...item });
    } else {
      byId.set(id, { ...item, ...prev });
    }
  };

  const primaryPreferred = prefer === 'primary';
  (Array.isArray(primary) ? primary : []).forEach((item) => consider(item, primaryPreferred));
  (Array.isArray(secondary) ? secondary : []).forEach((item) => consider(item, !primaryPreferred));

  return Array.from(byId.values());
}

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
 * Union-merges to-dos by id so a stale/partial client cannot wipe the cloud list.
 * Pass deletedTodoIds for intentional removals.
 */
export async function saveWorkspacePayload(payload) {
  if (!supabase) return { ok: false, error: 'not configured' };

  const deletedTodoIds = Array.isArray(payload?.deletedTodoIds)
    ? payload.deletedTodoIds
    : [];
  const {
    deletedTodoIds: _omitDeleted,
    ...payloadWithoutDeleted
  } = payload || {};

  let nextPayload = payloadWithoutDeleted;
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

      if (!hasTodosKey) {
        nextPayload = {
          ...payloadWithoutDeleted,
          todos: unionMergeTodos(existingTodos, [], { deletedIds: deletedTodoIds }),
        };
      } else if (!incomingTodos || incomingTodos.length === 0) {
        // Empty/missing list: keep cloud todos except intentional deletes.
        nextPayload = {
          ...payloadWithoutDeleted,
          todos: unionMergeTodos(existingTodos, [], { deletedIds: deletedTodoIds }),
        };
      } else {
        nextPayload = {
          ...payloadWithoutDeleted,
          todos: unionMergeTodos(existingTodos, incomingTodos, {
            deletedIds: deletedTodoIds,
            prefer: 'secondary',
          }),
        };
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
