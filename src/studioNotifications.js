import { supabase } from './supabaseClient';
import { normalizeEmail } from './studioConfig';

/** No designer Chat while a job sits in the pipeline / leads list. */
const QUIET_STATUSES = new Set(['Potential', 'Scheduled']);

const KAYE_EMAIL = 'kaye@extendedwhanau.com';

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

/** Short job name for notifications, e.g. NMO-Signage or NMO Signage */
function jobShortLabel(project, separator = '-') {
  const name = String(project?.name || '').trim() || 'Untitled';
  const client = String(project?.client || '').trim();
  if (!client) return name;
  const sep = separator === ' ' ? ' ' : '-';
  return `${client}${sep}${name}`;
}

function projectStatus(project) {
  return String(project?.status || '').trim();
}

function isQuietStatus(project) {
  return QUIET_STATUSES.has(projectStatus(project));
}

function isCompleteStatus(project) {
  const s = projectStatus(project).toLowerCase();
  return s === 'complete' || s === 'completed';
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
  return `${marker?.id || ''}:${marker?.date || marker?.startDate || ''}:${String(marker?.title || '').trim()}`;
}

/** Job / phase / task dates only — check-in markers go to Calendar, not date Chat. */
function timelineFingerprint(project) {
  if (!project) return '';
  const phases = (project.milestones || []).map(phaseDateStamp).join('|');
  return `${project.startDate || ''}..${project.endDate || ''}::${phases}`;
}

