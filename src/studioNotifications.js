import { supabase } from './supabaseClient';
import { normalizeEmail } from './studioConfig';

function designerEmailById(designers) {
  const map = new Map();
  (designers || []).forEach((d) => {
    if (!d?.id) return;
    const email = normalizeEmail(d.email);
    if (email) map.set(d.id, email);
  });
  return map;
}

function projectDesignerIds(project) {
  if (!project) return [];
  const raw = Array.isArray(project.designerIds) ? project.designerIds : [];
  const ids = [...new Set(raw.filter((id) => id != null && String(id).trim() !== ''))];
  if (ids.length > 0) return ids;
  const leg = project.designerId != null && String(project.designerId).trim() !== ''
    ? String(project.designerId)
    : '';
  return leg ? [leg] : [];
}

function emailsForProject(project, emailById) {
  return [...new Set(projectDesignerIds(project)
    .map((id) => emailById.get(id))
    .filter(Boolean))];
}

function projectLabel(project) {
  const name = String(project?.name || '').trim() || 'Untitled';
  const client = String(project?.client || '').trim();
  return client ? `${client} — ${name}` : name;
}

function uniqueEmails(list) {
  return [...new Set((list || []).map(normalizeEmail).filter(Boolean))];
}

function newlyAssignedEmails(prev, next, emailById) {
  const before = new Set(projectDesignerIds(prev));
  return projectDesignerIds(next)
    .filter((id) => !before.has(id))
    .map((id) => emailById.get(id))
    .filter(Boolean);
}

function timelineDatesChanged(prev, next) {
  if (!prev || !next) return false;
  return prev.startDate !== next.startDate || prev.endDate !== next.endDate;
}

function formatDateRange(project) {
  const start = String(project?.startDate || '').trim() || '—';
  const end = String(project?.endDate || '').trim() || '—';
  return `${start} → ${end}`;
}

/**
 * Chat only:
 * 1. You were put on a job (new job with you on it, or added later)
 * 2. Timeline start/end dates changed on a job you are on
 *
 * Milestones go to Google Calendar (not Chat).
 * Status / board moves / deletes do not notify.
 */
export function buildNotifyEvents({
  prevProjects,
  nextProjects,
  designers,
  actorEmail,
}) {
  const emailById = designerEmailById(designers);
  const actor = normalizeEmail(actorEmail);
  const prevMap = new Map((prevProjects || []).map((p) => [p.id, p]));
  const nextMap = new Map((nextProjects || []).map((p) => [p.id, p]));
  const events = [];

  const push = (project, kind, summary, recipients, extra = {}) => {
    const assigned = uniqueEmails(recipients).filter(Boolean);
    // Skip the person who saved when someone else is also notified.
    // Solo: still ping you (you added yourself / only person on the job).
    const others = assigned.filter((e) => e !== actor);
    const to = others.length > 0 ? others : assigned;
    if (to.length === 0) return;
    events.push({
      kind,
      project_id: project?.id || null,
      project_label: projectLabel(project),
      summary,
      recipients: to,
      actor_email: actor || null,
      payload: extra,
    });
  };

  nextMap.forEach((next, id) => {
    const prev = prevMap.get(id);

    if (!prev) {
      // New job — only people already assigned
      push(
        next,
        'assigned_to_job',
        `You have been added to ${projectLabel(next)}`,
        emailsForProject(next, emailById),
        { startDate: next.startDate, endDate: next.endDate },
      );
      return;
    }

    const added = newlyAssignedEmails(prev, next, emailById);
    if (added.length > 0) {
      push(
        next,
        'assigned_to_job',
        `You have been added to ${projectLabel(next)}`,
        added,
        { startDate: next.startDate, endDate: next.endDate },
      );
    }

    if (timelineDatesChanged(prev, next)) {
      push(
        next,
        'timeline_dates_changed',
        `${projectLabel(next)}: dates ${formatDateRange(next)}`,
        emailsForProject(next, emailById),
        {
          startDate: next.startDate,
          endDate: next.endDate,
          prevStartDate: prev.startDate,
          prevEndDate: prev.endDate,
        },
      );
    }
  });

  return events;
}

export async function enqueueStudioNotifications(events) {
  if (!supabase || !events?.length) return { ok: true, skipped: true };
  const { error } = await supabase.from('studio_notify_events').insert(events);
  if (error) {
    console.error('[Notify] queue failed:', error.message);
    return { ok: false, error };
  }
  return { ok: true };
}
