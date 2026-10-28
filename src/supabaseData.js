import { supabase, isSupabaseConfigured } from './supabaseClient';

const WORKSPACE_ID = 'main';

function parseStampTime(value) {
  const t = Date.parse(String(value || ''));
  return Number.isNaN(t) ? 0 : t;
}

function todoStamp(todo) {
  if (!todo) return 0;
  return Math.max(
    parseStampTime(todo.updatedAt),
    parseStampTime(todo.doneAt),
    parseStampTime(todo.createdAt),
    parseStampTime(todo.archivedAt),
  );
}

/** Prefer newer updatedAt; fall back to richer job content when stamps tie/missing. */
function projectStamp(project) {
  if (!project) return 0;
  const updated = parseStampTime(project.updatedAt);
  if (updated > 0) return updated;
  let score = 0;
  const milestones = Array.isArray(project.milestones) ? project.milestones : [];
  milestones.forEach((phase) => {
    score += 10;
    score += Array.isArray(phase?.tasks) ? phase.tasks.length : 0;
  });
  score += Array.isArray(project.markers) ? project.markers.length : 0;
  score += Array.isArray(project.comments) ? project.comments.length : 0;
  score += Array.isArray(project.links) ? project.links.length : 0;
  score += Array.isArray(project.todoHistory) ? project.todoHistory.length : 0;
  if (project.startDate) score += 2;
  if (project.endDate) score += 2;
  if (project.client) score += 1;
  if (project.name) score += 1;
  if (project.status) score += 1;
  return score;
}

function idsOf(list) {
  return new Set(
    (Array.isArray(list) ? list : [])
      .map((item) => String(item?.id || '').trim())
      .filter(Boolean),
  );
}

function logShrinkBlocked(kind, existing, incoming, merged, deletedIds) {
  const existingIds = idsOf(existing);
  const incomingIds = idsOf(incoming);
  const mergedIds = idsOf(merged);
  const droppedByIncoming = [...existingIds].filter((id) => !incomingIds.has(id));
  if (!droppedByIncoming.length) return;
  const retained = droppedByIncoming.filter((id) => mergedIds.has(id));
  if (!retained.length) return;
  console.warn(`[Supabase] blocked stale ${kind} shrink`, {
    existing: existingIds.size,
    incoming: incomingIds.size,
    merged: mergedIds.size,
    deletedIds: (deletedIds || []).length,
    retainedIds: retained.slice(0, 20),
  });
}

/**
 * Union merge records by id.
 * Prefer higher stamp; on equal stamp, `prefer` side wins field merges.
 * Ids in deletedIds are omitted (intentional deletes).
 */
function unionMergeById(primary, secondary, {
  deletedIds = [],
  prefer = 'secondary',
  stamp = () => 0,
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
    const prevStamp = stamp(prev);
    const nextStamp = stamp(item);
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
 * Union merge to-dos by id.
 * Prefer higher doneAt/createdAt stamp; on equal stamp, `prefer` side wins field merges.
 * Ids in deletedIds are omitted (intentional deletes).
 */
export function unionMergeTodos(primary, secondary, options = {}) {
  return unionMergeById(primary, secondary, { ...options, stamp: todoStamp });
}

/**
 * Union merge projects by id.
 * Prefer richer milestone/content stamp so a stale client can’t drop uploads.
 */
export function unionMergeProjects(primary, secondary, options = {}) {
  return unionMergeById(primary, secondary, { ...options, stamp: projectStamp });
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
 * Union-merges to-dos and projects by id so a stale/partial client cannot wipe the cloud list.
 * Pass deletedTodoIds / deletedProjectIds for intentional removals.
 */
export async function saveWorkspacePayload(payload) {
  if (!supabase) return { ok: false, error: 'not configured' };

  const deletedTodoIds = Array.isArray(payload?.deletedTodoIds)
    ? payload.deletedTodoIds
    : [];
  const deletedProjectIds = Array.isArray(payload?.deletedProjectIds)
    ? payload.deletedProjectIds
    : [];
  const {
    deletedTodoIds: _omitDeletedTodos,
    deletedProjectIds: _omitDeletedProjects,
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
      const existingProjects = Array.isArray(existing?.payload?.projects)
        ? existing.payload.projects
        : [];
      const hasTodosKey = payload && Object.prototype.hasOwnProperty.call(payload, 'todos');
      const hasProjectsKey = payload && Object.prototype.hasOwnProperty.call(payload, 'projects');
      const incomingTodos = hasTodosKey && Array.isArray(payload.todos) ? payload.todos : null;
      const incomingProjects = hasProjectsKey && Array.isArray(payload.projects)
        ? payload.projects
        : null;

      let todos = payloadWithoutDeleted.todos;
      if (!hasTodosKey || !incomingTodos || incomingTodos.length === 0) {
        todos = unionMergeTodos(existingTodos, [], { deletedIds: deletedTodoIds });
        if (existingTodos.length > 0) {
          logShrinkBlocked('todos', existingTodos, incomingTodos || [], todos, deletedTodoIds);
        }
      } else {
        todos = unionMergeTodos(existingTodos, incomingTodos, {
          deletedIds: deletedTodoIds,
          prefer: 'secondary',
        });
        logShrinkBlocked('todos', existingTodos, incomingTodos, todos, deletedTodoIds);
      }

      let projects = payloadWithoutDeleted.projects;
      if (!hasProjectsKey || !incomingProjects || incomingProjects.length === 0) {
        projects = unionMergeProjects(existingProjects, [], { deletedIds: deletedProjectIds });
        if (existingProjects.length > 0) {
          logShrinkBlocked(
            'projects',
            existingProjects,
            incomingProjects || [],
            projects,
            deletedProjectIds,
          );
        }
      } else {
        projects = unionMergeProjects(existingProjects, incomingProjects, {
          deletedIds: deletedProjectIds,
          prefer: 'secondary',
        });
        logShrinkBlocked(
          'projects',
          existingProjects,
          incomingProjects,
          projects,
          deletedProjectIds,
        );
      }

      nextPayload = {
        ...payloadWithoutDeleted,
        todos,
        projects,
      };
    }
  } catch (err) {
    console.error('[Supabase] workspace overwrite guard failed:', err);
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