function timelineDatesChanged(prev, next) {
  if (!prev || !next) return false;
  return timelineFingerprint(prev) !== timelineFingerprint(next);
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function parseIsoLocal(iso) {
  const m = String(iso || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** e.g. 24 Aug */
function formatShortDate(iso) {
  const d = parseIsoLocal(iso);
  if (!d) return '—';
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
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
  if (days === 1) return '1 Day away';
  if (days > 1) return `${days} Days away`;
  if (days === -1) return '1 Day overdue';
  return `${Math.abs(days)} Days overdue`;
}

function dateRangeLine(project) {
  const from = formatShortDate(project.startDate);
  const to = formatShortDate(project.endDate);
  return `From ${from}  →  ${to}`;
}

function dateChangeSummary(project) {
  const lines = [
    `DATE CHANGE: ${jobShortLabel(project)}`,
    dateRangeLine(project),
  ];
  const away = formatDaysAway(project.endDate);
  if (away) lines.push(away);
  return lines.join('\n');
}

function assignedSummary(project) {
  const lines = [
    `ADDED TO JOB: ${jobShortLabel(project)}`,
    dateRangeLine(project),
  ];
  const away = formatDaysAway(project.endDate);
  if (away) lines.push(away);
  return lines.join('\n');
}

function completedSummary(project) {
  const end = formatShortDate(project.endDate || project.completedAt);
  const lines = [`JOB COMPLETE: ${jobShortLabel(project)}`];
  if (end && end !== '—') lines.push(`Ended ${end}`);
  return lines.join('\n');
}

/** Calendar event title, e.g. NMO Signage: Client review */
function calendarEventTitle(project, milestoneTitle) {
  const milestone = String(milestoneTitle || '').trim() || 'Milestone';
  return `${jobShortLabel(project, ' ')}: ${milestone}`;
}

function newlyAddedMarkers(prev, next) {
  const before = new Map((prev?.markers || []).map((m) => [String(m.id || ''), m]));
  return (next?.markers || []).filter((m) => {
    const id = String(m?.id || '');
    if (!id || before.has(id)) return false;
    return Boolean(String(m.date || m.startDate || '').trim() && String(m.title || '').trim());
  });
}

function changedMarkers(prev, next) {
  const before = new Map((prev?.markers || []).map((m) => [String(m.id || ''), m]));
  return (next?.markers || []).filter((m) => {
    const id = String(m?.id || '');
    if (!id || !before.has(id)) return false;
    const old = before.get(id);
    const oldDate = String(old?.date || old?.startDate || '').trim();
    const newDate = String(m?.date || m?.startDate || '').trim();
    const oldTitle = String(old?.title || '').trim();
    const newTitle = String(m?.title || '').trim();
    return Boolean(newDate && newTitle && (oldDate !== newDate || oldTitle !== newTitle));
  });
}

/** Phase milestones (timeline blocks) with an end or start date. */
function newlyAddedPhases(prev, next) {
  const before = new Map((prev?.milestones || []).map((p) => [String(p.id || ''), p]));
  return (next?.milestones || []).filter((p) => {
    const id = String(p?.id || '');
    if (!id || before.has(id)) return false;
    const title = String(p.title || '').trim();
    const date = String(p.endDate || p.startDate || '').trim();
    return Boolean(title && date);
  });
}

function changedPhases(prev, next) {
  const before = new Map((prev?.milestones || []).map((p) => [String(p.id || ''), p]));
  return (next?.milestones || []).filter((p) => {
    const id = String(p?.id || '');
    if (!id || !before.has(id)) return false;
    const old = before.get(id);
    const oldDate = String(old?.endDate || old?.startDate || '').trim();
    const newDate = String(p?.endDate || p?.startDate || '').trim();
    const oldTitle = String(old?.title || '').trim();
    const newTitle = String(p?.title || '').trim();
    return Boolean(newDate && newTitle && (oldDate !== newDate || oldTitle !== newTitle));
  });
}

function phaseAsCalendarItem(phase) {
  return {
    id: phase.id,
    title: phase.title,
    date: phase.endDate || phase.startDate || '',
  };
}

/**
 * Chat:
 * 1. Added to a job — not while Potential / Scheduled
 * 2. Timeline dates changed — not while Potential / Scheduled
 * 3. Job marked Complete — always Kaye
 *
 * Calendar (via same webhook queue):
 * New / updated check-in milestones → each assignee’s Google Calendar
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

  const pushCalendar = (project, item, action) => {
    const date = String(item.date || item.startDate || item.endDate || '').trim();
    const title = String(item.title || '').trim();
    if (!date || !title) return;
    const recipients = emailsForProject(project, emailById);
    if (recipients.length === 0) return;
    const eventTitle = calendarEventTitle(project, title);
    push(
      project,
      'calendar_milestone',
      eventTitle,
      recipients,
      {
        action,
        marker_id: item.id,
        milestone_title: title,
        date,
        calendar_title: eventTitle,
      },
      { includeActor: true },
    );
  };

  const syncCalendars = (prev, next) => {
    newlyAddedMarkers(prev, next).forEach((marker) => {
      pushCalendar(next, marker, 'create');
    });
    changedMarkers(prev, next).forEach((marker) => {
      pushCalendar(next, marker, 'update');
    });
    newlyAddedPhases(prev, next).forEach((phase) => {
      pushCalendar(next, phaseAsCalendarItem(phase), 'create');
    });
    changedPhases(prev, next).forEach((phase) => {
      pushCalendar(next, phaseAsCalendarItem(phase), 'update');
    });
  };

  nextMap.forEach((next, id) => {
    const prev = prevMap.get(id);
    const quiet = isQuietStatus(next);

    if (!prev) {
      if (!quiet) {
        push(
          next,
          'assigned_to_job',
          assignedSummary(next),
          emailsForProject(next, emailById),
          { startDate: next.startDate, endDate: next.endDate },
        );
      }
      syncCalendars({ markers: [], milestones: [] }, next);
      return;
    }

    if (!isCompleteStatus(prev) && isCompleteStatus(next)) {
      push(
        next,
        'job_completed',
        completedSummary(next),
        [KAYE_EMAIL],
        { startDate: next.startDate, endDate: next.endDate },
        { includeActor: true },
      );
    }

    if (!quiet) {
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
    }

    syncCalendars(prev, next);
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
