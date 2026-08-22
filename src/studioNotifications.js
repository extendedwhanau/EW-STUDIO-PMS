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

function phaseDateStamp(phase) {
  const tasks = (phase?.tasks || [])
    .map((task) => `${task.id || ''}:${task.startDate || ''}:${task.endDate || ''}`)
    .join(',');
  return `${phase?.id || ''}:${phase?.startDate || ''}:${phase?.endDate || ''}:${tasks}`;
}

function markerDateStamp(marker) {
  return `${marker?.id || ''}:${marker?.date || marker?.startDate || ''}`;
}

/** Job bar, phase bars, tasks, and check-in markers on the Gantt. */
function timelineFingerprint(project) {
  if (!project) return '';
  const phases = (project.milestones || []).map(phaseDateStamp).join('|');
  const markers = (project.markers || []).map(markerDateStamp).join('|');
  return `${project.startDate || ''}..${project.endDate || ''}::${phases}::${markers}`;
}

function timelineDatesChanged(prev, next) {
  if (!prev || !next) return false;
  return timelineFingerprint(prev) !== timelineFingerprint(next);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseIsoLocal(iso) {
  const m = String(iso || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dayOrdinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** e.g. 14th August */
function formatNiceDate(iso) {
  const d = parseIsoLocal(iso);
  if (!d) return '—';
  return `${dayOrdinal(d.getDate())} ${MONTHS[d.getMonth()]}`;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Calendar days from today to end date. */
function formatDaysAway(iso) {
  const end = parseIsoLocal(iso);
  if (!end) return '';
  const today = startOfLocalDay(new Date());
  const target = startOfLocalDay(end);
  const days = Math.round((target - today) / 86400000);
  if (days === 0) return 'Due today';
  if (days === 1) return '1 day away';
  if (days > 1) return `${days} days away`;
  if (days === -1) return '1 day overdue';
  return `${Math.abs(days)} days overdue`;
}

function dateChangeSummary(project) {
  const label = projectLabel(project);
  const from = formatNiceDate(project.startDate);
  const to = formatNiceDate(project.endDate);
  const away = formatDaysAway(project.endDate);
  const lines = [
    label,
    `Date change. From ${from} to ${to}.`,
  ];
  if (away) lines.push(away);
  return lines.join('\n');
}

function assignedSummary(project) {
  const label = projectLabel(project);
  const from = formatNiceDate(project.startDate);
  const to = formatNiceDate(project.endDate);
  const away = formatDaysAway(project.endDate);
  const lines = [
    label,
    'You have been added to this job.',
    `Dates: ${from} to ${to}.`,
  ];
  if (away) lines.push(away);
  return lines.join('\n');
}

/**
 * Chat only:
 * 1. You were put on a job (new job with you on it, or added later)
 * 2. Any timeline dates changed (job start/end, phases, tasks, markers)
 *
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

  const push = (project, kind, summary, recipients, extra = {}, opts = {}) => {
    const assigned = uniqueEmails(recipients).filter(Boolean);
    const others = assigned.filter((e) => e !== actor);
    const includeActor = Boolean(opts.includeActor);
    const to = includeActor
      ? assigned
      : (others.length > 0 ? others : assigned);
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
        assignedSummary(next),
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
        assignedSummary(next),
        added,
        { startDate: next.startDate, endDate: next.endDate },
      );
    }

    if (timelineDatesChanged(prev, next)) {
      push(
        next,
        'timeline_dates_changed',
        dateChangeSummary(next),
        emailsForProject(next, emailById),
        {
          startDate: next.startDate,
          endDate: next.endDate,
          prevStartDate: prev.startDate,
          prevEndDate: prev.endDate,
        },
        { includeActor: true },
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
