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

function markerKey(marker) {
  return String(marker?.id || '');
}

function markerStamp(marker) {
  return `${String(marker?.title || '').trim()}|${String(marker?.date || '')}|${String(marker?.phaseKey || '')}`;
}

function markersChanged(prev, next) {
  const a = prev?.markers || [];
  const b = next?.markers || [];
  if (a.length !== b.length) return true;
  const map = new Map(a.map((m) => [markerKey(m), markerStamp(m)]));
  return b.some((m) => map.get(markerKey(m)) !== markerStamp(m));
}

function jobChanged(prev, next) {
  if (!prev || !next) return true;
  if (prev.status !== next.status) return true;
  if (prev.priority !== next.priority) return true;
  if (prev.startDate !== next.startDate) return true;
  if (prev.endDate !== next.endDate) return true;
  if (prev.name !== next.name) return true;
  const a = projectDesignerIds(prev).join(',');
  const b = projectDesignerIds(next).join(',');
  return a !== b;
}

function uniqueEmails(list) {
  return [...new Set((list || []).map(normalizeEmail).filter(Boolean))];
}

/**
 * Build notify rows for people assigned to the job.
 * If someone else is on the job, the person who saved is skipped.
 * If you are the only assignee, you still get the DM (so solo jobs notify).
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
      push(
        next,
        'job_created',
        `Added ${projectLabel(next)}`,
        emailsForProject(next, emailById),
      );
      if (markersChanged({ markers: [] }, next)) {
        push(
          next,
          'milestone_changed',
          `Milestones updated on ${projectLabel(next)}`,
          emailsForProject(next, emailById),
        );
      }
      return;
    }

    if (jobChanged(prev, next)) {
      const bits = [];
      if (prev.status !== next.status) bits.push(`status ${prev.status || '—'} → ${next.status || '—'}`);
      if (prev.priority !== next.priority) bits.push('moved on the board');
      if (prev.startDate !== next.startDate || prev.endDate !== next.endDate) bits.push('dates changed');
      if (projectDesignerIds(prev).join(',') !== projectDesignerIds(next).join(',')) {
        bits.push('team changed');
      }
      push(
        next,
        'job_changed',
        `${projectLabel(next)}: ${bits.join('; ') || 'updated'}`,
        emailsForProject(next, emailById),
      );
    }

    if (markersChanged(prev, next)) {
      push(
        next,
        'milestone_changed',
        `Milestones updated on ${projectLabel(next)}`,
        emailsForProject(next, emailById),
      );
    }
  });

  prevMap.forEach((prev, id) => {
    if (nextMap.has(id)) return;
    push(
      prev,
      'job_deleted',
      `Removed ${projectLabel(prev)}`,
      emailsForProject(prev, emailById),
    );
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
