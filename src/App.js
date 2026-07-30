import React, {
  useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback,
  forwardRef, useImperativeHandle, Fragment,
} from 'react';
import { createPortal } from 'react-dom';
import { v4 as uuidv4 } from 'uuid';
import './App.css';
import './gantt-timeline.css';
import {
  isSupabaseConfigured,
  loadWorkspacePayload,
  saveWorkspacePayload,
  fetchWorkspaceUpdatedAt,
  subscribeWorkspaceChanges,
} from './supabaseData';
import {
  getDevTimelinePreviewProjects,
  getDevOverviewPreviewProject,
  shouldUseDevTimelinePreview,
  shouldShowDevOverviewPreview,
} from './devTimelinePreview';
import {
  availablePhases,
  availableTasks,
  createCatalogPhase,
  createCatalogTask,
  getPhaseByKey,
  getPhaseByTitle,
  getTaskTitleForPhase,
  insertPhaseInCatalogOrder,
  sortPhasesByCatalog,
  sortTasksByCatalog,
  taskKeyFromTitle,
} from './milestoneCatalog';
import { importTimelineCsv } from './streamtimeCsvImport';
import {
  cascadeAfterPhaseEndChange,
  cascadeAfterTaskChange,
  daysFromEpoch,
  latestScheduleEnd,
} from './scheduleEngine';
import {
  ganttChartWidths,
  ganttDayCenterPct,
  ganttDayLeftPct,
  ganttInclusiveBarPct,
  ganttScrollLeftForTrackPct,
  ganttTotalDays,
  pointerDayFromTrack as pointerDayFromTrackGeometry,
} from './ganttGeometry';

// ── Designer palette (muted, contemporary fills + readable labels) ─────────────
const DESIGNER_COLORS = [
  { bg: '#F1EEEB', bar: '#9A8F86', text: '#45403C' },
  { bg: '#EDF1EE', bar: '#8B978C', text: '#383E3A' },
  { bg: '#EAEDF3', bar: '#8490A0', text: '#343A42' },
  { bg: '#F0EEEA', bar: '#9D968A', text: '#403E39' },
  { bg: '#EEECF1', bar: '#8D8794', text: '#38353D' },
];

function normalizeHex(hex) {
  if (!hex || typeof hex !== 'string') return '#8b978c';
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || !/^[0-9a-fA-F]+$/.test(h)) return '#8b978c';
  return `#${h.toLowerCase()}`;
}

function hexToRgb(hex) {
  const h = normalizeHex(hex).slice(1);
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return `#${[c(r), c(g), c(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function mixRgb(a, b, t) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/** Bar + derived soft bg + label text (for Gantt + cards). */
function paletteFromBar(barHex) {
  const bar = normalizeHex(barHex);
  const rgb = hexToRgb(bar);
  const white = { r: 255, g: 255, b: 255 };
  const bgRgb = mixRgb(rgb, white, 0.78);
  const textRgb = {
    r: rgb.r * 0.28 + 28,
    g: rgb.g * 0.28 + 28,
    b: rgb.b * 0.28 + 28,
  };
  return {
    bg: rgbToHex(bgRgb.r, bgRgb.g, bgRgb.b),
    bar,
    text: rgbToHex(textRgb.r, textRgb.g, textRgb.b),
  };
}

function getDesignerPalette(designer) {
  if (!designer) return { bg: '#EEE', bar: '#CCC', text: '#888' };
  const barSource = designer.colorHex
    ? designer.colorHex
    : DESIGNER_COLORS[designer.colorIdx % DESIGNER_COLORS.length].bar;
  return paletteFromBar(barSource);
}

function designerWithNormalizedColor(d) {
  if (!d) return d;
  const idx = typeof d.colorIdx === 'number' ? d.colorIdx % DESIGNER_COLORS.length : 0;
  if (d.colorHex && String(d.colorHex).trim().length > 0) {
    return { ...d, colorHex: normalizeHex(d.colorHex), colorIdx: idx };
  }
  return { ...d, colorHex: normalizeHex(DESIGNER_COLORS[idx].bar), colorIdx: idx };
}

const STATUS_OPTIONS = [
  'Scheduled',
  'Ready to Start',
  'In Progress',
  'In Review',
  'Complete',
];

/** Row dot colours — blue / purple / green / amber / grey. */
const STATUS_ACCENT = {
  Scheduled: '#4F7FD9',
  'Ready to Start': '#8B6FD6',
  'In Progress': '#22A45A',
  'In Review': '#E5A50A',
  Complete: '#9CA3AF',
};

const LEGACY_STATUS_MAP = {
  'Waiting on Client': 'In Review',
  'Ready to Print': 'In Progress',
  Schedule: 'Scheduled',
  'Scheduled - Awaiting start': 'Scheduled',
  'Awaiting start': 'Scheduled',
  'Ready to Start - content received': 'Ready to Start',
  'Content received': 'Ready to Start',
};

function normalizeProjectStatus(status) {
  if (STATUS_OPTIONS.includes(status)) return status;
  if (LEGACY_STATUS_MAP[status]) return LEGACY_STATUS_MAP[status];
  return 'In Progress';
}

const PIPELINE_STATUSES = new Set(['Scheduled', 'Ready to Start']);

const CATEGORY_OPTIONS = ['priority', 'secondary'];

const CATEGORY_LABELS = {
  priority: 'Priority',
  secondary: 'Secondary',
};

function normalizeProjectCategory(category) {
  if (category === 'background' || category === 'pro-bono') return 'secondary';
  if (CATEGORY_OPTIONS.includes(category)) return category;
  return 'secondary';
}

function formatCategoryForDisplay(category) {
  return CATEGORY_LABELS[normalizeProjectCategory(category)] || CATEGORY_LABELS.priority;
}

function getProjectCategory(project) {
  return normalizeProjectCategory(project?.priority);
}

/** Upcoming / pre–in-progress — listed under Schedule, hidden from main Projects. */
function isPipelineStatus(status) {
  return PIPELINE_STATUSES.has(normalizeProjectStatus(status));
}

/** Sentence case labels for sheet-style status display */
function formatStatusForDisplay(status) {
  const s = normalizeProjectStatus(status);
  if (s === 'In Progress') return 'In progress';
  if (s === 'In Review') return 'In review';
  return s;
}

function statusAccent(status) {
  return STATUS_ACCENT[status] || '#A8A8A8';
}

/** Stable list of designer ids (any number, deduped); supports legacy `designerId` only. */
function getProjectDesignerIds(project) {
  if (!project) return [];
  const raw = Array.isArray(project.designerIds) ? project.designerIds : [];
  const fromArr = [...new Set(raw.filter((id) => id != null && String(id).trim() !== ''))];
  if (fromArr.length > 0) return fromArr;
  const leg = project.designerId != null && String(project.designerId).trim() !== '' ? project.designerId : '';
  return leg ? [leg] : [];
}

function normalizeProjectDesignersOnProject(p) {
  const ids = getProjectDesignerIds(p);
  return {
    ...p,
    designerIds: ids,
    designerId: ids[0] || '',
  };
}

function getProjectDesigners(project, designers) {
  return getProjectDesignerIds(project)
    .map((id) => designers.find((d) => d.id === id))
    .filter(Boolean);
}

/** `maxVisible` truncates with a +N badge (for dense rows). Omit to show everyone. */
function DesignerAvatarStack({ designers: stackDesigners, size = 28, className = '', maxVisible }) {
  if (!stackDesigners?.length) return null;
  const limit = maxVisible != null && Number.isFinite(maxVisible) ? maxVisible : stackDesigners.length;
  const visible = stackDesigners.slice(0, Math.max(0, limit));
  const extra = stackDesigners.length - visible.length;
  const topZ = visible.length + (extra > 0 ? 1 : 0);
  return (
    <div className={['designer-avatar-stack', className].filter(Boolean).join(' ')}>
      {visible.map((d, i) => (
        <span
          key={d.id}
          className="designer-avatar-stack__slot"
          style={{ zIndex: i + 1 }}
        >
          <Avatar designer={d} size={size} />
        </span>
      ))}
      {extra > 0 ? (
        <span
          className="designer-avatar-stack__slot designer-avatar-stack__more"
          style={{ zIndex: topZ }}
          title={`${extra} more`}
          aria-label={`${extra} more designers`}
        >
          <span
            className="designer-avatar-stack__more-inner"
            style={{
              width: size,
              height: size,
              fontSize: Math.max(10, Math.round(size * 0.34)),
            }}
          >
            +{extra}
          </span>
        </span>
      ) : null}
    </div>
  );
}

// ── Sample data ───────────────────────────────────────────────────────────────
const SAMPLE_DESIGNERS = [
  { id: 'd1', name: 'Tyrone', colorIdx: 0 },
  { id: 'd2', name: 'Max', colorIdx: 1 },
  { id: 'd3', name: 'Eva', colorIdx: 2 },
  { id: 'd4', name: 'Shaun', colorIdx: 3 },
  { id: 'd5', name: 'Poi', colorIdx: 4 },
];

/** Bump when default roster names/order change — triggers one-time sync for built-in ids (d1–d5). */
const TEAM_SCHEMA_VERSION = '2';

const SAMPLE_DESIGNER_BY_ID = Object.fromEntries(SAMPLE_DESIGNERS.map(d => [d.id, d]));

/** Replace cached team when it matches old built-in samples so names stay current. */
function normalizeDesignersFromStorage(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) return SAMPLE_DESIGNERS;
  const names = parsed.map(d => (d && d.name ? String(d.name).trim().toLowerCase() : ''));
  const isAlexJordanSam =
    parsed.length === 3 &&
    names[0] === 'alex' &&
    names[1] === 'jordan' &&
    names[2] === 'sam';
  const isOldPoiShaunOrder =
    parsed.length === 5 &&
    names[0] === 'tyrone' &&
    names[1] === 'max' &&
    names[2] === 'eva' &&
    names[3] === 'poi' &&
    names[4] === 'shaun';
  if (isAlexJordanSam || isOldPoiShaunOrder) return SAMPLE_DESIGNERS;
  return parsed;
}

/** Once per schema version: align stored d1–d5 with SAMPLE_DESIGNERS (custom-added designers unchanged). */
function applyTeamSchemaVersion(list) {
  try {
    if (localStorage.getItem('studio_team_schema') === TEAM_SCHEMA_VERSION) return list;
    const next = list.map((d) => {
      const canon = SAMPLE_DESIGNER_BY_ID[d.id];
      if (!canon) return d;
      const ci = canon.colorIdx % DESIGNER_COLORS.length;
      return {
        ...d,
        name: canon.name,
        colorIdx: canon.colorIdx,
        colorHex: normalizeHex(DESIGNER_COLORS[ci].bar),
      };
    });
    localStorage.setItem('studio_team_schema', TEAM_SCHEMA_VERSION);
    localStorage.setItem('studio_designers', JSON.stringify(next));
    return next;
  } catch {
    return list;
  }
}

function loadDesignersFromStorage() {
  try {
    const raw = localStorage.getItem('studio_designers');
    let list = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(list) || list.length === 0) list = [...SAMPLE_DESIGNERS];
    else list = normalizeDesignersFromStorage(list);
    return applyTeamSchemaVersion(list).map(designerWithNormalizedColor);
  } catch {
    return SAMPLE_DESIGNERS.map(designerWithNormalizedColor);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseISODateLocal(str) {
  const [y, m, day] = str.split('-').map(Number);
  return new Date(y, m - 1, day, 12, 0, 0, 0);
}

/** Weekdays (Mon–Fri) strictly after `from`, through `to` inclusive. */
function workingDaysAfterThrough(from, to) {
  let count = 0;
  const cur = new Date(from);
  cur.setDate(cur.getDate() + 1);
  cur.setHours(12, 0, 0, 0);
  const end = new Date(to);
  end.setHours(12, 0, 0, 0);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow >= 1 && dow <= 5) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/** { kind, days } — days are Mon–Fri only; compares using local calendar dates. */
function workingDayCountdown(endDateStr) {
  const due = parseISODateLocal(endDateStr);
  const now = new Date();
  const todayD = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  if (due < todayD) {
    return { kind: 'overdue', days: workingDaysAfterThrough(due, todayD) };
  }
  if (due.getTime() === todayD.getTime()) {
    return { kind: 'today', days: 0 };
  }
  return { kind: 'upcoming', days: workingDaysAfterThrough(todayD, due) };
}

/** Countdown text for due row: working days (Mon–Fri), lowercase. */
function formatDueDaysSegment(endDateStr) {
  const { kind, days } = workingDayCountdown(endDateStr);
  if (kind === 'today') return 'today';
  if (kind === 'overdue') {
    return days === 1 ? '1 day overdue' : `${days} days overdue`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

function formatDueDateLong(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** e.g. "14 Days", "Today" — same scale as due date in project cards */
function formatDueDaysDisplay(endDateStr) {
  if (!endDateStr) return '';
  const { kind, days } = workingDayCountdown(endDateStr);
  if (kind === 'today') return 'Today';
  if (kind === 'overdue') {
    return days === 1 ? '1 day overdue' : `${days} days overdue`;
  }
  return days === 1 ? '1 Day' : `${days} Days`;
}

/** Day + month for marker labels, e.g. "29 July". */
function formatMarkerDateLabel(str) {
  if (!str) return '';
  const d = new Date(`${str}T12:00:00Z`);
  return d.toLocaleDateString('en-NZ', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  });
}

/** Short date for compact UI, e.g. "7 Jul 26". */
function formatMilestoneDateShort(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: '2-digit' });
}

/** Phase dates in the project card, e.g. "7 Jul 2026". */
function formatPhaseDateMedium(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Task dates in the project card, e.g. "7 Jul". */
function formatTaskDateShort(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

/** Schedule list cards — e.g. "17.01.26". */
function formatScheduleStartDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  return `${day}.${month}.${year}`;
}

/** Project-level date visuals, e.g. "7 July 2026 — 13 February 2027". */
function formatMilestoneDateRangeDisplay(start, end) {
  if (!start && !end) return '';
  if (start && end) return `${formatDueDateLong(start)} — ${formatDueDateLong(end)}`;
  return formatDueDateLong(start || end);
}

/** Phase date ranges in the project card, e.g. "7 Jul 2026 – 11 Aug 2026". */
function formatPhaseDateRangeDisplay(start, end) {
  if (!start && !end) return '';
  if (start && end) return `${formatPhaseDateMedium(start)} – ${formatPhaseDateMedium(end)}`;
  return formatPhaseDateMedium(start || end);
}

/** Task date ranges in the project card, e.g. "7 Jul – 11 Aug". */
function formatTaskDateRangeDisplay(start, end) {
  if (!start && !end) return '';
  if (start && end) return `${formatTaskDateShort(start)} – ${formatTaskDateShort(end)}`;
  return formatTaskDateShort(start || end);
}

function formatMilestoneDateRange(start, end) {
  if (!start && !end) return '';
  if (start && end) return `${formatMilestoneDateShort(start)}—${formatMilestoneDateShort(end)}`;
  return formatMilestoneDateShort(start || end);
}

const MIN_MILESTONE_WEEKS = 1;
const MAX_MILESTONE_WEEKS = 52;

function normalizeDurationWeeks(value, fallback = 2) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < MIN_MILESTONE_WEEKS) return fallback;
  return Math.min(MAX_MILESTONE_WEEKS, parsed);
}

function calendarDaysInclusive(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  return daysFromEpoch(endDate) - daysFromEpoch(startDate) + 1;
}

function inferDurationWeeksFromDates(startDate, endDate) {
  const days = calendarDaysInclusive(startDate, endDate);
  if (days <= 0) return 2;
  return Math.max(1, Math.round(days / 7));
}

function formatPhaseWeekLabel(weeks) {
  const w = Number(weeks) || 1;
  return w === 1 ? '1 Week' : `${w} Weeks`;
}

function resolvePhaseSchedule(phase, suggestedStart) {
  const fallbackStart = suggestedStart || today();
  const tasks = phase.tasks || [];
  if (phase.scheduleMode === 'custom') {
    const start = phase.startDate || fallbackStart;
    const end = phase.endDate && phase.endDate >= start
      ? phase.endDate
      : addDays(start, 6);
    return {
      ...phase,
      scheduleMode: 'custom',
      durationWeeks: phase.durationWeeks ?? inferDurationWeeksFromDates(start, end),
      startDate: start,
      endDate: end,
      tasks,
    };
  }
  const weeks = normalizeDurationWeeks(phase.durationWeeks, 2);
  const startDate = phase.startDate || fallbackStart;
  const endDate = addDays(startDate, weeks * 7 - 1);
  return {
    ...phase,
    scheduleMode: 'weeks',
    durationWeeks: weeks,
    startDate,
    endDate,
    tasks,
  };
}

function latestPhaseEndDate(phases, { excludePhaseId = null, requireStartDate = false } = {}) {
  return (phases || []).reduce((max, phase) => {
    if (excludePhaseId && phase.id === excludePhaseId) return max;
    if (requireStartDate && !phase.startDate) return max;
    if (!phase.endDate) return max;
    return !max || phase.endDate > max ? phase.endDate : max;
  }, '');
}

function suggestedStartAfterExistingPhases(phases, anchor, excludePhaseId = null) {
  const latestEnd = latestPhaseEndDate(phases, { excludePhaseId, requireStartDate: true });
  return latestEnd ? addDays(latestEnd, 1) : (anchor || today());
}

function resolveMilestoneSchedule(projectStartDate, phases) {
  const anchor = projectStartDate || today();
  const resolved = [];
  for (const phase of (phases || [])) {
    let suggestedStart;
    if (phase.startDate) {
      suggestedStart = phase.startDate;
    } else {
      const latestEndFromResolved = latestPhaseEndDate(resolved);
      const latestEndFromScheduled = latestPhaseEndDate(phases, {
        excludePhaseId: phase.id,
        requireStartDate: true,
      });
      const latestEnd = [latestEndFromResolved, latestEndFromScheduled]
        .filter(Boolean)
        .sort()
        .pop() || '';
      suggestedStart = latestEnd ? addDays(latestEnd, 1) : anchor;
    }
    resolved.push(resolvePhaseSchedule(phase, suggestedStart));
  }
  const bounds = milestoneScheduleBounds(resolved);
  return {
    phases: resolved,
    startDate: anchor,
    endDate: bounds.endDate || anchor,
  };
}

function pickProjectEndDate(explicitEnd, savedEnd, resolvedEnd) {
  if (explicitEnd) return explicitEnd;
  if (savedEnd && savedEnd >= resolvedEnd) return savedEnd;
  return resolvedEnd;
}

function isoFromTimelineDay(dayNum, anchorIso) {
  const anchorDay = daysFromEpoch(anchorIso || today());
  return addDays(anchorIso || today(), dayNum - anchorDay);
}

function pointerDayFromTrack(clientX, track, minDay, totalDays) {
  const rect = track.getBoundingClientRect();
  return pointerDayFromTrackGeometry(
    clientX,
    rect.width,
    rect.left,
    minDay,
    totalDays,
  );
}

function applyProjectMilestoneUpdate(project, milestones, patch = {}) {
  const kickoff = patch.startDate ?? project.startDate ?? today();
  const { phases, startDate, endDate: resolvedEnd } = resolveMilestoneSchedule(kickoff, milestones);
  const endDate = pickProjectEndDate(patch.endDate, project.endDate, resolvedEnd);
  return { ...project, ...patch, milestones: phases, startDate, endDate };
}

function updateProjectPhaseDurationWeeks(project, phaseId, durationWeeks) {
  if (!project?.milestones?.length) return project;
  const weeks = normalizeDurationWeeks(durationWeeks, MIN_MILESTONE_WEEKS);
  const oldPhase = project.milestones.find((ph) => ph.id === phaseId);
  const oldEnd = oldPhase?.endDate || '';
  const milestones = project.milestones.map((ph) => (
    ph.id === phaseId
      ? { ...ph, scheduleMode: 'weeks', durationWeeks: weeks }
      : ph
  ));
  const next = applyProjectMilestoneUpdate(project, milestones);
  if (!project.linkedSchedule) return next;
  const newEnd = next.milestones.find((ph) => ph.id === phaseId)?.endDate || '';
  const cascaded = cascadeAfterPhaseEndChange(
    next.milestones,
    next.markers || project.markers,
    phaseId,
    oldEnd,
    newEnd,
  );
  const resolvedEnd = latestScheduleEnd(cascaded.phases) || next.endDate;
  return {
    ...next,
    milestones: cascaded.phases,
    markers: cascaded.markers,
    endDate: pickProjectEndDate('', next.endDate, resolvedEnd),
  };
}

function updateProjectPhaseEndDate(project, phaseId, endDate) {
  if (!project?.milestones?.length) return project;
  const oldPhase = project.milestones.find((ph) => ph.id === phaseId);
  const oldEnd = oldPhase?.endDate || '';
  const milestones = project.milestones.map((ph) => {
    if (ph.id !== phaseId) return ph;
    const start = ph.startDate || project.startDate || today();
    const end = endDate && endDate >= start ? endDate : start;
    return {
      ...ph,
      scheduleMode: 'custom',
      durationWeeks: null,
      startDate: start,
      endDate: end,
    };
  });
  const next = applyProjectMilestoneUpdate(project, milestones);
  if (!project.linkedSchedule) return next;
  const newEnd = next.milestones.find((ph) => ph.id === phaseId)?.endDate || '';
  const cascaded = cascadeAfterPhaseEndChange(
    next.milestones,
    next.markers || project.markers,
    phaseId,
    oldEnd,
    newEnd,
  );
  const resolvedEnd = latestScheduleEnd(cascaded.phases) || next.endDate;
  return {
    ...next,
    milestones: cascaded.phases,
    markers: cascaded.markers,
    endDate: pickProjectEndDate('', next.endDate, resolvedEnd),
  };
}

function updateProjectTaskDates(project, phaseId, taskId, patch) {
  if (!project?.milestones?.length) return project;
  const phase = project.milestones.find((ph) => ph.id === phaseId);
  const previous = (phase?.tasks || []).find((task) => task.id === taskId);
  if (!phase || !previous) return project;
  const updatedTask = {
    ...previous,
    ...normalizeTaskDates({ ...previous, ...patch }),
  };

  if (!project.linkedSchedule) {
    const milestones = project.milestones.map((ph) => {
      if (ph.id !== phaseId) return ph;
      return {
        ...ph,
        tasks: (ph.tasks || []).map((task) => (
          task.id === taskId ? updatedTask : task
        )),
      };
    });
    return applyProjectMilestoneUpdate(project, milestones);
  }

  const cascaded = cascadeAfterTaskChange(
    project.milestones,
    project.markers,
    phaseId,
    taskId,
    updatedTask,
    previous.endDate || previous.startDate || '',
  );
  const resolvedEnd = latestScheduleEnd(cascaded.phases) || project.endDate;
  return {
    ...project,
    milestones: cascaded.phases,
    markers: cascaded.markers,
    endDate: pickProjectEndDate('', project.endDate, resolvedEnd),
  };
}

function updateProjectMarker(project, markerId, patch = {}) {
  const markers = (project.markers || []).map((marker) => (
    marker.id === markerId ? { ...marker, ...patch } : marker
  ));
  return {
    ...project,
    markers: normalizeProjectMarkers(markers, { requireTitle: false }),
  };
}

function updateProjectMarkerDate(project, markerId, date) {
  return updateProjectMarker(project, markerId, { date: date || '' });
}

function updateProjectPhaseCustomDates(project, phaseId, patch) {
  if (!project?.milestones?.length) return project;
  const oldPhase = project.milestones.find((ph) => ph.id === phaseId);
  const oldEnd = oldPhase?.endDate || '';
  const milestones = project.milestones.map((ph) => {
    if (ph.id !== phaseId) return ph;
    return {
      ...ph,
      ...patch,
      scheduleMode: 'custom',
      durationWeeks: null,
    };
  });
  const next = applyProjectMilestoneUpdate(project, milestones);
  if (!project.linkedSchedule) return next;
  const newEnd = next.milestones.find((ph) => ph.id === phaseId)?.endDate || '';
  const cascaded = cascadeAfterPhaseEndChange(
    next.milestones,
    next.markers || project.markers,
    phaseId,
    oldEnd,
    newEnd,
  );
  const resolvedEnd = latestScheduleEnd(cascaded.phases) || next.endDate;
  return {
    ...next,
    milestones: cascaded.phases,
    markers: cascaded.markers,
    endDate: pickProjectEndDate('', next.endDate, resolvedEnd),
  };
}

function withLinkedSchedule(project) {
  return { ...project, linkedSchedule: true };
}

function shiftTaskDates(tasks, deltaDays) {
  if (!deltaDays) return tasks || [];
  return (tasks || []).map((task) => {
    if (!task?.startDate && !task?.endDate) return task;
    const startDate = task.startDate ? addDays(task.startDate, deltaDays) : '';
    const endDate = task.endDate
      ? addDays(task.endDate, deltaDays)
      : startDate;
    return { ...task, startDate, endDate };
  });
}

function updateProjectPhaseStartDate(project, phaseId, startDate) {
  if (!project?.milestones?.length) return project;
  const moving = project.milestones.find((ph) => ph.id === phaseId);
  const prevStart = moving?.startDate || project.startDate || today();
  const nextStart = startDate || prevStart;
  const deltaDays = daysFromEpoch(nextStart) - daysFromEpoch(prevStart);
  const phaseKey = moving?.phaseKey || '';

  const milestones = project.milestones.map((ph) => {
    if (ph.id !== phaseId) return ph;
    if (ph.scheduleMode === 'custom') {
      const prevEnd = ph.endDate && ph.endDate >= prevStart
        ? ph.endDate
        : addDays(prevStart, 6);
      return {
        ...ph,
        startDate: nextStart,
        endDate: addDays(prevEnd, deltaDays),
        tasks: shiftTaskDates(ph.tasks, deltaDays),
      };
    }
    return {
      ...ph,
      startDate: nextStart,
      tasks: shiftTaskDates(ph.tasks, deltaDays),
    };
  });
  const next = applyProjectMilestoneUpdate(project, milestones);
  if (!deltaDays || !phaseKey) return next;
  return {
    ...next,
    markers: (project.markers || []).map((marker) => {
      if (marker.phaseKey !== phaseKey || !marker.date) return marker;
      return { ...marker, date: addDays(marker.date, deltaDays) };
    }),
  };
}

function applyMilestoneScheduleToForm(form, patch = {}) {
  const milestones = patch.milestones ?? form.milestones ?? [];
  const kickoff = patch.startDate ?? form.startDate ?? today();
  if (!milestones.length) {
    return { ...form, ...patch };
  }
  const { phases, startDate, endDate: resolvedEnd } = resolveMilestoneSchedule(kickoff, milestones);
  const endDate = pickProjectEndDate(patch.endDate, form.endDate, resolvedEnd);
  return { ...form, ...patch, milestones: phases, startDate, endDate };
}

function applyProjectDatePatch(form, patch) {
  const nextPatch = patch.endDate != null && patch.startDate == null
    ? { endDate: patch.endDate }
    : patch;
  if ((form.milestones || []).length > 0) {
    return applyMilestoneScheduleToForm(form, nextPatch);
  }
  return { ...form, ...nextPatch };
}

function milestoneScheduleBounds(phases) {
  const dates = [];
  phases.forEach((phase) => {
    if (phase.startDate) dates.push(phase.startDate);
    if (phase.endDate) dates.push(phase.endDate);
    (phase.tasks || []).forEach((task) => {
      if (task.startDate) dates.push(task.startDate);
      if (task.endDate) dates.push(task.endDate);
    });
  });
  dates.sort();
  return { startDate: dates[0] || '', endDate: dates[dates.length - 1] || '' };
}

function normalizeTaskDates(task) {
  const startDate = task.startDate || '';
  const endDate = task.endDate && (!startDate || task.endDate >= startDate)
    ? task.endDate
    : startDate;
  if (!startDate) {
    return { startDate: '', endDate: '' };
  }
  return { startDate, endDate: endDate || startDate };
}

function normalizeMilestonePhase(phase) {
  const catalogEntry = getPhaseByKey(phase.phaseKey) || getPhaseByTitle(phase.title);
  if (!catalogEntry) return null;

  const startDate = phase.startDate || '';
  const endDate = phase.endDate || '';
  let scheduleMode = phase.scheduleMode === 'custom' ? 'custom' : 'weeks';
  let durationWeeks = phase.durationWeeks;

  if (scheduleMode === 'weeks') {
    const parsed = Number(durationWeeks);
    if (Number.isFinite(parsed) && parsed >= MIN_MILESTONE_WEEKS) {
      durationWeeks = normalizeDurationWeeks(parsed, 2);
    } else if (startDate && endDate) {
      durationWeeks = normalizeDurationWeeks(inferDurationWeeksFromDates(startDate, endDate), 2);
      scheduleMode = 'weeks';
    } else {
      durationWeeks = 2;
      scheduleMode = 'weeks';
    }
  } else {
    durationWeeks = null;
  }

  const tasks = (Array.isArray(phase.tasks) ? phase.tasks : [])
    .map((task) => {
      const matchedTitle = getTaskTitleForPhase(
        catalogEntry.key,
        task.taskKey || task.title,
      );
      if (!matchedTitle) return null;
      const { startDate: taskStart, endDate: taskEnd } = normalizeTaskDates(task);
      return {
        id: task.id || uuidv4(),
        taskKey: taskKeyFromTitle(matchedTitle),
        title: matchedTitle,
        startDate: taskStart,
        endDate: taskEnd,
      };
    })
    .filter(Boolean);

  return {
    id: phase.id || uuidv4(),
    phaseKey: catalogEntry.key,
    title: catalogEntry.title,
    scheduleMode,
    durationWeeks: scheduleMode === 'weeks' ? durationWeeks : null,
    startDate,
    endDate,
    tasks: sortTasksByCatalog(catalogEntry.key, tasks),
  };
}

function normalizeProjectMarker(marker, { requireTitle = true } = {}) {
  if (!marker) return null;
  const title = String(marker.title || '').trim();
  const date = marker.date || marker.startDate || '';
  if (!date) return null;
  if (requireTitle && !title) return null;
  const phase = getPhaseByKey(marker.phaseKey);
  return {
    id: marker.id || uuidv4(),
    title,
    date,
    phaseKey: phase?.key || '',
    linkedTo: String(marker.linkedTo || '').trim(),
  };
}

function sortProjectMarkers(markers) {
  return (markers || []).slice().sort((a, b) => (
    (a.date || '').localeCompare(b.date || '')
    || (a.title || '').localeCompare(b.title || '')
  ));
}

function normalizeProjectMarkers(markers, options = {}) {
  return sortProjectMarkers(
    (Array.isArray(markers) ? markers : [])
      .map((marker) => normalizeProjectMarker(marker, options))
      .filter(Boolean),
  );
}

function normalizeProjectMilestones(p) {
  const raw = Array.isArray(p.milestones) ? p.milestones : [];
  const milestones = sortPhasesByCatalog(
    raw.map((phase) => normalizeMilestonePhase(phase)).filter(Boolean),
  );
  const markers = normalizeProjectMarkers(p.markers);
  const linkedSchedule = Boolean(p.linkedSchedule);
  const { milestonesEnabled, ...rest } = p;
  if (!milestones.length) {
    return { ...rest, milestones, markers, linkedSchedule };
  }
  const kickoff = rest.startDate || today();
  const savedEnd = rest.endDate || '';
  const { phases, startDate, endDate: resolvedEnd } = resolveMilestoneSchedule(kickoff, milestones);
  const endDate = pickProjectEndDate('', savedEnd, resolvedEnd);
  return { ...rest, milestones: phases, markers, linkedSchedule, startDate, endDate };
}

function projectHasMilestones(project) {
  return Boolean(project.milestones?.length > 0);
}

function emptyProjectMarker() {
  return {
    id: uuidv4(),
    title: '',
    date: today(),
    phaseKey: '',
    linkedTo: '',
  };
}

function addDays(str, n) {
  const d = parseISODateLocal(str);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
/** Studio calendar “today” in NZ — keeps the today line correct regardless of browser TZ. */
function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

function buildSampleProjects() {
  const t = today();
  return [
    {
      id: 'p1', name: 'Annual Report', client: 'Meridian Co.',
      designerId: 'd1', designerIds: ['d1', 'd2'], status: 'In Progress', priority: 'priority',
      startDate: addDays(t, -14), endDate: addDays(t, 21),
      notes: 'Cover options due first.',
    },
    {
      id: 'p2', name: 'Brand Identity', client: 'Volta Studio',
      designerId: 'd2', status: 'In Review', priority: 'priority',
      startDate: addDays(t, -7), endDate: addDays(t, 28),
      notes: 'Awaiting logo feedback.',
    },
    {
      id: 'p3', name: 'Packaging Suite', client: 'Bloom Foods',
      designerId: 'd3', status: 'Scheduled', priority: 'secondary',
      startDate: addDays(t, 3), endDate: addDays(t, 24),
      notes: '',
    },
    {
      id: 'p4', name: 'Campaign Collateral', client: 'Meridian Co.',
      designerId: 'd5', status: 'In Progress', priority: 'secondary',
      startDate: addDays(t, -10), endDate: addDays(t, 14),
      notes: 'Three formats needed.',
    },
    {
      id: 'p5', name: 'Matarongo Campaign', client: 'Matarongo',
      designerId: 'd1', designerIds: ['d1', 'd3'], status: 'In Progress', priority: 'priority',
      startDate: '2026-07-07', endDate: '2027-02-03',
      notes: 'Long-form campaign with phased delivery.',
      milestones: [
        {
          id: 'ms1',
          phaseKey: 'strategy',
          title: 'Strategy',
          scheduleMode: 'weeks',
          durationWeeks: 8,
          startDate: '2026-07-07',
          endDate: '2026-08-27',
          tasks: [
            { id: 'ms1t1', taskKey: 'discovery', title: 'Discovery' },
            { id: 'ms1t2', taskKey: 'research', title: 'Research' },
          ],
        },
        {
          id: 'ms2',
          phaseKey: 'design',
          title: 'Design',
          scheduleMode: 'weeks',
          durationWeeks: 7,
          startDate: '2026-08-28',
          endDate: '2026-10-16',
          tasks: [
            { id: 'ms2t1', taskKey: 'concept', title: 'Concept' },
            { id: 'ms2t2', taskKey: 'refinement', title: 'Refinement' },
          ],
        },
      ],
    },
    {
      id: 'p6', name: 'Q4 Report', client: 'North & Co.',
      designerId: 'd2', status: 'Ready to Start', priority: 'secondary',
      startDate: addDays(t, 14), endDate: addDays(t, 45),
      notes: 'Awaiting client content.',
    },
    {
      id: 'p7', name: 'Product Launch', client: 'Studio Nine',
      designerId: 'd4', status: 'Scheduled', priority: 'secondary',
      startDate: addDays(t, 28), endDate: addDays(t, 70),
      notes: '',
    },
    {
      id: 'p8', name: 'Annual Gala', client: 'Harbour Trust',
      designerId: 'd3', designerIds: ['d3', 'd5'], status: 'Scheduled', priority: 'priority',
      startDate: addDays(t, 56), endDate: addDays(t, 98),
      notes: 'Invitation suite + signage.',
    },
    {
      id: 'p9', name: 'Brand Guidelines', client: 'Volta Studio',
      designerId: 'd1', status: 'Scheduled', priority: 'secondary',
      startDate: addDays(t, 90), endDate: addDays(t, 130),
      notes: '',
    },
  ];
}

// ── Components ────────────────────────────────────────────────────────────────

function Avatar({ designer, size = 32 }) {
  if (!designer) return null;
  const c = getDesignerPalette(designer);
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: c.bar, color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 600, flexShrink: 0,
      letterSpacing: '-0.02em',
    }}>
      {designer.name.slice(0, 1)}
    </div>
  );
}

// ── Project Modal ─────────────────────────────────────────────────────────────
// ── Milestones panel (project modal) ─────────────────────────────────────────

const CALENDAR_WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function isoDateParts(y, monthIndex, day) {
  return `${y}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function buildCalendarCells(viewYear, viewMonth) {
  const first = new Date(viewYear, viewMonth, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();
  const cells = [];

  for (let i = 0; i < 42; i += 1) {
    let day;
    let y = viewYear;
    let m = viewMonth;
    let inMonth = true;

    if (i < startOffset) {
      day = prevMonthDays - startOffset + i + 1;
      m -= 1;
      if (m < 0) { m = 11; y -= 1; }
      inMonth = false;
    } else if (i >= startOffset + daysInMonth) {
      day = i - startOffset - daysInMonth + 1;
      m += 1;
      if (m > 11) { m = 0; y += 1; }
      inMonth = false;
    } else {
      day = i - startOffset + 1;
    }

    cells.push({ iso: isoDateParts(y, m, day), day, inMonth });
  }
  return cells;
}

function DateRangeBubbleCalendar({
  anchorRef,
  open,
  startDate,
  endDate,
  onSave,
  onClose,
  label = 'Choose dates',
  endDateOnly = false,
  rangeFormat = 'long',
  singleDate = false,
}) {
  const popoverRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd, setDraftEnd] = useState('');
  const [datesCleared, setDatesCleared] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDatesCleared(false);
    if (singleDate) {
      const day = startDate || endDate || '';
      setDraftStart(day);
      setDraftEnd(day);
      const base = day || today();
      const d = parseISODateLocal(base);
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
      return;
    }
    setDraftStart(startDate || '');
    setDraftEnd(endDateOnly ? (endDate || startDate || '') : (endDate || ''));
    const base = startDate || endDate || today();
    const d = parseISODateLocal(base);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  }, [open, startDate, endDate, endDateOnly, singleDate]);

  useLayoutEffect(() => {
    if (!open || !anchorRef?.current || !popoverRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const pop = popoverRef.current.getBoundingClientRect();
    const gap = 6;
    let top = anchor.bottom + gap;
    let left = anchor.left;

    if (left + pop.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - pop.width - 8);
    }
    if (left < 8) left = 8;
    if (top + pop.height > window.innerHeight - 8) {
      top = Math.max(8, anchor.top - pop.height - gap);
    }

    setPos({ top, left });
  }, [open, viewYear, viewMonth, draftStart, draftEnd, anchorRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (popoverRef.current?.contains(e.target)) return;
      if (anchorRef.current?.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, anchorRef]);

  const cells = useMemo(
    () => buildCalendarCells(viewYear, viewMonth),
    [viewYear, viewMonth],
  );

  const monthLabel = useMemo(
    () => new Date(viewYear, viewMonth, 1).toLocaleDateString('en-NZ', { month: 'long', year: 'numeric' }),
    [viewYear, viewMonth],
  );

  const shiftMonth = (delta) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  const pickingStartAfterClear = endDateOnly && datesCleared && !draftStart;
  const lockedStartMode = !singleDate && endDateOnly && Boolean(draftStart) && !pickingStartAfterClear;

  const handleDayClick = (iso) => {
    if (singleDate) {
      setDraftStart(iso);
      setDraftEnd(iso);
      return;
    }
    if (pickingStartAfterClear) {
      setDraftStart(iso);
      setDraftEnd('');
      return;
    }
    if (lockedStartMode) {
      setDraftEnd(iso >= draftStart ? iso : draftStart);
      return;
    }
    if (!draftStart || (draftStart && draftEnd)) {
      setDraftStart(iso);
      setDraftEnd('');
      return;
    }
    if (iso < draftStart) {
      setDraftStart(iso);
      setDraftEnd('');
      return;
    }
    setDraftEnd(iso);
  };

  const handleClear = () => {
    setDatesCleared(true);
    setDraftStart('');
    setDraftEnd('');
  };

  const handleSave = () => {
    if (singleDate) {
      if (!draftStart) return;
      onSave({ date: draftStart, startDate: draftStart, endDate: draftStart });
      return;
    }
    if (!draftStart || !draftEnd) return;
    if (endDateOnly && !datesCleared) {
      onSave({ endDate: draftEnd });
      return;
    }
    onSave({ startDate: draftStart, endDate: draftEnd });
  };

  if (!open) return null;

  const formatRangeLabel = rangeFormat === 'task'
    ? formatTaskDateRangeDisplay
    : rangeFormat === 'phase'
      ? formatPhaseDateRangeDisplay
      : formatMilestoneDateRangeDisplay;
  const formatSingleLabel = rangeFormat === 'task'
    ? formatTaskDateShort
    : rangeFormat === 'phase'
      ? formatPhaseDateMedium
      : formatDueDateLong;

  const todayIso = today();
  const canSave = singleDate ? Boolean(draftStart) : Boolean(draftStart && draftEnd);
  const hintText = singleDate
    ? (draftStart ? formatSingleLabel(draftStart) : 'Choose a date')
    : pickingStartAfterClear
      ? 'Choose a start date'
      : lockedStartMode
        ? (draftEnd
          ? `Start ${formatSingleLabel(draftStart)} — end ${formatSingleLabel(draftEnd)}`
          : `Start locked at ${formatSingleLabel(draftStart)} — choose an end date`)
        : !draftStart
          ? 'Choose a start date'
          : !draftEnd
            ? 'Choose an end date'
            : formatRangeLabel(draftStart, draftEnd);

  return createPortal(
    <div
      ref={popoverRef}
      className="sheet-date-calendar"
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
      aria-label={label}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="sheet-date-calendar__head">
        <button
          type="button"
          className="sheet-date-calendar__nav"
          onClick={() => shiftMonth(-1)}
          aria-label="Previous month"
        >
          ‹
        </button>
        <span className="sheet-date-calendar__month">{monthLabel}</span>
        <button
          type="button"
          className="sheet-date-calendar__nav"
          onClick={() => shiftMonth(1)}
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      <div className="sheet-date-calendar__weekdays" aria-hidden>
        {CALENDAR_WEEKDAYS.map((wd, i) => (
          <span key={`${wd}-${i}`} className="sheet-date-calendar__weekday">{wd}</span>
        ))}
      </div>
      <div className="sheet-date-calendar__grid" role="grid">
        {cells.map((cell) => {
          const hasRange = Boolean(draftStart && draftEnd);
          const inRange = hasRange && cell.iso >= draftStart && cell.iso <= draftEnd;
          const isRangeStart = cell.iso === draftStart;
          const isRangeEnd = cell.iso === draftEnd;
          const isRangeMiddle = inRange && !isRangeStart && !isRangeEnd;
          const isToday = cell.iso === todayIso;
          return (
            <button
              key={cell.iso}
              type="button"
              role="gridcell"
              className={[
                'sheet-date-calendar__day',
                !cell.inMonth ? 'sheet-date-calendar__day--outside' : '',
                isRangeMiddle ? 'sheet-date-calendar__day--in-range' : '',
                isRangeStart ? 'sheet-date-calendar__day--range-start' : '',
                lockedStartMode && isRangeStart ? 'sheet-date-calendar__day--range-start-locked' : '',
                isRangeEnd ? 'sheet-date-calendar__day--range-end' : '',
                !draftEnd && isRangeStart ? 'sheet-date-calendar__day--selected' : '',
                isToday ? 'sheet-date-calendar__day--today' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => handleDayClick(cell.iso)}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
      <div className="sheet-date-calendar__footer">
        <p className="sheet-date-calendar__hint">{hintText}</p>
        <div className={`sheet-date-calendar__actions${endDateOnly || singleDate ? ' sheet-date-calendar__actions--split' : ''}`}>
          {endDateOnly || singleDate ? (
            <button
              type="button"
              className="sheet-date-calendar__clear"
              onClick={handleClear}
            >
              Clear
            </button>
          ) : null}
          <button
            type="button"
            className="sheet-date-calendar__save"
            disabled={singleDate ? false : !canSave}
            onClick={() => {
              if (singleDate && !draftStart) {
                onSave({ date: '', startDate: '', endDate: '' });
                return;
              }
              handleSave();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MilestoneDateRangePicker({
  startDate,
  endDate,
  onChange,
  className = '',
  emptyLabel = 'Add dates',
  ariaLabel = 'Set dates',
  endDateOnly = false,
  rangeFormat = 'long',
}, ref) {
  const rangeBtnRef = useRef(null);
  const sessionSnapshotRef = useRef(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const beginSession = useCallback(() => {
    sessionSnapshotRef.current = {
      startDate: startDate || '',
      endDate: endDate || '',
    };
  }, [startDate, endDate]);

  const endPickSession = useCallback(() => {
    sessionSnapshotRef.current = null;
    setCalendarOpen(false);
  }, []);

  const toggleCalendar = useCallback(() => {
    if (calendarOpen) {
      endPickSession();
      return;
    }
    beginSession();
    setCalendarOpen(true);
  }, [calendarOpen, beginSession, endPickSession]);

  const beginPick = useCallback(() => {
    if (calendarOpen) return;
    beginSession();
    setCalendarOpen(true);
  }, [calendarOpen, beginSession]);

  useImperativeHandle(ref, () => ({ beginPick }), [beginPick]);

  const handleSave = (patch) => {
    onChange(patch);
    sessionSnapshotRef.current = null;
    setCalendarOpen(false);
  };

  const formatRangeLabel = rangeFormat === 'task'
    ? formatTaskDateRangeDisplay
    : rangeFormat === 'phase'
      ? formatPhaseDateRangeDisplay
      : formatMilestoneDateRangeDisplay;
  const formatSingleLabel = rangeFormat === 'task'
    ? formatTaskDateShort
    : rangeFormat === 'phase'
      ? formatPhaseDateMedium
      : formatDueDateLong;

  const rangeLabel = endDateOnly
    ? (startDate
      ? `${formatSingleLabel(startDate)} — ${formatSingleLabel(endDate || startDate)}`
      : emptyLabel)
    : (formatRangeLabel(startDate, endDate) || emptyLabel);
  const hasDates = endDateOnly ? Boolean(startDate) : Boolean(startDate && endDate);

  return (
    <>
      <button
        ref={rangeBtnRef}
        type="button"
        className={[
          'sheet-date-range-btn',
          className,
          calendarOpen ? 'sheet-date-range-btn--active' : '',
          hasDates ? '' : 'sheet-date-range-btn--empty',
        ].filter(Boolean).join(' ')}
        onClick={toggleCalendar}
        aria-label={ariaLabel}
        aria-expanded={calendarOpen}
        aria-live="polite"
      >
        {rangeLabel}
      </button>
      <DateRangeBubbleCalendar
        anchorRef={rangeBtnRef}
        open={calendarOpen}
        startDate={startDate}
        endDate={endDate}
        onSave={handleSave}
        onClose={endPickSession}
        label={ariaLabel}
        endDateOnly={endDateOnly}
        rangeFormat={rangeFormat}
      />
    </>
  );
}

const MilestoneDateRangePickerWithRef = forwardRef(MilestoneDateRangePicker);

const MilestoneSingleDatePicker = forwardRef(function MilestoneSingleDatePicker({
  date,
  onChange,
  className = '',
  emptyLabel = 'Add date',
  ariaLabel = 'Set date',
  rangeFormat = 'phase',
  fallbackDate = '',
  onAfterSave,
}, ref) {
  const btnRef = useRef(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  useImperativeHandle(ref, () => ({
    beginPick: () => setCalendarOpen(true),
  }), []);

  const handleSave = (patch) => {
    const nextDate = patch.date || '';
    onChange(nextDate);
    setCalendarOpen(false);
    if (nextDate && onAfterSave) {
      window.setTimeout(() => onAfterSave(nextDate), 0);
    }
  };

  const label = date
    ? (rangeFormat === 'task' ? formatTaskDateShort(date) : formatPhaseDateMedium(date))
    : emptyLabel;
  const calendarDate = date || fallbackDate || '';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={[
          'sheet-date-range-btn',
          className,
          calendarOpen ? 'sheet-date-range-btn--active' : '',
          date ? '' : 'sheet-date-range-btn--empty',
        ].filter(Boolean).join(' ')}
        onClick={() => setCalendarOpen((open) => !open)}
        aria-label={ariaLabel}
        aria-expanded={calendarOpen}
        aria-live="polite"
      >
        {label}
      </button>
      <DateRangeBubbleCalendar
        anchorRef={btnRef}
        open={calendarOpen}
        startDate={calendarDate}
        endDate={calendarDate}
        onSave={handleSave}
        onClose={() => setCalendarOpen(false)}
        label={ariaLabel}
        singleDate
        rangeFormat={rangeFormat === 'task' ? 'task' : 'phase'}
      />
    </>
  );
});

function ScheduleStartEndRow({
  rowClass,
  name,
  startDate,
  endDate,
  onChange,
  startLabel = 'Start',
  endLabel = 'End',
  nameExtra = null,
  dropActive = false,
  onMarkerDragOver,
  onMarkerDragLeave,
  onMarkerDrop,
}) {
  const endPickerRef = useRef(null);

  const clampRange = (nextStart, nextEnd) => {
    const start = nextStart || nextEnd || '';
    const end = nextEnd || nextStart || '';
    if (start && end && end < start) return { startDate: start, endDate: start };
    return { startDate: start, endDate: end };
  };

  return (
    <div
      className={[
        'gantt-edit-rail-row',
        rowClass,
        dropActive ? 'gantt-edit-rail-row--drop-active' : '',
      ].filter(Boolean).join(' ')}
      role="row"
      onDragOver={onMarkerDragOver}
      onDragLeave={onMarkerDragLeave}
      onDrop={onMarkerDrop}
    >
      <span className="gantt-edit-rail-col gantt-edit-rail-col--name" role="cell">
        {nameExtra}
        {name}
      </span>
      <span className="gantt-edit-rail-col gantt-edit-rail-col--date" role="cell">
        <MilestoneSingleDatePicker
          date={startDate}
          onChange={(date) => onChange(clampRange(date, endDate))}
          onAfterSave={() => endPickerRef.current?.beginPick()}
          className="gantt-edit-rail-date"
          emptyLabel={startLabel}
          ariaLabel={`${startLabel} for ${name}`}
          rangeFormat="task"
        />
      </span>
      <span className="gantt-edit-rail-col gantt-edit-rail-col--date" role="cell">
        <MilestoneSingleDatePicker
          ref={endPickerRef}
          date={endDate}
          fallbackDate={startDate}
          onChange={(date) => onChange(clampRange(startDate, date))}
          className="gantt-edit-rail-date"
          emptyLabel={endLabel}
          ariaLabel={`${endLabel} for ${name}`}
          rangeFormat="task"
        />
      </span>
    </div>
  );
}

function MilestoneCatalogAddButton({
  options,
  onSelect,
  ariaLabel,
  disabled = false,
}) {
  if (disabled || !options.length) return null;

  return (
    <div className="sheet-designer-add-wrap sheet-milestone-catalog-add-wrap">
      <button
        type="button"
        className="sheet-milestone-add-task"
        aria-label={ariaLabel}
        tabIndex={-1}
      >
        +
      </button>
      <select
        className="sheet-designer-add-select"
        value=""
        aria-label={ariaLabel}
        onChange={(e) => {
          const value = e.target.value;
          if (value) onSelect(value);
          e.target.value = '';
        }}
      >
        <option value="" disabled hidden />
        {options.map((option) => (
          <option key={option.key} value={option.key}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

function MilestonePhaseDurationPicker({
  phase,
  onAdjustWeeks,
  onSelectCustom,
  onCustomDatesChange,
  ariaLabelDates,
}) {
  const customPickerRef = useRef(null);
  const isCustom = phase.scheduleMode === 'custom';
  const activeWeeks = normalizeDurationWeeks(
    phase.durationWeeks || inferDurationWeeksFromDates(phase.startDate, phase.endDate),
    2,
  );

  const handleCustomClick = () => {
    if (isCustom) {
      customPickerRef.current?.beginPick();
      return;
    }
    onSelectCustom();
    requestAnimationFrame(() => customPickerRef.current?.beginPick());
  };

  return (
    <div className="sheet-phase-duration">
      {isCustom ? (
        <MilestoneDateRangePickerWithRef
          ref={customPickerRef}
          startDate={phase.startDate}
          endDate={phase.endDate}
          onChange={onCustomDatesChange}
          className="sheet-name-dates-range sheet-phase-duration-dates sheet-phase-duration-dates--picker"
          emptyLabel="Pick dates"
          ariaLabel={ariaLabelDates}
          rangeFormat="phase"
        />
      ) : (
        phase.startDate && phase.endDate ? (
          <span className="sheet-phase-duration-dates">
            {formatPhaseDateRangeDisplay(phase.startDate, phase.endDate)}
          </span>
        ) : null
      )}
      <span
        className={[
          'sheet-phase-duration-weeks',
          isCustom ? 'sheet-phase-duration-weeks--muted' : '',
        ].filter(Boolean).join(' ')}
      >
        {formatPhaseWeekLabel(activeWeeks)}
      </span>
      <div className="sheet-phase-duration-steps" role="group" aria-label="Adjust phase duration">
        <button
          type="button"
          className="sheet-phase-duration-step"
          aria-label="Decrease weeks"
          disabled={!isCustom && activeWeeks <= MIN_MILESTONE_WEEKS}
          onClick={() => onAdjustWeeks(-1)}
        >
          −
        </button>
        <button
          type="button"
          className="sheet-phase-duration-step"
          aria-label="Increase weeks"
          disabled={!isCustom && activeWeeks >= MAX_MILESTONE_WEEKS}
          onClick={() => onAdjustWeeks(1)}
        >
          +
        </button>
      </div>
      <button
        type="button"
        className={[
          'sheet-phase-duration-custom',
          isCustom ? 'sheet-phase-duration-custom--active' : '',
        ].filter(Boolean).join(' ')}
        aria-pressed={isCustom}
        onClick={handleCustomClick}
      >
        Custom
      </button>
    </div>
  );
}

function MilestonePhaseTitle({
  phase,
  onAdjustWeeks,
  onSelectCustom,
  onCustomDatesChange,
}) {
  const phaseLabel = phase.title.trim() || 'Phase';

  return (
    <div className="sheet-phase-head-fields">
      <span className="sheet-phase-name-label">{phase.title}</span>
      <MilestonePhaseDurationPicker
        phase={phase}
        onAdjustWeeks={onAdjustWeeks}
        onSelectCustom={onSelectCustom}
        onCustomDatesChange={onCustomDatesChange}
        ariaLabelDates={`Set custom dates for ${phaseLabel}`}
      />
    </div>
  );
}

function MilestoneTaskChip({
  task,
  onUpdate,
  onRemove,
}) {
  const label = task.title.trim() || 'Task';

  return (
    <div className="sheet-task-chip">
      <div className="sheet-bubble sheet-task-chip-bubble">
        <span className="sheet-task-chip-label">{label}</span>
        <MilestoneDateRangePickerWithRef
          startDate={task.startDate}
          endDate={task.endDate}
          onChange={(patch) => onUpdate({
            ...normalizeTaskDates({ ...task, ...patch }),
          })}
          className="sheet-task-chip-range"
          emptyLabel="Dates"
          ariaLabel={`Set dates for ${label}`}
          rangeFormat="task"
        />
        <button
          type="button"
          className="sheet-designer-chip-remove sheet-task-chip-remove"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function MilestonePhaseBlock({
  phase,
  markers = [],
  onRemovePhase,
  onAddTask,
  onRemoveTask,
  onUpdateTask,
  onAddMarker,
  onRemoveMarker,
  onUpdateMarker,
  onAdjustWeeks,
  onSelectCustom,
  onCustomDatesChange,
}) {
  const taskOptions = availableTasks(phase.phaseKey, phase.tasks).map((title) => ({
    key: taskKeyFromTitle(title),
    label: title,
  }));
  const phaseMarkers = (markers || []).filter((marker) => marker.phaseKey === phase.phaseKey);

  return (
    <div className="sheet-milestone-block">
      <div className="sheet-milestone-phase-head">
        <MilestonePhaseTitle
          phase={phase}
          onAdjustWeeks={onAdjustWeeks}
          onSelectCustom={onSelectCustom}
          onCustomDatesChange={onCustomDatesChange}
        />
        <button
          type="button"
          className="sheet-designer-chip-remove sheet-milestone-phase-remove"
          onClick={onRemovePhase}
          aria-label={`Remove ${phase.title}`}
        >
          ×
        </button>
      </div>

      <div className="sheet-milestone-tasks">
        <div className="sheet-milestone-task-chips">
          {phase.tasks.map((task) => (
            <MilestoneTaskChip
              key={task.id}
              task={task}
              onUpdate={(patch) => onUpdateTask(task.id, patch)}
              onRemove={() => onRemoveTask(task.id)}
            />
          ))}
          <MilestoneCatalogAddButton
            options={taskOptions}
            onSelect={(taskKey) => onAddTask(taskKey)}
            ariaLabel={`Add task to ${phase.title}`}
          />
        </div>

        <div className="sheet-phase-markers">
          {phaseMarkers.map((marker) => (
            <div key={marker.id} className="sheet-phase-marker">
              <span className="sheet-phase-marker-dot" aria-hidden />
              <div className="sheet-phase-marker-copy">
                <MilestoneSingleDatePicker
                  date={marker.date}
                  onChange={(nextDate) => onUpdateMarker(marker.id, { date: nextDate })}
                  className="sheet-phase-marker-date"
                  emptyLabel="No date"
                  ariaLabel={`Date for ${marker.title.trim() || 'milestone'}`}
                />
                <span className="sheet-phase-marker-title">
                  {marker.title.trim() || 'Milestone'}
                </span>
              </div>
              <button
                type="button"
                className="sheet-designer-chip-remove sheet-phase-marker-remove"
                onClick={() => onRemoveMarker(marker.id)}
                aria-label={`Remove ${marker.title.trim() || 'milestone'}`}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="sheet-phase-marker-add"
            onClick={() => onAddMarker(phase.phaseKey)}
          >
            + Milestone
          </button>
        </div>
      </div>
    </div>
  );
}

function MilestonesPanel({ form, setForm, isEditing = false }) {
  const phases = form.milestones || [];
  const [importError, setImportError] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const csvInputRef = useRef(null);
  const projectNameSize = Math.max(10, (form.name.trim() || 'Project name').length + 1);
  const phaseOptions = availablePhases(phases).map((phase) => ({
    key: phase.key,
    label: phase.title,
  }));

  const setPhases = (next) => {
    setForm((f) => applyMilestoneScheduleToForm(f, { milestones: sortPhasesByCatalog(next) }));
  };

  const updatePhase = (phaseId, patch) => {
    setPhases(phases.map((ph) => (ph.id === phaseId ? { ...ph, ...patch } : ph)));
  };

  const removePhase = (phaseId) => {
    setPhases(phases.filter((ph) => ph.id !== phaseId));
  };

  const addPhase = (phaseKey) => {
    const phase = createCatalogPhase(phaseKey);
    if (!phase) return;
    const startDate = suggestedStartAfterExistingPhases(phases, form.startDate || today());
    setPhases(insertPhaseInCatalogOrder(phases, { ...phase, startDate }));
  };

  const removeTask = (phaseId, taskId) => {
    setPhases(phases.map((ph) => {
      if (ph.id !== phaseId) return ph;
      return { ...ph, tasks: ph.tasks.filter((t) => t.id !== taskId) };
    }));
  };

  const addTask = (phaseId, taskKey) => {
    const phase = phases.find((ph) => ph.id === phaseId);
    if (!phase) return;
    const task = createCatalogTask(phase.phaseKey, taskKey);
    if (!task) return;
    setPhases(phases.map((ph) => {
      if (ph.id !== phaseId) return ph;
      return { ...ph, tasks: sortTasksByCatalog(ph.phaseKey, [...ph.tasks, task]) };
    }));
  };

  const updateTask = (phaseId, taskId, patch) => {
    if (!form.linkedSchedule) {
      setPhases(phases.map((ph) => {
        if (ph.id !== phaseId) return ph;
        return {
          ...ph,
          tasks: ph.tasks.map((task) => (
            task.id === taskId
              ? { ...task, ...normalizeTaskDates({ ...task, ...patch }) }
              : task
          )),
        };
      }));
      return;
    }

    setForm((f) => {
      const phase = (f.milestones || []).find((ph) => ph.id === phaseId);
      const previous = (phase?.tasks || []).find((task) => task.id === taskId);
      if (!phase || !previous) return f;
      const updatedTask = {
        ...previous,
        ...normalizeTaskDates({ ...previous, ...patch }),
      };
      const cascaded = cascadeAfterTaskChange(
        f.milestones,
        f.markers,
        phaseId,
        taskId,
        updatedTask,
        previous.endDate || previous.startDate || '',
      );
      return applyMilestoneScheduleToForm({
        ...f,
        milestones: sortPhasesByCatalog(cascaded.phases),
        markers: cascaded.markers,
      }, {});
    });
  };

  const setMarkers = (next) => {
    setForm((f) => ({
      ...f,
      markers: normalizeProjectMarkers(next, { requireTitle: false }),
    }));
  };

  const addPhaseMarker = (phaseKey) => {
    setMarkers([
      ...(form.markers || []),
      {
        ...emptyProjectMarker(),
        phaseKey: phaseKey || '',
        title: 'Milestone',
        date: today(),
      },
    ]);
  };

  const removePhaseMarker = (markerId) => {
    setMarkers((form.markers || []).filter((marker) => marker.id !== markerId));
  };

  const updatePhaseMarker = (markerId, patch) => {
    setMarkers((form.markers || []).map((marker) => (
      marker.id === markerId ? { ...marker, ...patch } : marker
    )));
  };

  const selectPhaseWeeks = (phaseId, weeks) => {
    updatePhase(phaseId, { scheduleMode: 'weeks', durationWeeks: weeks });
  };

  const adjustPhaseWeeks = (phaseId, delta) => {
    const phase = phases.find((ph) => ph.id === phaseId);
    const current = phase?.scheduleMode === 'custom'
      ? normalizeDurationWeeks(inferDurationWeeksFromDates(phase?.startDate, phase?.endDate), 2)
      : normalizeDurationWeeks(phase?.durationWeeks, 2);
    const next = normalizeDurationWeeks(current + delta, current);
    if (next === current && phase?.scheduleMode !== 'custom') return;

    if (!form.linkedSchedule) {
      selectPhaseWeeks(phaseId, next);
      return;
    }

    const oldEnd = phase?.endDate || '';
    setForm((f) => {
      const patched = (f.milestones || []).map((ph) => (
        ph.id === phaseId
          ? { ...ph, scheduleMode: 'weeks', durationWeeks: next }
          : ph
      ));
      const resolved = applyMilestoneScheduleToForm(f, {
        milestones: sortPhasesByCatalog(patched),
      });
      const newEnd = (resolved.milestones || []).find((ph) => ph.id === phaseId)?.endDate || '';
      const cascaded = cascadeAfterPhaseEndChange(
        resolved.milestones,
        resolved.markers || f.markers,
        phaseId,
        oldEnd,
        newEnd,
      );
      return applyMilestoneScheduleToForm({
        ...resolved,
        milestones: cascaded.phases,
        markers: cascaded.markers,
      }, {});
    });
  };

  const selectPhaseCustom = (phaseId) => {
    updatePhase(phaseId, {
      scheduleMode: 'custom',
      durationWeeks: null,
      startDate: phases.find((ph) => ph.id === phaseId)?.startDate || form.startDate || today(),
      endDate: phases.find((ph) => ph.id === phaseId)?.endDate || addDays(form.startDate || today(), 6),
    });
  };

  const updatePhaseCustomDates = (phaseId, patch) => {
    if (!form.linkedSchedule) {
      updatePhase(phaseId, { ...patch, scheduleMode: 'custom', durationWeeks: null });
      return;
    }
    const phase = phases.find((ph) => ph.id === phaseId);
    const oldEnd = phase?.endDate || '';
    setForm((f) => {
      const patched = (f.milestones || []).map((ph) => (
        ph.id === phaseId
          ? { ...ph, ...patch, scheduleMode: 'custom', durationWeeks: null }
          : ph
      ));
      const resolved = applyMilestoneScheduleToForm(f, {
        milestones: sortPhasesByCatalog(patched),
      });
      const newEnd = (resolved.milestones || []).find((ph) => ph.id === phaseId)?.endDate || '';
      const cascaded = cascadeAfterPhaseEndChange(
        resolved.milestones,
        resolved.markers || f.markers,
        phaseId,
        oldEnd,
        newEnd,
      );
      return applyMilestoneScheduleToForm({
        ...resolved,
        milestones: cascaded.phases,
        markers: cascaded.markers,
      }, {});
    });
  };

  const handleKickoffChange = (patch) => {
    setForm((f) => applyProjectDatePatch(f, patch));
  };

  const applyImportedSchedule = (importedPhases, importedMarkers, warnings = []) => {
    setForm((f) => {
      const next = applyMilestoneScheduleToForm(f, {
        milestones: sortPhasesByCatalog(importedPhases),
      });
      return {
        ...next,
        markers: normalizeProjectMarkers(importedMarkers),
      };
    });
    setImportError('');
    setImportNotice(warnings.length ? warnings.slice(0, 4).join(' ') : '');
  };

  const handleCsvUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const {
          phases: importedPhases,
          markers: importedMarkers = [],
          warnings,
        } = importTimelineCsv(String(reader.result || ''));
        if (phases.length > 0 || (form.markers || []).length > 0) {
          const replace = window.confirm(
            'Replace existing phases and milestones with the imported Streamtime schedule?',
          );
          if (!replace) return;
        }
        applyImportedSchedule(importedPhases, importedMarkers, warnings);
      } catch (err) {
        setImportNotice('');
        setImportError(err.message || 'Could not parse CSV.');
      }
    };
    reader.onerror = () => {
      setImportNotice('');
      setImportError('Could not read file.');
    };
    reader.readAsText(file);
  };

  return (
    <>
      <div className="sheet-modal-section sheet-modal-section--project-name">
        <div className="sheet-project-name-row">
          <input
            className="sheet-name-dates-name sheet-project-name-input"
            type="text"
            placeholder="Project name"
            aria-label="Project name"
            value={form.name}
            size={projectNameSize}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
      </div>

      <div className="sheet-modal-section sheet-modal-section--project-dates">
        <div className="sheet-project-dates-row">
          <div className="sheet-modal-section-label sheet-project-dates-label">Dates</div>
          <MilestoneDateRangePickerWithRef
            startDate={form.startDate}
            endDate={form.endDate}
            onChange={handleKickoffChange}
            className="sheet-name-dates-range sheet-project-dates-btn"
            emptyLabel="Add dates"
            ariaLabel={`Set dates for ${form.name.trim() || 'project'}`}
            endDateOnly={isEditing}
          />
        </div>
      </div>

      <div className="sheet-pair sheet-pair--priority-top">
        <span className="sheet-field-label">Phases</span>
        <div className="sheet-field-value sheet-milestone-phase-actions">
          <button
            type="button"
            className={[
              'sheet-milestone-add-task',
              'sheet-milestone-add-task--label',
              form.linkedSchedule ? 'sheet-linked-schedule--on' : '',
            ].filter(Boolean).join(' ')}
            aria-pressed={Boolean(form.linkedSchedule)}
            onClick={() => setForm((f) => ({ ...f, linkedSchedule: !f.linkedSchedule }))}
          >
            Linked
          </button>
          <button
            type="button"
            className="sheet-milestone-add-task sheet-milestone-add-task--label"
            onClick={() => csvInputRef.current?.click()}
            aria-label="Import CSV"
          >
            Import
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="sheet-csv-import-input"
            onChange={handleCsvUpload}
            aria-hidden
            tabIndex={-1}
          />
          <MilestoneCatalogAddButton
            options={phaseOptions}
            onSelect={addPhase}
            ariaLabel="Add phase"
          />
        </div>
      </div>

      {importError ? (
        <p className="sheet-csv-import-error" role="alert">{importError}</p>
      ) : null}
      {importNotice ? (
        <p className="sheet-csv-import-notice" role="status">{importNotice}</p>
      ) : null}

      <div className="sheet-milestone-list">
      {phases.map((phase) => (
        <MilestonePhaseBlock
          key={phase.id}
          phase={phase}
          markers={form.markers || []}
          onRemovePhase={() => removePhase(phase.id)}
          onAddTask={(taskKey) => addTask(phase.id, taskKey)}
          onRemoveTask={(taskId) => removeTask(phase.id, taskId)}
          onUpdateTask={(taskId, patch) => updateTask(phase.id, taskId, patch)}
          onAddMarker={addPhaseMarker}
          onRemoveMarker={removePhaseMarker}
          onUpdateMarker={updatePhaseMarker}
          onAdjustWeeks={(delta) => adjustPhaseWeeks(phase.id, delta)}
          onSelectCustom={() => selectPhaseCustom(phase.id)}
          onCustomDatesChange={(patch) => updatePhaseCustomDates(phase.id, patch)}
        />
      ))}
      </div>
    </>
  );
}

function ProjectDetailsPanel({
  form,
  set,
  setForm,
  designers,
  designersAvailableToAdd,
  addDesignerId,
  removeDesignerId,
  existingClients,
  isEditing = false,
}) {
  const projectNameSize = Math.max(10, (form.name.trim() || 'Project name').length + 1);

  return (
    <>
      <div className="sheet-modal-section sheet-modal-section--project-client">
        <div className="sheet-client-row">
          <input
            id="project-modal-client"
            className="sheet-text-input sheet-text-input--left sheet-client-input"
            type="text"
            placeholder="Client"
            aria-label="Client"
            autoComplete="off"
            value={form.client}
            onChange={(e) => set('client', e.target.value)}
          />
          {existingClients.length > 0 ? (
            <div className="sheet-designer-add-wrap sheet-client-add-wrap">
              <button
                type="button"
                className="sheet-milestone-add-task"
                aria-label="Choose client"
                tabIndex={-1}
              >
                +
              </button>
              <select
                className="sheet-designer-add-select"
                value=""
                aria-label="Choose client"
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) set('client', v);
                  e.target.value = '';
                }}
              >
                <option value="" disabled>Choose client</option>
                {existingClients.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </div>

      <div className="sheet-modal-section sheet-modal-section--project-name">
        <div className="sheet-project-name-row">
          <input
            id="project-modal-name"
            className="sheet-name-dates-name sheet-project-name-input"
            type="text"
            placeholder="Project name"
            aria-label="Project name"
            value={form.name}
            size={projectNameSize}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
      </div>

      <div className="sheet-modal-section sheet-modal-section--project-dates">
        <div className="sheet-project-dates-row">
          <div className="sheet-modal-section-label sheet-project-dates-label">Date</div>
          <MilestoneDateRangePickerWithRef
            startDate={form.startDate}
            endDate={form.endDate}
            onChange={(patch) => setForm((f) => applyProjectDatePatch(f, patch))}
            className="sheet-name-dates-range sheet-project-dates-btn"
            emptyLabel="Add dates"
            ariaLabel={`Set dates for ${form.name.trim() || 'project'}`}
            endDateOnly={isEditing}
          />
        </div>
      </div>

      <div className="sheet-modal-section sheet-modal-section--project-designers">
        <div className="sheet-project-designers-row">
          <div className="sheet-modal-section-label sheet-project-designers-label">Designers</div>
          <div className="sheet-designer-chips-row">
            {form.designerIds.map((id) => {
              const d = designers.find((x) => x.id === id);
              if (!d) return null;
              return (
                <div key={id} className="sheet-designer-chip">
                  <Avatar designer={d} size={20} />
                  <span className="sheet-designer-chip-name">{d.name}</span>
                  <button
                    type="button"
                    className="sheet-designer-chip-remove"
                    onClick={() => removeDesignerId(id)}
                    aria-label={`Remove ${d.name}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {designersAvailableToAdd.length > 0 ? (
              <div className="sheet-designer-add-wrap">
                <button
                  type="button"
                  className="sheet-milestone-add-task"
                  aria-label="Add designer"
                  tabIndex={-1}
                >
                  +
                </button>
                <select
                  className="sheet-designer-add-select"
                  value=""
                  aria-label="Add designer"
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) addDesignerId(v);
                    e.target.value = '';
                  }}
                >
                  <option value="" disabled>Add designer</option>
                  {designersAvailableToAdd.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="sheet-modal-section sheet-modal-section--project-meta">
        <div className="sheet-project-meta">
          <div className="sheet-project-meta-group">
            <label htmlFor="project-modal-category" className="sheet-modal-section-sublabel">
              Category
            </label>
            <div className="sheet-select-hit sheet-select-hit--meta">
              <span className="sheet-select-visual" aria-hidden>
                <span className="sheet-value sheet-value--nowrap">
                  {formatCategoryForDisplay(form.priority)}
                </span>
              </span>
              <select
                id="project-modal-category"
                className="sheet-select-native"
                value={normalizeProjectCategory(form.priority)}
                onChange={(e) => set('priority', e.target.value)}
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="sheet-project-meta-group">
            <label htmlFor="project-modal-status" className="sheet-modal-section-sublabel">
              Status
            </label>
            <div className="sheet-select-hit sheet-select-hit--meta">
              <span className="sheet-select-visual" aria-hidden>
                <span className="sheet-value sheet-value--nowrap">
                  {formatStatusForDisplay(form.status)}
                </span>
              </span>
              <select
                id="project-modal-status"
                className="sheet-select-native"
                value={form.status}
                onChange={(e) => set('status', e.target.value)}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function overviewTimelineBounds(project, phases) {
  const dates = [];
  if (project.startDate) dates.push(project.startDate);
  if (project.endDate) dates.push(project.endDate);
  (phases || []).forEach((phase) => {
    if (phase.startDate) dates.push(phase.startDate);
    if (phase.endDate) dates.push(phase.endDate);
  });
  dates.sort();
  const startDate = dates[0] || project.startDate || today();
  const endDate = dates[dates.length - 1] || project.endDate || startDate;
  return { startDate, endDate };
}

function overviewBarStyle(phase, rangeStart, rangeEnd) {
  if (!phase.startDate || !phase.endDate || !rangeStart || !rangeEnd) {
    return null;
  }
  const minDay = daysFromEpoch(rangeStart);
  const maxDay = daysFromEpoch(rangeEnd);
  const span = Math.max(1, maxDay - minDay + 1);
  const startDay = Math.max(minDay, daysFromEpoch(phase.startDate));
  const endDay = Math.max(startDay, Math.min(maxDay, daysFromEpoch(phase.endDate)));
  const left = ((startDay - minDay) / span) * 100;
  const width = ((endDay - startDay + 1) / span) * 100;
  return {
    left: `${left}%`,
    width: `${Math.max(width, 1.2)}%`,
  };
}

function overviewLabelLeftPct(date, rangeStart, rangeEnd) {
  if (!date || !rangeStart || !rangeEnd) return 0;
  const minDay = daysFromEpoch(rangeStart);
  const maxDay = daysFromEpoch(rangeEnd);
  const span = Math.max(1, maxDay - minDay + 1);
  const day = Math.max(minDay, Math.min(maxDay, daysFromEpoch(date)));
  return ((day - minDay) / span) * 100;
}

/** Export timeline track usable width ≈ doc width minus horizontal padding. */
const OVERVIEW_TRACK_USABLE_PX = 740;
const OVERVIEW_DATE_GAP_PX = 10;
const OVERVIEW_DATE_CHAR_PX = 5.15;

function estimateOverviewDateLabelPx(label) {
  if (!label) return 0;
  return label.length * OVERVIEW_DATE_CHAR_PX + 2;
}

function overviewPhaseDatesLayout(startPct, endPct, startLabel, endLabel) {
  const barPct = Math.max(0, endPct - startPct);
  if (!startLabel && !endLabel) return null;
  if (!startLabel || !endLabel) {
    return {
      marginLeft: `${startPct}%`,
      width: `${Math.max(barPct, 0.5)}%`,
    };
  }

  const minWidthPx = estimateOverviewDateLabelPx(startLabel)
    + OVERVIEW_DATE_GAP_PX
    + estimateOverviewDateLabelPx(endLabel);
  const minWidthPct = (minWidthPx / OVERVIEW_TRACK_USABLE_PX) * 100;

  return {
    marginLeft: `${startPct}%`,
    width: `${Math.max(barPct, minWidthPct)}%`,
  };
}

function formatOverviewPhaseDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'long' });
}

function ClientOverviewModal({ project, onClose }) {
  const phases = project.milestones || [];
  const projectName = project.name?.trim() || 'Untitled project';
  const clientName = project.client?.trim() || '';
  const { startDate: rangeStart, endDate: rangeEnd } = overviewTimelineBounds(project, phases);

  const handlePrint = () => {
    window.print();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.body.classList.add('client-overview-open');
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('client-overview-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="client-overview-root"
      role="dialog"
      aria-modal="true"
      aria-label="Client project overview"
    >
      <div
        className="client-overview-backdrop client-overview-no-print"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="client-overview-shell">
        <div className="client-overview-toolbar client-overview-no-print">
          <p className="client-overview-toolbar-hint">Preview</p>
          <div className="client-overview-toolbar-actions">
            <button type="button" className="client-overview-btn client-overview-btn--close" onClick={onClose}>
              Close
            </button>
            <button type="button" className="client-overview-btn client-overview-btn--save" onClick={handlePrint}>
              Save
            </button>
          </div>
        </div>

        <article className="client-overview-doc">
          <header className="client-overview-header">
            <div className="client-overview-header-lead">
              <p className="client-overview-brand">Extended Whānau</p>
              <p className="client-overview-prepared">
                {formatDueDateLong(today())}
              </p>
            </div>
            <p className="client-overview-kicker">Timeline</p>
          </header>

          <div className="client-overview-hero">
            <p className="client-overview-hero-line">
              <span className="client-overview-project">{projectName}</span>
              {clientName ? (
                <span className="client-overview-client">{clientName}</span>
              ) : null}
            </p>
          </div>

          <section className="client-overview-timeline" aria-label="Stage timeline">
            <div className="client-overview-timeline-axis-wrap">
              <div className="client-overview-timeline-axis" aria-hidden="true">
                <span>{formatDueDateLong(rangeStart)}</span>
                <span>{formatDueDateLong(rangeEnd)}</span>
              </div>
              <div className="client-overview-rule" aria-hidden="true" />
            </div>
            {phases.length === 0 ? (
              <p className="client-overview-empty">No stages added yet.</p>
            ) : (
              <div className="client-overview-timeline-board">
                <div className="client-overview-timeline-rows">
                  {phases.map((phase) => {
                    const barStyle = overviewBarStyle(phase, rangeStart, rangeEnd);
                    const startPct = overviewLabelLeftPct(phase.startDate, rangeStart, rangeEnd);
                    const endPct = overviewLabelLeftPct(phase.endDate, rangeStart, rangeEnd);
                    const phaseTitle = phase.title?.trim() || 'Stage';
                    const startDateLabel = formatOverviewPhaseDate(phase.startDate);
                    const endDateLabel = formatOverviewPhaseDate(phase.endDate);
                    const datesLayout = overviewPhaseDatesLayout(
                      startPct,
                      endPct,
                      startDateLabel,
                      endDateLabel,
                    );
                    return (
                      <div key={phase.id} className="client-overview-stage">
                        <div className="client-overview-stage-lane">
                          <p
                            className="client-overview-stage-caption"
                            style={{ marginLeft: `${startPct}%` }}
                          >
                            {phaseTitle}
                          </p>
                          {(startDateLabel || endDateLabel) && datesLayout ? (
                            <div
                              className="client-overview-stage-dates"
                              style={datesLayout}
                            >
                              {startDateLabel ? (
                                <span className="client-overview-stage-date client-overview-stage-date--start">
                                  {startDateLabel}
                                </span>
                              ) : null}
                              {endDateLabel ? (
                                <span className="client-overview-stage-date client-overview-stage-date--end">
                                  {endDateLabel}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="client-overview-stage-track">
                            {barStyle ? (
                              <div className="client-overview-stage-bar" style={barStyle} />
                            ) : null}
                          </div>
                          {(phase.tasks || []).length > 0 ? (
                            <ul
                              className="client-overview-tasks"
                              style={{ marginLeft: `${startPct}%` }}
                            >
                              {phase.tasks.map((task) => (
                                <li key={task.id}>{task.title}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </article>
      </div>
    </div>,
    document.body,
  );
}

function ProjectModal({
  project,
  designers,
  existingClients = [],
  initialTab = 'details',
  onClose,
  onSave,
  onDelete,
  onOpenTimeline,
}) {
  const [modalTab, setModalTab] = useState(
    initialTab === 'markers' || initialTab === 'milestones' ? 'phases' : initialTab,
  );
  const [showOverview, setShowOverview] = useState(false);

  useEffect(() => {
    setModalTab(initialTab === 'markers' || initialTab === 'milestones' ? 'phases' : initialTab);
  }, [project?.id, initialTab]);
  const isEditing = Boolean(project);
  const [form, setForm] = useState(() => {
    if (project) {
      const merged = normalizeProjectMilestones(normalizeProjectDesignersOnProject({
        ...project,
        status: normalizeProjectStatus(project.status),
        priority: normalizeProjectCategory(project.priority),
      }));
      return merged;
    }
    const firstId = designers[0]?.id || '';
    return {
      id: uuidv4(), name: '', client: '',
      designerIds: firstId ? [firstId] : [],
      designerId: firstId,
      status: 'Scheduled', startDate: '', endDate: '',
      notes: '', priority: 'secondary',
      milestones: [],
      markers: [],
      linkedSchedule: false,
    };
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const syncDesignerIds = (ids) => {
    const clean = [...new Set(ids.filter((id) => id != null && String(id).trim() !== ''))];
    setForm((f) => ({ ...f, designerIds: clean, designerId: clean[0] || '' }));
  };

  const addDesignerId = (id) => {
    if (!id || form.designerIds.includes(id)) return;
    syncDesignerIds([...form.designerIds, id]);
  };

  const removeDesignerId = (id) => {
    syncDesignerIds(form.designerIds.filter((x) => x !== id));
  };

  const designersAvailableToAdd = designers.filter((d) => !form.designerIds.includes(d.id));

  const submitProject = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSave(normalizeProjectMilestones(form));
    onClose();
  };

  const showTimelineLink = Boolean(
    onOpenTimeline
    && projectHasMilestones(form)
    && form.startDate
    && form.endDate,
  );

  const openTimelineView = () => {
    if (!showTimelineLink || !form.name.trim()) return;
    onOpenTimeline(normalizeProjectMilestones(form));
  };

  const overviewProject = useMemo(
    () => normalizeProjectMilestones(form),
    [form],
  );

  return (
    <>
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--project">
        <div className="modal-header modal-header--project">
          <div className="modal-project-tabs" role="tablist" aria-label="Project sections">
            <button
              type="button"
              role="tab"
              className={`modal-project-tab${modalTab === 'details' ? ' modal-project-tab--active' : ''}`}
              aria-selected={modalTab === 'details'}
              onClick={() => setModalTab('details')}
            >
              Details
            </button>
            <div className="modal-project-tab-group">
              <button
                type="button"
                role="tab"
                className={`modal-project-tab${modalTab === 'phases' ? ' modal-project-tab--active' : ''}`}
                aria-selected={modalTab === 'phases'}
                onClick={() => setModalTab('phases')}
              >
                Phases
              </button>
              {showTimelineLink ? (
                <button
                  type="button"
                  className="modal-project-timeline-link"
                  onClick={openTimelineView}
                  aria-label={`Open ${form.name.trim() || 'project'} on timeline`}
                >
                  Timeline
                </button>
              ) : null}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form className="modal-project-sheet-form" onSubmit={submitProject} noValidate>
        <div className="modal-body modal-body--project">
          {modalTab === 'details' ? (
            <ProjectDetailsPanel
              form={form}
              set={set}
              setForm={setForm}
              designers={designers}
              designersAvailableToAdd={designersAvailableToAdd}
              addDesignerId={addDesignerId}
              removeDesignerId={removeDesignerId}
              existingClients={existingClients}
              isEditing={isEditing}
            />
          ) : (
            <MilestonesPanel form={form} setForm={setForm} isEditing={isEditing} />
          )}
        </div>

        <div className="modal-footer modal-footer--project modal-footer--project-form">
          {project && (
            <button type="button" className="btn-delete" onClick={() => { onDelete(project.id); onClose(); }}>
              Delete
            </button>
          )}
          <div className="modal-footer-actions">
            <button
              type="button"
              className="modal-btn-close"
              onClick={() => setShowOverview(true)}
              disabled={!form.name.trim()}
              title={!form.name.trim() ? 'Add a project name first' : 'Preview client overview PDF'}
            >
              Export
            </button>
            <button type="button" className="modal-btn-close" onClick={onClose}>
              Close
            </button>
            <button
              type="submit"
              className="modal-btn-submit"
              disabled={!form.name.trim()}
            >
              {project ? 'Save' : 'Add project'}
            </button>
          </div>
        </div>
        </form>
      </div>
    </div>
    {showOverview ? (
      <ClientOverviewModal
        project={overviewProject}
        onClose={() => setShowOverview(false)}
      />
    ) : null}
    </>
  );
}

// ── Designer Modal (add or edit profile) ─────────────────────────────────────
function DesignerModal({ initialDesigner, onClose, onSave, onDelete }) {
  const isEdit = initialDesigner != null;
  const [name, setName] = useState(initialDesigner?.name ?? '');
  const [barHex, setBarHex] = useState(() =>
    normalizeHex(
      initialDesigner
        ? getDesignerPalette(initialDesigner).bar
        : DESIGNER_COLORS[0].bar,
    ),
  );

  const handleSave = () => {
    if (!name.trim()) return;
    const hex = normalizeHex(barHex);
    const idx = DESIGNER_COLORS.findIndex((c) => c.bar.toLowerCase() === hex.toLowerCase());
    const payload = {
      name: name.trim(),
      colorHex: hex,
      colorIdx: idx >= 0 ? idx : 0,
    };
    if (isEdit) {
      onSave({ ...initialDesigner, ...payload });
    } else {
      onSave({ id: uuidv4(), ...payload });
    }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--project">
        <div className="modal-header modal-header--project">
          <h2 className="modal-project-sheet-heading">
            {isEdit ? 'Edit' : 'Add team member'}
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body modal-body--project">
          <div className="sheet-grid-row sheet-grid-row--bare-fields">
            <input
              id="designer-modal-name"
              className="sheet-text-input sheet-text-input--left"
              type="text"
              placeholder="Name"
              aria-label="Name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <div className="sheet-designer-color-cell">
              <label className="designer-color-custom-hit" title="Colour">
                <span className="sr-only">Colour</span>
                <input
                  type="color"
                  className="designer-color-native-input"
                  value={barHex}
                  onChange={(e) => setBarHex(normalizeHex(e.target.value))}
                  aria-label="Choose colour"
                />
                <span className="designer-color-custom-swatch" style={{ background: barHex }} aria-hidden />
              </label>
            </div>
          </div>
        </div>
        <div className="modal-footer modal-footer--project">
          {isEdit && (
            <button
              type="button"
              className="btn-delete"
              onClick={() => {
                onDelete(initialDesigner.id);
                onClose();
              }}
            >
              Remove
            </button>
          )}
          <div className="modal-footer-actions">
            <button type="button" className="modal-btn-close" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="modal-btn-submit"
              onClick={handleSave}
              disabled={!name.trim()}
            >
              {isEdit ? 'Save changes' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Project Row ───────────────────────────────────────────────────────────────
function ProjectRow({ project, designers, onClick, onStatusChange, variant = 'default' }) {
  const isFeedCard = variant === 'schedule' || variant === 'projects';
  const isProjectsCard = variant === 'projects';
  const assignedDesigners = getProjectDesigners(project, designers);
  const accent = statusAccent(project.status);
  const isComplete = project.status === 'Complete';
  const dateStr = isComplete
    ? (project.completedAt || project.endDate)
    : project.endDate;
  const dueSeg = !isComplete && dateStr ? formatDueDaysSegment(dateStr) : '';
  const dueTitle = isComplete
    ? 'Date completed'
    : 'Day count is working days (Mon–Fri)';
  const dueAria = isComplete
    ? (dateStr ? `Completed ${formatDueDateLong(dateStr)}` : 'No completion date')
    : (dateStr ? `${dueSeg}, ${formatDueDateLong(dateStr)}. Working weekdays.` : '');
  const hasMilestones = projectHasMilestones(project);
  const feedDateLabel = isProjectsCard
    ? formatDueDateLong(project.endDate)
    : formatDueDateLong(project.startDate);
  const feedDateTitle = isProjectsCard ? 'Due date' : 'Start date';
  const feedDateAria = isProjectsCard && project.endDate
    ? `Due ${formatDueDateLong(project.endDate)}`
    : (!isProjectsCard && project.startDate
      ? `Starts ${formatDueDateLong(project.startDate)}`
      : undefined);

  const trailCol = (
    <div className="project-row-col project-row-col--trail">
      <div
        className={[
          'project-status-hit',
          isFeedCard ? 'project-status-hit--dot-only' : '',
        ].filter(Boolean).join(' ')}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
      >
        <span
          className="project-status-dot"
          style={{ backgroundColor: accent, boxShadow: `0 0 0 2px ${accent}22` }}
          title={project.status}
          aria-hidden
        />
        <select
          className="row-status-select"
          value={project.status}
          onChange={e => onStatusChange(project.id, e.target.value)}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          aria-label="Project status"
        >
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <DesignerAvatarStack designers={assignedDesigners} size={28} maxVisible={4} />
    </div>
  );

  return (
    <div
      className={[
        'project-row',
        isFeedCard ? 'project-row--schedule' : '',
        isProjectsCard ? 'project-row--projects' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onClick(project)}
    >
      <div
        className={[
          'project-row-inner',
          isFeedCard ? 'project-row-inner--schedule' : '',
        ].filter(Boolean).join(' ')}
      >
        {isFeedCard ? (
          <>
            <div className="project-schedule-lead">
              <div className="project-row-col project-row-col--lead project-row-col--schedule-title">
                <span className="project-schedule-title">
                  {project.client ? (
                    <span className="project-schedule-client">{project.client}</span>
                  ) : null}
                  {project.name ? (
                    <span className="project-schedule-name">{project.name}</span>
                  ) : null}
                </span>
              </div>
              <div className="project-row-col project-row-col--due project-row-col--schedule-due">
                {feedDateLabel ? (
                  <span
                    className="project-schedule-start"
                    title={feedDateTitle}
                    aria-label={feedDateAria}
                  >
                    {feedDateLabel}
                  </span>
                ) : (
                  <span className="project-schedule-start project-schedule-start--empty">—</span>
                )}
              </div>
            </div>
            {trailCol}
          </>
        ) : (
          <>
            <div className="project-row-client-span">
              <span className="project-client">{project.client}</span>
            </div>
            <div className="project-row-col project-row-col--lead">
              <div className="project-row-lead-main">
                <span className="project-name">{project.name}</span>
                {hasMilestones ? (
                  <span className="project-milestone-range">
                    {formatMilestoneDateRange(project.startDate, project.endDate)}
                  </span>
                ) : null}
              </div>
              <div className="project-row-col project-row-col--due">
                {dateStr ? (
                  <div
                    className="project-row-due-pair"
                    title={dueTitle}
                    aria-label={dueAria}
                  >
                    <span className="project-due-date-main">{formatDueDateLong(dateStr)}</span>
                    {!isComplete ? (
                      <span className="project-due-days">{formatDueDaysDisplay(dateStr)}</span>
                    ) : null}
                  </div>
                ) : (
                  <span className="project-due-date-main project-due-date-main--empty">—</span>
                )}
              </div>
            </div>
            {trailCol}
          </>
        )}
      </div>
    </div>
  );
}

/** UTC midnight for a civil day index from daysFromEpoch. */
function ganttCivilUtcMs(epochDay) {
  return epochDay * 86400000;
}

/** Calendar Monday for a civil YYYY-MM-DD day index. */
function isMondayNZ(epochDay) {
  return new Date(ganttCivilUtcMs(epochDay)).getUTCDay() === 1;
}

function isSaturdayNZ(epochDay) {
  return new Date(ganttCivilUtcMs(epochDay)).getUTCDay() === 6;
}

function isSundayNZ(epochDay) {
  return new Date(ganttCivilUtcMs(epochDay)).getUTCDay() === 0;
}

/** Day of month only (civil date). */
function ganttTickDayNumberNZ(epochDay) {
  return String(new Date(ganttCivilUtcMs(epochDay)).getUTCDate());
}

function ganttDayPx(day, minDay, pxPerDay) {
  return (day - minDay) * pxPerDay;
}

function ganttFilterTicksByGap(candidates, minDay, pxPerDay, minGapPx) {
  const sorted = [...candidates].sort((a, b) => a.day - b.day);
  const out = [];
  let lastX = -Infinity;
  for (const tick of sorted) {
    const x = ganttDayPx(tick.day, minDay, pxPerDay);
    if (out.length === 0 || x - lastX >= minGapPx) {
      out.push(tick);
      lastX = x;
    }
  }
  return out;
}

/** How much date detail to show in the week row. */
function ganttRulerLabelTier(pxPerDay) {
  if (pxPerDay >= 12) return 'full';
  if (pxPerDay >= 5) return 'day';
  return 'hidden';
}

function ganttWeekTickLabel(epochDay, tier) {
  const dom = ganttTickDayNumberNZ(epochDay);
  if (tier === 'full') return `${dom} MON`;
  if (tier === 'day') return dom;
  return '';
}

function ganttMinLabelGapPx(tier) {
  if (tier === 'full') return 48;
  if (tier === 'day') return 34;
  return Infinity;
}

/** Soft grey weekend separators — max 10px, shrink when zoomed out. */
function buildWeekendBands(minDay, maxDay, totalDays, pxPerDay) {
  const bands = [];
  const trackWidthPx = Math.max(1, totalDays * pxPerDay);

  const addBand = (startDay, spanDays) => {
    const widthPx = Math.min(GANTT_WEEKEND_BAND_MAX_PX, spanDays * pxPerDay);
    if (widthPx < 1) return;
    const weekendStartPx = (startDay - minDay) * pxPerDay;
    const centerPx = weekendStartPx + (spanDays * pxPerDay) / 2;
    const leftPx = centerPx - widthPx / 2;
    bands.push({
      key: `wknd-${startDay}`,
      left: (leftPx / trackWidthPx) * 100,
      widthPx,
    });
  };

  if (isSundayNZ(minDay)) addBand(minDay, 1);

  for (let day = minDay; day <= maxDay; day += 1) {
    if (!isSaturdayNZ(day)) continue;
    let span = 1;
    if (day + 1 <= maxDay && isSundayNZ(day + 1)) span = 2;
    addBand(day, span);
  }

  return bands;
}

/**
 * Monday week ticks — left edge of each white work week.
 */
function buildGanttTimelineSchedule(minDay, maxDay, totalDays, pxPerDay) {
  const toPct = (day) => ganttDayLeftPct(day, minDay, totalDays);
  const labelTier = ganttRulerLabelTier(pxPerDay);

  let ticks = [];
  if (labelTier !== 'hidden') {
    const candidates = [];
    for (let day = minDay; day <= maxDay; day += 1) {
      if (!isMondayNZ(day) || isFirstOfMonthNZ(day)) continue;
      candidates.push({
        day,
        left: toPct(day),
        label: ganttWeekTickLabel(day, labelTier),
        labelTier,
      });
    }
    ticks = ganttFilterTicksByGap(
      candidates,
      minDay,
      pxPerDay,
      ganttMinLabelGapPx(labelTier),
    );
  }

  return {
    ticks,
    weekendBands: buildWeekendBands(minDay, maxDay, totalDays, pxPerDay),
  };
}

function isFirstOfMonthNZ(epochDay) {
  return new Date(ganttCivilUtcMs(epochDay)).getUTCDate() === 1;
}

function monthFirstNZ(epochDay) {
  const d = new Date(ganttCivilUtcMs(epochDay));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return daysFromEpoch(`${y}-${m}-01`);
}

function nextMonthFirstNZ(monthFirstDay) {
  const d = new Date(ganttCivilUtcMs(monthFirstDay));
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 2; // 1-based next month
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return daysFromEpoch(`${y}-${String(m).padStart(2, '0')}-01`);
}

function ganttYearNZ(epochDay) {
  return new Date(ganttCivilUtcMs(epochDay)).getUTCFullYear();
}

/** Drop year suffixes when consecutive month labels would collide. */
function ganttResolveMonthMarkerOverlaps(markers, minDay, pxPerDay) {
  if (markers.length < 2) return markers;
  const MIN_LABEL_GAP_PX = 8;
  const CHAR_W_PX = 7;
  const resolved = markers.map((m) => ({ ...m }));

  for (let i = 1; i < resolved.length; i += 1) {
    const prev = resolved[i - 1];
    const cur = resolved[i];
    const gapPx = ganttDayPx(cur.day, minDay, pxPerDay) - ganttDayPx(prev.day, minDay, pxPerDay);
    const prevWidthPx = prev.label.length * CHAR_W_PX;
    if (gapPx >= prevWidthPx + MIN_LABEL_GAP_PX) continue;

    const prevShort = ganttMonthNameNZ(prev.day, false);
    const curShort = ganttMonthNameNZ(cur.day, false);
    resolved[i - 1] = { ...prev, label: prevShort };
    resolved[i] = { ...cur, label: curShort };
  }

  return resolved;
}

/** Every month touching the range — labels sit on the 1st of each month. */
function buildMonthMarkers(minDay, maxDay, totalDays, rangeSpansYears, pxPerDay) {
  const toPct = (day) => ganttDayLeftPct(day, minDay, totalDays);
  const markers = [];
  let monthFirst = monthFirstNZ(minDay);
  let prevYear = null;

  while (monthFirst <= maxDay) {
    const year = ganttYearNZ(monthFirst);
    const showYear = rangeSpansYears && (prevYear === null || year !== prevYear);
    markers.push({
      day: monthFirst,
      left: toPct(Math.max(monthFirst, minDay)),
      label: ganttMonthNameNZ(monthFirst, showYear),
    });
    prevYear = year;
    monthFirst = nextMonthFirstNZ(monthFirst);
  }

  return ganttResolveMonthMarkerOverlaps(markers, minDay, pxPerDay);
}

/** Ruler month row: "Jul", "Aug" (optional year when range spans years). */
function ganttMonthNameNZ(epochDay, includeYear = false) {
  const opts = includeYear
    ? { timeZone: 'UTC', month: 'short', year: '2-digit' }
    : { timeZone: 'UTC', month: 'short' };
  return new Intl.DateTimeFormat('en-NZ', opts).format(new Date(ganttCivilUtcMs(epochDay)));
}

const GANTT_MOBILE_MQ = '(max-width: 768px)';

function useGanttMobileLayout() {
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(GANTT_MOBILE_MQ).matches
  );
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia(GANTT_MOBILE_MQ);
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return mobile;
}

/** Pixels per day on the timeline (horizontal scroll width). */
const GANTT_PX_PER_DAY = 3;
const GANTT_FOCUS_HEAD_DAYS = 14;
const GANTT_FOCUS_TAIL_DAYS = 62;
/** Press-and-hold before a phase can be dragged along the timeline. */
const PHASE_TIMELINE_HOLD_MS = 400;
/** Match --gantt-lead-w in gantt-timeline.css (10px pad + label + 4px gap). */
const GANTT_LEAD_W_DESKTOP = 124;
const GANTT_WEEKEND_BAND_MAX_PX = 10;
const FOCUS_ZOOM_STEPS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];

function defaultMainZoomStep(mobile = false) {
  if (mobile) {
    const mobileIdx = FOCUS_ZOOM_STEPS.indexOf(12);
    if (mobileIdx >= 0) return mobileIdx;
  }
  const idx = FOCUS_ZOOM_STEPS.indexOf(GANTT_PX_PER_DAY);
  return idx >= 0 ? idx : 1;
}

function defaultFocusZoomStep(totalDays) {
  const targetWidth = 1120;
  const idealPx = targetWidth / Math.max(totalDays, 1);
  let best = 0;
  for (let i = 0; i < FOCUS_ZOOM_STEPS.length; i += 1) {
    if (FOCUS_ZOOM_STEPS[i] <= idealPx + 0.5) best = i;
  }
  return best;
}

function getProjectTimelineDays(project) {
  const days = [];
  if (project?.startDate) days.push(daysFromEpoch(project.startDate));
  if (project?.endDate) days.push(daysFromEpoch(project.endDate));
  (project?.milestones || []).forEach((ph) => {
    if (ph.startDate) days.push(daysFromEpoch(ph.startDate));
    if (ph.endDate) days.push(daysFromEpoch(ph.endDate));
    (ph.tasks || []).forEach((task) => {
      if (task.startDate) days.push(daysFromEpoch(task.startDate));
      if (task.endDate) days.push(daysFromEpoch(task.endDate));
    });
  });
  (project?.markers || []).forEach((marker) => {
    if (marker.date) days.push(daysFromEpoch(marker.date));
  });
  return days;
}

function taskHasSchedule(task) {
  return Boolean(task?.startDate && task?.endDate);
}

function timelineDesignerRank(project, rank, tail) {
  const ids = getProjectDesignerIds(project);
  if (ids.length === 0) return tail;
  let best = tail;
  for (const id of ids) {
    const r = rank[id];
    if (r !== undefined && r < best) best = r;
  }
  return best;
}

/** Timeline rows: group by designer (sidebar roster order), then due date like project feed. */
function sortTimelineProjectsByDesigner(projects, designers) {
  const rank = Object.fromEntries(designers.map((d, i) => [d.id, i]));
  const tail = designers.length;
  return projects.slice().sort((a, b) => {
    const ra = timelineDesignerRank(a, rank, tail);
    const rb = timelineDesignerRank(b, rank, tail);
    if (ra !== rb) return ra - rb;
    return (a.endDate || '').localeCompare(b.endDate || '');
  });
}

// ── Timeline edit rail (focus Edit mode only) ────────────────────────────────
const MARKER_DRAG_MIME = 'application/x-ew-marker-id';

function TimelineEditRail({
  project,
  onPhaseDates,
  onTaskDates,
  onMarkerDate,
  onMarkerPatch,
  onMarkerRelink,
}) {
  const phases = project.milestones || [];
  const markers = project.markers || [];
  const [editingMarkerId, setEditingMarkerId] = useState(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draggingMarkerId, setDraggingMarkerId] = useState(null);
  const [dropTargetKey, setDropTargetKey] = useState(null);

  const beginTitleEdit = (marker) => {
    setEditingMarkerId(marker.id);
    setDraftTitle(marker.title || '');
  };

  const commitTitleEdit = (markerId) => {
    const nextTitle = draftTitle.trim();
    setEditingMarkerId(null);
    setDraftTitle('');
    if (!markerId || !onMarkerPatch) return;
    const current = markers.find((marker) => marker.id === markerId);
    if (!current) return;
    if ((current.title || '') === nextTitle) return;
    onMarkerPatch(markerId, { title: nextTitle });
  };

  const cancelTitleEdit = () => {
    setEditingMarkerId(null);
    setDraftTitle('');
  };

  const readDraggedMarkerId = (event) => (
    event.dataTransfer.getData(MARKER_DRAG_MIME)
      || event.dataTransfer.getData('text/plain')
      || draggingMarkerId
      || ''
  );

  const handleMarkerDragStart = (event, markerId) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(MARKER_DRAG_MIME, markerId);
    event.dataTransfer.setData('text/plain', markerId);
    setDraggingMarkerId(markerId);
  };

  const handleMarkerDragEnd = () => {
    setDraggingMarkerId(null);
    setDropTargetKey(null);
  };

  const handleDropTargetDragOver = (event, targetKey) => {
    const types = [...event.dataTransfer.types];
    if (
      !draggingMarkerId
      && !types.includes(MARKER_DRAG_MIME)
      && !types.includes('text/plain')
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetKey(targetKey);
  };

  const handleDropTargetDragLeave = (event, targetKey) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDropTargetKey((cur) => (cur === targetKey ? null : cur));
  };

  const handleDropOnTarget = (event, target) => {
    event.preventDefault();
    const markerId = readDraggedMarkerId(event);
    setDraggingMarkerId(null);
    setDropTargetKey(null);
    if (!markerId || !onMarkerRelink) return;
    onMarkerRelink(markerId, target);
  };

  return (
    <aside className="gantt-edit-rail" aria-label="Schedule editor">
      <div className="gantt-edit-rail-head">
        <span className="gantt-edit-rail-title">{project.name.trim() || 'Project'}</span>
        <p className="gantt-edit-rail-hint">
          Edit milestone names, or drag a milestone onto a phase or task to move it to that start date.
        </p>
      </div>

      <div className="gantt-edit-rail-table" role="table" aria-label="Phases and tasks">
        <div className="gantt-edit-rail-row gantt-edit-rail-row--head" role="row">
          <span className="gantt-edit-rail-col gantt-edit-rail-col--name" role="columnheader">Name</span>
          <span className="gantt-edit-rail-col gantt-edit-rail-col--date" role="columnheader">Start</span>
          <span className="gantt-edit-rail-col gantt-edit-rail-col--date" role="columnheader">End</span>
        </div>

        {phases.map((phase) => {
          const phaseTitle = phase.title.trim() || 'Phase';
          const phaseMarkers = markers.filter((marker) => marker.phaseKey === phase.phaseKey);
          const phaseDropKey = `phase:${phase.id}`;
          return (
            <div key={phase.id} className="gantt-edit-rail-group">
              <ScheduleStartEndRow
                rowClass="gantt-edit-rail-row--phase"
                name={phaseTitle}
                startDate={phase.startDate}
                endDate={phase.endDate}
                onChange={(patch) => onPhaseDates(phase.id, patch)}
                dropActive={dropTargetKey === phaseDropKey}
                onMarkerDragOver={(event) => handleDropTargetDragOver(event, phaseDropKey)}
                onMarkerDragLeave={(event) => handleDropTargetDragLeave(event, phaseDropKey)}
                onMarkerDrop={(event) => handleDropOnTarget(event, {
                  phaseKey: phase.phaseKey,
                  date: phase.startDate || '',
                  linkedTo: '',
                })}
              />

              {(phase.tasks || []).map((task) => {
                const taskTitle = task.title.trim() || 'Task';
                const taskDropKey = `task:${task.id}`;
                return (
                  <ScheduleStartEndRow
                    key={task.id}
                    rowClass="gantt-edit-rail-row--task"
                    name={taskTitle}
                    startDate={task.startDate}
                    endDate={task.endDate}
                    onChange={(patch) => onTaskDates(phase.id, task.id, patch)}
                    dropActive={dropTargetKey === taskDropKey}
                    onMarkerDragOver={(event) => handleDropTargetDragOver(event, taskDropKey)}
                    onMarkerDragLeave={(event) => handleDropTargetDragLeave(event, taskDropKey)}
                    onMarkerDrop={(event) => handleDropOnTarget(event, {
                      phaseKey: phase.phaseKey,
                      date: task.startDate || phase.startDate || '',
                      linkedTo: taskTitle,
                    })}
                  />
                );
              })}

              {phaseMarkers.map((marker) => {
                const displayTitle = marker.title.trim() || 'Milestone';
                const isEditing = editingMarkerId === marker.id;
                return (
                  <div
                    key={marker.id}
                    className={[
                      'gantt-edit-rail-row',
                      'gantt-edit-rail-row--marker',
                      draggingMarkerId === marker.id ? 'gantt-edit-rail-row--dragging' : '',
                    ].filter(Boolean).join(' ')}
                    role="row"
                    draggable={!isEditing}
                    onDragStart={(event) => handleMarkerDragStart(event, marker.id)}
                    onDragEnd={handleMarkerDragEnd}
                    title="Drag onto a phase or task to move this milestone"
                  >
                    <span className="gantt-edit-rail-col gantt-edit-rail-col--name" role="cell">
                      <span className="gantt-edit-rail-marker-dot" aria-hidden />
                      {isEditing ? (
                        <input
                          className="gantt-edit-rail-marker-title-input"
                          value={draftTitle}
                          autoFocus
                          aria-label="Milestone name"
                          onChange={(event) => setDraftTitle(event.target.value)}
                          onBlur={() => commitTitleEdit(marker.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelTitleEdit();
                            }
                          }}
                          onClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                        />
                      ) : (
                        <button
                          type="button"
                          className="gantt-edit-rail-marker-title-btn"
                          onClick={() => beginTitleEdit(marker)}
                          aria-label={`Edit milestone name: ${displayTitle}`}
                        >
                          {displayTitle}
                        </button>
                      )}
                    </span>
                    <span
                      className="gantt-edit-rail-col gantt-edit-rail-col--date"
                      role="cell"
                      onMouseDown={(event) => event.stopPropagation()}
                      onDragStart={(event) => event.preventDefault()}
                    >
                      <MilestoneSingleDatePicker
                        date={marker.date}
                        onChange={(date) => onMarkerDate(marker.id, date)}
                        className="gantt-edit-rail-date"
                        emptyLabel="Date"
                        ariaLabel={`Date for ${displayTitle}`}
                        rangeFormat="task"
                      />
                    </span>
                    <span className="gantt-edit-rail-col gantt-edit-rail-col--date" role="cell" />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ── Gantt Chart ───────────────────────────────────────────────────────────────
function GanttChart({
  projects,
  designers,
  onSelectProject,
  onUpdateProject,
  onRegisterNav,
  onFocusMetaChange,
  previewMode,
  focusProjectId,
  onFocusProjectHandled,
}) {
  const validProjects = projects.filter(p => p.startDate && p.endDate);
  if (!validProjects.length) {
    return <div className="empty-state">No projects with timelines yet.</div>;
  }
  return (
    <>
      {previewMode && (
        <div className="dev-timeline-banner" role="status">
          Local preview data — add Supabase keys to <code>.env.local</code> for live projects, or use{' '}
          <code>?preview=timeline</code> to force this view.
        </div>
      )}
      <GanttChartInner
        projects={validProjects}
        designers={designers}
        onSelectProject={previewMode ? undefined : onSelectProject}
        onUpdateProject={previewMode ? undefined : onUpdateProject}
        onRegisterNav={onRegisterNav}
        onFocusMetaChange={onFocusMetaChange}
        focusProjectId={focusProjectId}
        onFocusProjectHandled={onFocusProjectHandled}
      />
    </>
  );
}

function GanttChartInner({
  projects: validProjects,
  designers,
  onSelectProject,
  onUpdateProject,
  onRegisterNav,
  onFocusMetaChange,
  focusProjectId,
  onFocusProjectHandled,
}) {
  const scrollRef = useRef(null);
  const mobileLayout = useGanttMobileLayout();
  const todayDay = daysFromEpoch(today());
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [showOverview, setShowOverview] = useState(false);
  const [timelineEditMode, setTimelineEditMode] = useState(false);
  const timelineEditSnapshotRef = useRef(null);
  const focusBackRef = useRef(null);
  const focusChromeRef = useRef(null);
  const [focusControlsAlignPx, setFocusControlsAlignPx] = useState(0);

  useEffect(() => {
    if (!expandedProjectId) {
      setShowOverview(false);
      setTimelineEditMode(false);
      timelineEditSnapshotRef.current = null;
      setFocusControlsAlignPx(0);
    }
  }, [expandedProjectId]);

  const [mobileExpandedPhases, setMobileExpandedPhases] = useState(() => new Set());
  const [mainZoomStep, setMainZoomStep] = useState(() => defaultMainZoomStep(
    typeof window !== 'undefined' && window.matchMedia(GANTT_MOBILE_MQ).matches,
  ));
  const centerOnTodayPendingRef = useRef(true);
  const [focusZoomStep, setFocusZoomStep] = useState(0);
  const [resizePreviewProject, setResizePreviewProject] = useState(null);
  const resizePreviewRef = useRef(null);
  const phaseResizeActiveRef = useRef(false);
  const phaseMoveActiveRef = useRef(false);
  const phaseMoveSuppressClickRef = useRef(false);
  const [phaseMovePhaseId, setPhaseMovePhaseId] = useState(null);
  const [phaseMovePendingId, setPhaseMovePendingId] = useState(null);

  const timelineSections = useMemo(() => {
    const active = validProjects.filter((p) => !isPipelineStatus(p.status));
    const scheduled = validProjects.filter((p) => isPipelineStatus(p.status));
    return [
      {
        key: 'projects',
        label: 'Projects',
        projects: sortTimelineProjectsByDesigner(active, designers),
      },
      {
        key: 'schedule',
        label: 'Schedule',
        projects: sortTimelineProjectsByDesigner(scheduled, designers),
      },
    ].filter((section) => section.projects.length > 0);
  }, [validProjects, designers]);

  const orderedProjects = useMemo(
    () => timelineSections.flatMap((section) => section.projects),
    [timelineSections],
  );

  const focusedProject = useMemo(
    () => (expandedProjectId
      ? orderedProjects.find((p) => p.id === expandedProjectId) ?? null
      : null),
    [expandedProjectId, orderedProjects],
  );

  const timelineFocusProject = useMemo(() => {
    if (!focusedProject) return null;
    if (resizePreviewProject?.id === focusedProject.id) return resizePreviewProject;
    return focusedProject;
  }, [focusedProject, resizePreviewProject]);

  const focusRange = useMemo(() => {
    if (!timelineFocusProject) return null;
    const projectDays = getProjectTimelineDays(timelineFocusProject);
    const minStart = projectDays.length
      ? Math.min(...projectDays)
      : daysFromEpoch(timelineFocusProject.startDate);
    const maxEnd = projectDays.length
      ? Math.max(...projectDays)
      : daysFromEpoch(timelineFocusProject.endDate);
    const minDay = minStart - GANTT_FOCUS_HEAD_DAYS;
    const maxDay = maxEnd + GANTT_FOCUS_TAIL_DAYS;
    const totalDays = ganttTotalDays(minDay, maxDay);
    return { minDay, maxDay, totalDays };
  }, [timelineFocusProject]);

  useEffect(() => {
    if (!expandedProjectId || !focusRange) return;
    setFocusZoomStep(defaultFocusZoomStep(focusRange.totalDays));
  }, [expandedProjectId, focusRange]);

  const timelineView = useMemo(() => {
    const ganttLastDay = daysFromEpoch('2027-12-31');

    if (focusedProject && focusRange) {
      const pxPerDay = FOCUS_ZOOM_STEPS[focusZoomStep] ?? FOCUS_ZOOM_STEPS[0];
      return {
        minDay: focusRange.minDay,
        maxDay: focusRange.maxDay,
        totalDays: focusRange.totalDays,
        pxPerDay,
        focusMode: true,
      };
    }

    const allStarts = validProjects.map((p) => daysFromEpoch(p.startDate));
    const allEnds = validProjects.map((p) => daysFromEpoch(p.endDate));
    validProjects.forEach((p) => {
      if (!Array.isArray(p.milestones)) return;
      p.milestones.forEach((ph) => {
        if (ph.startDate) allStarts.push(daysFromEpoch(ph.startDate));
        if (ph.endDate) allEnds.push(daysFromEpoch(ph.endDate));
      });
    });
    const minStart = Math.min(...allStarts);
    const maxEnd = Math.max(...allEnds);
    let minDay = minStart - 14;
    let maxDay = Math.min(
      Math.max(maxEnd + 380, todayDay + 460, minStart + 120),
      ganttLastDay,
    );
    if (maxDay <= minDay) minDay = maxDay - 365;
    const totalDays = ganttTotalDays(minDay, maxDay);
    return {
      minDay,
      maxDay,
      totalDays,
      pxPerDay: FOCUS_ZOOM_STEPS[mainZoomStep] ?? GANTT_PX_PER_DAY,
      focusMode: false,
    };
  }, [focusedProject, focusRange, focusZoomStep, mainZoomStep, validProjects, todayDay]);

  const { minDay, maxDay, totalDays, pxPerDay, focusMode } = timelineView;
  /** Focus + mobile have no label column — tracks must match the full chart width. */
  const ganttLeadW = (!mobileLayout && !focusMode) ? GANTT_LEAD_W_DESKTOP : 0;
  const { chartMinWidthPx, trackWidthPx: chartTrackWidthPx } = ganttChartWidths(
    totalDays,
    pxPerDay,
    ganttLeadW,
  );
  const sectionsToRender = useMemo(
    () => (focusMode && timelineFocusProject
      ? [{ key: 'focus', label: null, projects: [timelineFocusProject] }]
      : timelineSections),
    [focusMode, timelineFocusProject, timelineSections],
  );

  const canResizePhases = Boolean(
    focusMode && timelineEditMode && !mobileLayout && onUpdateProject,
  );
  const canMovePhases = Boolean(focusMode && timelineEditMode && onUpdateProject);

  const beginTimelineEdit = useCallback(() => {
    if (!focusedProject || !onUpdateProject) return;
    timelineEditSnapshotRef.current = {
      id: focusedProject.id,
      startDate: focusedProject.startDate,
      endDate: focusedProject.endDate,
      milestones: JSON.parse(JSON.stringify(focusedProject.milestones || [])),
      markers: JSON.parse(JSON.stringify(focusedProject.markers || [])),
      linkedSchedule: Boolean(focusedProject.linkedSchedule),
    };
    setTimelineEditMode(true);
  }, [focusedProject, onUpdateProject]);

  const finishTimelineEdit = useCallback(() => {
    resizePreviewRef.current = null;
    setResizePreviewProject(null);
    setPhaseMovePhaseId(null);
    setPhaseMovePendingId(null);
    timelineEditSnapshotRef.current = null;
    setTimelineEditMode(false);
  }, []);

  const cancelTimelineEdit = useCallback(() => {
    const snap = timelineEditSnapshotRef.current;
    resizePreviewRef.current = null;
    setResizePreviewProject(null);
    setPhaseMovePhaseId(null);
    setPhaseMovePendingId(null);
    if (snap && onUpdateProject) {
      const current = validProjects.find((p) => p.id === snap.id);
      if (current) {
        onUpdateProject({
          ...current,
          startDate: snap.startDate,
          endDate: snap.endDate,
          milestones: snap.milestones,
          markers: snap.markers,
          linkedSchedule: snap.linkedSchedule,
        });
      }
    }
    timelineEditSnapshotRef.current = null;
    setTimelineEditMode(false);
  }, [onUpdateProject, validProjects]);

  const applyLinkedProjectUpdate = useCallback((nextProject) => {
    if (!onUpdateProject || !nextProject) return;
    onUpdateProject(nextProject);
  }, [onUpdateProject]);

  const handleEditRailPhaseDates = useCallback((phaseId, patch) => {
    if (!timelineFocusProject) return;
    applyLinkedProjectUpdate(
      updateProjectPhaseCustomDates(withLinkedSchedule(timelineFocusProject), phaseId, patch),
    );
  }, [applyLinkedProjectUpdate, timelineFocusProject]);

  const handleEditRailTaskDates = useCallback((phaseId, taskId, patch) => {
    if (!timelineFocusProject) return;
    applyLinkedProjectUpdate(
      updateProjectTaskDates(withLinkedSchedule(timelineFocusProject), phaseId, taskId, patch),
    );
  }, [applyLinkedProjectUpdate, timelineFocusProject]);

  const handleEditRailMarkerDate = useCallback((markerId, date) => {
    if (!timelineFocusProject) return;
    applyLinkedProjectUpdate(
      updateProjectMarkerDate(timelineFocusProject, markerId, date),
    );
  }, [applyLinkedProjectUpdate, timelineFocusProject]);

  const handleEditRailMarkerPatch = useCallback((markerId, patch) => {
    if (!timelineFocusProject) return;
    applyLinkedProjectUpdate(
      updateProjectMarker(timelineFocusProject, markerId, patch),
    );
  }, [applyLinkedProjectUpdate, timelineFocusProject]);

  const handleEditRailMarkerRelink = useCallback((markerId, target) => {
    if (!timelineFocusProject || !target?.phaseKey) return;
    const current = (timelineFocusProject.markers || []).find((marker) => marker.id === markerId);
    if (!current) return;
    applyLinkedProjectUpdate(
      updateProjectMarker(timelineFocusProject, markerId, {
        phaseKey: target.phaseKey,
        date: target.date || current.date || '',
        linkedTo: target.linkedTo || '',
      }),
    );
  }, [applyLinkedProjectUpdate, timelineFocusProject]);

  const exitFocusView = useCallback(() => {
    if (timelineEditMode) finishTimelineEdit();
    setExpandedProjectId(null);
  }, [timelineEditMode, finishTimelineEdit]);

  const pct = (day) => ganttDayLeftPct(day, minDay, totalDays);

  const minYear = new Date(minDay * 86400000).getUTCFullYear();
  const maxYear = new Date(maxDay * 86400000).getUTCFullYear();
  const monthLabelSpansYears = minYear !== maxYear;

  const monthMarkers = useMemo(
    () => buildMonthMarkers(minDay, maxDay, totalDays, monthLabelSpansYears, pxPerDay),
    [minDay, maxDay, totalDays, monthLabelSpansYears, pxPerDay],
  );

  const timelineSchedule = useMemo(
    () => buildGanttTimelineSchedule(
      minDay,
      maxDay,
      totalDays,
      pxPerDay,
    ),
    [minDay, maxDay, totalDays, pxPerDay],
  );
  const gridLines = timelineSchedule.ticks;
  const weekendBands = timelineSchedule.weekendBands;

  useEffect(() => {
    if (!onFocusMetaChange) return undefined;
    if (!focusMode || !timelineFocusProject) {
      onFocusMetaChange(null);
      return undefined;
    }
    onFocusMetaChange({
      id: timelineFocusProject.id,
      name: timelineFocusProject.name,
      startDate: timelineFocusProject.startDate,
      endDate: timelineFocusProject.endDate,
    });
    return () => onFocusMetaChange(null);
  }, [focusMode, onFocusMetaChange, timelineFocusProject]);

  useLayoutEffect(() => {
    if (!focusMode || !timelineFocusProject) {
      setFocusControlsAlignPx(0);
      return undefined;
    }

    const alignFocusControls = () => {
      const nameEl = document.querySelector('.page-title-focus-meta');
      const backEl = focusBackRef.current;
      const chromeEl = focusChromeRef.current;
      if (!nameEl || !backEl || !chromeEl) return;

      const gap = parseFloat(getComputedStyle(chromeEl).columnGap || getComputedStyle(chromeEl).gap) || 20;
      const next = Math.round(
        nameEl.getBoundingClientRect().left - backEl.getBoundingClientRect().right - gap,
      );
      setFocusControlsAlignPx((prev) => {
        const clamped = Math.max(0, next);
        return prev === clamped ? prev : clamped;
      });
    };

    alignFocusControls();
    const raf = window.requestAnimationFrame(alignFocusControls);
    window.addEventListener('resize', alignFocusControls);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', alignFocusControls);
    };
  }, [focusMode, timelineFocusProject, timelineEditMode, mobileLayout]);

  const todayPct = ganttDayCenterPct(todayDay, minDay, totalDays);

  const scrollTimelineBy = useCallback((direction) => {
    const el = scrollRef.current;
    if (!el) return;
    /** One calendar week in chart pixels (same scale as day columns). */
    const weekPx = pxPerDay * 7;
    const step = Math.max(1, Math.round(weekPx));
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  }, [pxPerDay]);

  const scrollToToday = useCallback((behavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollBehavior = behavior === 'auto' ? 'auto' : 'smooth';
    if (todayPct < 0 || todayPct > 100) {
      // In focused project view, today may sit outside the visible range —
      // pin to the nearest end instead of a no-op feel.
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      el.scrollTo({
        left: todayPct < 0 ? 0 : maxScroll,
        behavior: scrollBehavior,
      });
      return;
    }
    const x = ganttScrollLeftForTrackPct(todayPct, {
      leadW: ganttLeadW,
      trackWidthPx: chartTrackWidthPx,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    });
    el.scrollTo({ left: x, behavior: scrollBehavior });
  }, [todayPct, ganttLeadW, chartTrackWidthPx]);

  const updateJobLabelPins = useCallback(() => {
    const wrapper = scrollRef.current;
    if (!wrapper || focusMode) return;
    const stickPx = 15;
    const wrapperLeft = wrapper.getBoundingClientRect().left;
    wrapper.querySelectorAll('.gantt-lane-label--job[data-label-pct]').forEach((label) => {
      const labelPct = Number(label.dataset.labelPct);
      if (!Number.isFinite(labelPct)) return;
      const track = label.closest('.gantt-track');
      if (!track) return;
      const naturalLeftPx = (labelPct / 100) * track.offsetWidth;
      const trackLeft = track.getBoundingClientRect().left - wrapperLeft;
      const labelViewportLeft = trackLeft + naturalLeftPx;
      const pinOffset = Math.max(0, stickPx - labelViewportLeft);
      label.style.transform = pinOffset > 0 ? `translateX(${pinOffset}px)` : '';
    });
  }, [focusMode]);

  useLayoutEffect(() => {
    if (!mobileLayout) return;
    centerOnTodayPendingRef.current = true;
    setMainZoomStep((step) => {
      const desktopDefault = defaultMainZoomStep(false);
      const mobileDefault = defaultMainZoomStep(true);
      return step === desktopDefault ? mobileDefault : step;
    });
  }, [mobileLayout]);

  useLayoutEffect(() => {
    if (!centerOnTodayPendingRef.current || !scrollRef.current) return;
    scrollToToday('auto');
    centerOnTodayPendingRef.current = false;
    updateJobLabelPins();
  }, [chartMinWidthPx, todayPct, scrollToToday, focusMode, expandedProjectId, updateJobLabelPins]);

  useLayoutEffect(() => {
    if (!focusMode || !scrollRef.current) return;
    if (mobileLayout) {
      centerOnTodayPendingRef.current = true;
      return;
    }
    scrollRef.current.scrollTo({ left: 0, behavior: 'smooth' });
  }, [focusMode, expandedProjectId, mobileLayout]);

  useLayoutEffect(() => {
    if (focusMode) return undefined;
    const wrapper = scrollRef.current;
    if (!wrapper) return undefined;

    let raf = 0;
    const schedulePinUpdate = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateJobLabelPins);
    };

    schedulePinUpdate();
    wrapper.addEventListener('scroll', schedulePinUpdate, { passive: true });
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(schedulePinUpdate)
      : null;
    resizeObserver?.observe(wrapper);
    const chart = wrapper.querySelector('.gantt-chart');
    if (chart) resizeObserver?.observe(chart);

    return () => {
      cancelAnimationFrame(raf);
      wrapper.removeEventListener('scroll', schedulePinUpdate);
      resizeObserver?.disconnect();
    };
  }, [
    focusMode,
    updateJobLabelPins,
    chartMinWidthPx,
    expandedProjectId,
    sectionsToRender,
  ]);

  useEffect(() => {
    if (!focusProjectId) return;
    if (!validProjects.some((p) => p.id === focusProjectId)) {
      onFocusProjectHandled?.();
      return;
    }
    setExpandedProjectId(focusProjectId);
    centerOnTodayPendingRef.current = true;
    onFocusProjectHandled?.();
  }, [focusProjectId, validProjects, onFocusProjectHandled]);

  useEffect(() => {
    if (!expandedProjectId) {
      setMobileExpandedPhases(new Set());
      centerOnTodayPendingRef.current = true;
      return;
    }
    if (!mobileLayout) return;
    const project = orderedProjects.find((p) => p.id === expandedProjectId);
    if (!project?.milestones?.length) return;
    const todayIso = today();
    const activePhaseIds = project.milestones
      .filter((phase) => phase.startDate && phase.endDate
        && phase.startDate <= todayIso
        && phase.endDate >= todayIso)
      .map((phase) => `${project.id}:${phase.id}`);
    if (activePhaseIds.length > 0) {
      setMobileExpandedPhases(new Set(activePhaseIds));
    }
  }, [expandedProjectId, mobileLayout, orderedProjects]);

  const toggleMobilePhaseTasks = useCallback((projectId, phaseId) => {
    const key = `${projectId}:${phaseId}`;
    setMobileExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isMobilePhaseTasksOpen = useCallback(
    (projectId, phaseId) => mobileExpandedPhases.has(`${projectId}:${phaseId}`),
    [mobileExpandedPhases],
  );

  useLayoutEffect(() => {
    if (!onRegisterNav) return undefined;
    onRegisterNav({ scrollBy: scrollTimelineBy, scrollToToday });
    return () => onRegisterNav(null);
  }, [onRegisterNav, scrollTimelineBy, scrollToToday]);

  useEffect(() => {
    if (expandedProjectId) return undefined;
    setResizePreviewProject(null);
    resizePreviewRef.current = null;
    setPhaseMovePhaseId(null);
    setPhaseMovePendingId(null);
    return undefined;
  }, [expandedProjectId]);

  const beginPhaseResize = useCallback((event, project, phase) => {
    if (!onUpdateProject || !phase?.startDate) return;
    event.preventDefault();
    event.stopPropagation();

    const track = event.currentTarget.closest('.gantt-track');
    if (!track) return;

    const handleEl = event.currentTarget;
    phaseResizeActiveRef.current = true;
    document.body.classList.add('gantt-phase-resize-active');

    const pointerId = event.pointerId;
    handleEl.setPointerCapture?.(pointerId);
    const isCustom = phase.scheduleMode === 'custom';

    const applyFromPointer = (clientX) => {
      const dayNum = pointerDayFromTrack(clientX, track, minDay, totalDays);
      const phaseStartDay = daysFromEpoch(phase.startDate);
      const linkedProject = withLinkedSchedule(project);
      let next;
      if (isCustom) {
        const endIso = isoFromTimelineDay(Math.max(dayNum, phaseStartDay), phase.startDate);
        next = updateProjectPhaseEndDate(linkedProject, phase.id, endIso);
      } else {
        const rawDays = Math.max(1, dayNum - phaseStartDay + 1);
        const weeks = normalizeDurationWeeks(Math.max(1, Math.round(rawDays / 7)), MIN_MILESTONE_WEEKS);
        next = updateProjectPhaseDurationWeeks(linkedProject, phase.id, weeks);
      }
      resizePreviewRef.current = next;
      setResizePreviewProject(next);
    };

    applyFromPointer(event.clientX);

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      applyFromPointer(moveEvent.clientX);
    };

    const finish = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      document.body.classList.remove('gantt-phase-resize-active');
      phaseResizeActiveRef.current = false;
      handleEl.releasePointerCapture?.(pointerId);
      const committed = resizePreviewRef.current;
      resizePreviewRef.current = null;
      setResizePreviewProject(null);
      if (committed && onUpdateProject) onUpdateProject(committed);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }, [minDay, onUpdateProject, totalDays]);

  const beginPhaseMove = useCallback((event, project, phase) => {
    if (!onUpdateProject || !phase?.startDate || !phase?.endDate) return;
    if (event.target.closest('.gantt-bar-resize-handle')) return;

    const surfaceEl = event.currentTarget;
    const track = surfaceEl.querySelector('.gantt-track--phase-lane');
    if (!track) return;

    const pointerId = event.pointerId;
    let dragActive = false;
    let holdTimer = null;
    let pendingTimer = null;
    const startX = event.clientX;
    let lastClientX = startX;
    const phaseStartDay = daysFromEpoch(phase.startDate);
    let grabDayOffset = pointerDayFromTrack(startX, track, minDay, totalDays) - phaseStartDay;

    const applyFromPointer = (clientX) => {
      const pointerDay = pointerDayFromTrack(clientX, track, minDay, totalDays);
      const newStartIso = isoFromTimelineDay(pointerDay - grabDayOffset, phase.startDate);
      const next = updateProjectPhaseStartDate(project, phase.id, newStartIso);
      resizePreviewRef.current = next;
      setResizePreviewProject(next);
    };

    const finish = (upEvent) => {
      if (upEvent && upEvent.pointerId !== pointerId) return;
      clearTimeout(holdTimer);
      clearTimeout(pendingTimer);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      setPhaseMovePendingId(null);
      setPhaseMovePhaseId(null);

      if (dragActive) {
        upEvent?.preventDefault();
        upEvent?.stopPropagation();
        phaseMoveSuppressClickRef.current = true;
        window.setTimeout(() => {
          phaseMoveSuppressClickRef.current = false;
        }, 0);
        document.body.classList.remove('gantt-phase-move-active');
        phaseMoveActiveRef.current = false;
        surfaceEl.releasePointerCapture?.(pointerId);
        const committed = resizePreviewRef.current;
        resizePreviewRef.current = null;
        setResizePreviewProject(null);
        if (committed && onUpdateProject) onUpdateProject(committed);
      }
    };

    const startDrag = () => {
      dragActive = true;
      grabDayOffset = pointerDayFromTrack(lastClientX, track, minDay, totalDays) - phaseStartDay;
      phaseMoveActiveRef.current = true;
      setPhaseMovePendingId(null);
      setPhaseMovePhaseId(phase.id);
      document.body.classList.add('gantt-phase-move-active');
      surfaceEl.setPointerCapture?.(pointerId);
      applyFromPointer(lastClientX);
    };

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      lastClientX = moveEvent.clientX;
      if (!dragActive) return;
      moveEvent.preventDefault();
      applyFromPointer(moveEvent.clientX);
    };

    pendingTimer = setTimeout(() => {
      if (!dragActive) setPhaseMovePendingId(phase.id);
    }, Math.round(PHASE_TIMELINE_HOLD_MS * 0.55));

    holdTimer = setTimeout(startDrag, PHASE_TIMELINE_HOLD_MS);

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }, [minDay, onUpdateProject, totalDays]);

  const renderGanttBar = ({
    startDate,
    endDate,
    labelPrimary,
    labelSecondary,
    colors,
    barClass = '',
    styleOverrides = {},
    isWaiting = false,
    isComplete = false,
    isAwaitingStart = false,
    showLabels = true,
    resizable = false,
    resizeLabel = 'phase',
    onResizeStart,
    isResizing = false,
  }) => {
    if (!startDate || !endDate) return null;
    const startDay = daysFromEpoch(startDate);
    const endDay = daysFromEpoch(endDate);
    const { left: startPct, width: widthPct } = ganttInclusiveBarPct(
      startDay,
      endDay,
      minDay,
      totalDays,
    );
    const hasLabels = showLabels && (labelPrimary || labelSecondary);
    const isBandBar = /\bgantt-bar--(?:job|phase|task|overview)\b/.test(barClass);
    const isTaskBand = barClass.includes('gantt-bar--task');
    const bandColor = isComplete ? '#C7C7CC' : colors.bar;
    return (
      <div
        className={[
          'gantt-bar',
          barClass,
          resizable ? 'gantt-bar--resizable' : '',
          isResizing ? 'gantt-bar--resizing' : '',
        ].filter(Boolean).join(' ')}
        style={{
          left: `${startPct}%`,
          width: `${Math.max(widthPct, 0.35)}%`,
          background: isBandBar ? bandColor : (isComplete ? '#F2F2F7' : colors.bg),
          opacity: isBandBar
            ? (isTaskBand
              ? (isAwaitingStart ? 0.22 : isComplete ? 0.28 : 0.34)
              : (isAwaitingStart ? 0.5 : barClass.includes('gantt-bar--overview') ? 0.45 : 1))
            : (isWaiting ? 0.55 : isAwaitingStart ? 0.62 : 1),
          backgroundImage: isBandBar
            ? 'none'
            : (isWaiting
              ? `repeating-linear-gradient(-45deg, transparent, transparent 4px, ${colors.bar}18 4px, ${colors.bar}18 8px)`
              : isAwaitingStart
                ? `repeating-linear-gradient(90deg, transparent, transparent 5px, ${colors.bar}14 5px, ${colors.bar}14 10px)`
                : 'none'),
          ...(isBandBar ? {} : styleOverrides),
        }}
      >
        {hasLabels ? (
          <div
            className="gantt-bar-label-stack"
            style={{ color: isComplete ? 'rgba(60, 60, 67, 0.45)' : colors.text }}
          >
            {labelPrimary ? <span className="gantt-bar-client">{labelPrimary}</span> : null}
            {labelSecondary ? <span className="gantt-bar-project">{labelSecondary}</span> : null}
          </div>
        ) : null}
        {resizable ? (
          <div
            className="gantt-bar-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label={`Resize ${resizeLabel}`}
            onPointerDown={onResizeStart}
            onClick={(e) => e.stopPropagation()}
          />
        ) : null}
      </div>
    );
  };

  const renderJobAvatarPopover = (startDate, designers) => {
    if (mobileLayout || !startDate || !designers?.length) return null;
    const left = pct(daysFromEpoch(startDate));
    return (
      <div
        className="gantt-job-avatar-popover"
        style={{ left: `${left}%` }}
      >
        <DesignerAvatarStack
          designers={designers}
          size={22}
          maxVisible={3}
          className="designer-avatar-stack--gantt"
        />
      </div>
    );
  };

  const renderLaneLabel = (startDate, text, variant = 'phase') => {
    if (!startDate || !text?.trim()) return null;
    const left = pct(daysFromEpoch(startDate));
    return (
      <div
        className={[
          'gantt-lane-label',
          `gantt-lane-label--${variant}`,
        ].filter(Boolean).join(' ')}
        style={{ left: `${left}%` }}
        title={text}
      >
        <span className="gantt-lane-label-text">{text}</span>
      </div>
    );
  };

  const renderPhaseMarkers = (markers, phaseKey, colors) => {
    const list = (markers || []).filter((marker) => (
      marker?.date && marker.phaseKey === phaseKey
    ));
    if (!list.length) return null;
    const barColor = colors?.bar || '#8B978C';
    return list.map((marker) => {
      const left = ganttDayCenterPct(daysFromEpoch(marker.date), minDay, totalDays);
      const dateLabel = formatMarkerDateLabel(marker.date);
      const title = marker.title.trim() || 'Milestone';
      const tip = [dateLabel, title, marker.linkedTo ? `Linked: ${marker.linkedTo}` : '']
        .filter(Boolean)
        .join(' · ');
      return (
        <div
          key={marker.id}
          className="gantt-marker"
          style={{ left: `${left}%`, color: barColor }}
          title={tip}
          aria-label={tip}
          tabIndex={0}
        >
          <span className="gantt-marker-dot" aria-hidden />
          <span className="gantt-marker-hover">
            <span className="gantt-marker-date">{dateLabel}</span>
            <span className="gantt-marker-title">{title}</span>
          </span>
        </div>
      );
    });
  };

  const renderJobLaneLabel = (startDate, client, projectName) => {
    if (!startDate) return null;
    const clientText = client?.trim() || '';
    const projectText = projectName?.trim() || '';
    if (!clientText && !projectText) return null;
    const left = pct(daysFromEpoch(startDate));
    const title = [clientText, projectText].filter(Boolean).join(' — ');
    return (
      <div
        className={[
          'gantt-lane-label',
          'gantt-lane-label--job',
        ].filter(Boolean).join(' ')}
        style={{ left: `${left}%` }}
        data-label-pct={left}
        title={title}
      >
        {clientText ? <span className="gantt-lane-label-client">{clientText}</span> : null}
        {clientText && projectText ? (
          <span className="gantt-lane-label-sep" aria-hidden> </span>
        ) : null}
        {projectText ? <span className="gantt-lane-label-project">{projectText}</span> : null}
      </div>
    );
  };

  const renderPhaseTaskRow = (project, phase, task, {
    allowEdit = true,
    colors,
    isComplete = false,
    isAwaitingStart = false,
    readonly = false,
  } = {}) => {
    const taskTitle = task.title.trim() || 'Task';
    const dated = taskHasSchedule(task);
    const labelStart = dated ? task.startDate : phase.startDate;
    return (
      <div
        key={task.id}
        className={[
          'gantt-row',
          'gantt-row--task',
          dated ? 'gantt-row--task-scheduled' : 'gantt-row--task-checklist',
          'gantt-row--track-only',
          readonly ? 'gantt-row--readonly' : '',
        ].filter(Boolean).join(' ')}
        {...(allowEdit && !readonly
          ? editableRowProps(project, `Edit ${project.name} — ${taskTitle}`)
          : {})}
      >
        <div
          className={[
            'gantt-track',
            'gantt-track--lane',
            dated ? 'gantt-track--task-lane' : 'gantt-track--task-checklist',
          ].filter(Boolean).join(' ')}
        >
          {renderLaneLabel(labelStart, taskTitle, 'task')}
          {dated
            ? renderGanttBar({
              startDate: task.startDate,
              endDate: task.endDate,
              colors,
              barClass: 'gantt-bar--task',
              showLabels: false,
              isComplete,
              isAwaitingStart,
            })
            : null}
        </div>
      </div>
    );
  };

  const renderMobilePhaseTasks = (project, phase, colors, { isComplete = false, isAwaitingStart = false } = {}) => {
    if (!mobileLayout || phase.tasks.length === 0) return null;
    if (!isMobilePhaseTasksOpen(project.id, phase.id)) return null;
    return (
      <div className="gantt-task-stack gantt-task-stack--mobile">
        {phase.tasks.map((task) => renderPhaseTaskRow(project, phase, task, {
          allowEdit: false,
          colors,
          isComplete,
          isAwaitingStart,
          readonly: true,
        }))}
      </div>
    );
  };

  const renderDesktopPhaseTasks = (project, phase, {
    allowEdit = true,
    colors,
    isComplete = false,
    isAwaitingStart = false,
  } = {}) => {
    if (phase.tasks.length === 0) return null;
    return (
      <div className="gantt-task-stack">
        {phase.tasks.map((task) => renderPhaseTaskRow(project, phase, task, {
          allowEdit,
          colors,
          isComplete,
          isAwaitingStart,
        }))}
      </div>
    );
  };

  const openProjectEdit = (project) => {
    if (!onSelectProject || phaseResizeActiveRef.current || phaseMoveActiveRef.current) return;
    if (phaseMoveSuppressClickRef.current) return;
    onSelectProject(project);
  };

  const editableRowProps = (project, label) => {
    if (!onSelectProject) return {};
    return {
      role: 'button',
      tabIndex: 0,
      'aria-label': label,
      onClick: () => openProjectEdit(project),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openProjectEdit(project);
        }
      },
    };
  };

  const mobilePhaseRowProps = (project, phase, phaseTitle) => {
    if (focusMode) {
      if (!mobileLayout || phase.tasks.length === 0) return {};
      const tasksOpen = isMobilePhaseTasksOpen(project.id, phase.id);
      const taskCount = phase.tasks.length;
      return {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': tasksOpen,
        'aria-label': `${tasksOpen ? 'Hide' : 'Show'} ${taskCount} task${taskCount !== 1 ? 's' : ''} for ${phaseTitle}`,
        onClick: (e) => {
          if (phaseMoveSuppressClickRef.current) return;
          e.stopPropagation();
          toggleMobilePhaseTasks(project.id, phase.id);
        },
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleMobilePhaseTasks(project.id, phase.id);
          }
        },
      };
    }
    if (!mobileLayout) {
      return editableRowProps(project, `Edit ${project.name} — ${phaseTitle}`);
    }
    if (phase.tasks.length === 0) return {};
    const tasksOpen = isMobilePhaseTasksOpen(project.id, phase.id);
    const taskCount = phase.tasks.length;
    return {
      role: 'button',
      tabIndex: 0,
      'aria-expanded': tasksOpen,
      'aria-label': `${tasksOpen ? 'Hide' : 'Show'} ${taskCount} task${taskCount !== 1 ? 's' : ''} for ${phaseTitle}`,
      onClick: (e) => {
        e.stopPropagation();
        toggleMobilePhaseTasks(project.id, phase.id);
      },
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleMobilePhaseTasks(project.id, phase.id);
        }
      },
    };
  };

  const handleProjectRowClick = (project) => {
    if (!onSelectProject) return;
    if (focusMode) return;
    if (projectHasMilestones(project)) {
      setExpandedProjectId((cur) => (cur === project.id ? null : project.id));
      return;
    }
    openProjectEdit(project);
  };

  const phaseGroupMoveProps = (project, phase, phaseTitle) => {
    if (!canMovePhases) return {};
    return {
      onPointerDown: (e) => beginPhaseMove(e, project, phase),
      'aria-label': `Move ${phaseTitle} on timeline. Press and hold, then drag.`,
    };
  };

  const zoomStep = focusMode ? focusZoomStep : mainZoomStep;
  const setZoomStep = focusMode ? setFocusZoomStep : setMainZoomStep;

  const changeZoomStep = useCallback((delta) => {
    centerOnTodayPendingRef.current = true;
    setZoomStep((s) => Math.max(0, Math.min(FOCUS_ZOOM_STEPS.length - 1, s + delta)));
  }, [setZoomStep]);

  // Trackpad pinch (ctrl/meta + wheel) and ⌘/Ctrl + − to zoom the timeline.
  useEffect(() => {
    const wrapper = scrollRef.current;
    if (!wrapper) return undefined;

    let wheelAcc = 0;
    const onWheel = (event) => {
      // Pinch-zoom on trackpads reports as wheel with ctrlKey (Chrome/Safari/Firefox).
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      wheelAcc += event.deltaY;
      if (Math.abs(wheelAcc) < 28) return;
      changeZoomStep(wheelAcc > 0 ? -1 : 1);
      wheelAcc = 0;
    };

    const isEditableTarget = (target) => {
      if (!(target instanceof Element)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      const zoomIn = event.key === '=' || event.key === '+'
        || event.code === 'Equal' || event.code === 'NumpadAdd';
      const zoomOut = event.key === '-' || event.key === '_'
        || event.code === 'Minus' || event.code === 'NumpadSubtract';
      if (!zoomIn && !zoomOut) return;

      event.preventDefault();
      changeZoomStep(zoomIn ? 1 : -1);
    };

    wrapper.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      wrapper.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [changeZoomStep, focusMode, chartMinWidthPx]);

  const timelineToolCluster = (
    <div className="gantt-toolbar gantt-toolbar--tools" role="toolbar" aria-label="Timeline tools">
      <div className="gantt-toolbar-inner gantt-toolbar-inner--bubble">
        <button
          type="button"
          className="gantt-nav-btn gantt-nav-btn--icon"
          onClick={() => changeZoomStep(-1)}
          disabled={zoomStep <= 0}
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="gantt-nav-btn gantt-nav-btn--icon"
          onClick={() => changeZoomStep(1)}
          disabled={zoomStep >= FOCUS_ZOOM_STEPS.length - 1}
          aria-label="Zoom in"
        >
          +
        </button>
        <span className="gantt-toolbar-divider" aria-hidden />
        <button
          type="button"
          className="gantt-nav-btn gantt-nav-btn--arrow"
          onClick={() => scrollTimelineBy(-1)}
          aria-label="Pan timeline left"
        >
          ‹
        </button>
        <button
          type="button"
          className="gantt-nav-btn gantt-nav-btn--today"
          onClick={() => scrollToToday()}
        >
          Today
        </button>
        <button
          type="button"
          className="gantt-nav-btn gantt-nav-btn--arrow"
          onClick={() => scrollTimelineBy(1)}
          aria-label="Pan timeline right"
        >
          ›
        </button>
      </div>
    </div>
  );

  const renderWeekendBands = (keyPrefix) => (
    <>
      {weekendBands.map((band) => (
        <div
          key={`${keyPrefix}-${band.key}`}
          className="gantt-weekend-band"
          style={{ left: `${band.left}%`, width: `${band.widthPx}px` }}
        />
      ))}
    </>
  );

  return (
    <>
    <div
      className={[
        'gantt-frame',
        focusMode ? 'gantt-frame--focused' : '',
        focusMode && timelineEditMode ? 'gantt-frame--editing' : '',
      ].filter(Boolean).join(' ')}
    >
      <div
        ref={focusChromeRef}
        className={[
          'gantt-timeline-chrome',
          focusMode && timelineFocusProject ? 'gantt-timeline-chrome--focus' : '',
          focusMode && timelineEditMode ? 'gantt-timeline-chrome--editing' : '',
        ].filter(Boolean).join(' ')}
      >
        {focusMode && timelineFocusProject ? (
          <>
            <button
              ref={focusBackRef}
              type="button"
              className="sheet-milestone-add-task gantt-focus-back"
              onClick={exitFocusView}
              aria-label="Back to all jobs"
            >
              <span className="gantt-focus-back-icon" aria-hidden>‹</span>
            </button>
            <div
              className="gantt-focus-controls"
              style={focusControlsAlignPx > 0 ? { marginLeft: focusControlsAlignPx } : undefined}
            >
              {timelineEditMode ? (
                <>
                  <span className="gantt-focus-edit-badge" aria-live="polite">Editing</span>
                  <button
                    type="button"
                    className="gantt-export-btn gantt-focus-action-btn"
                    onClick={cancelTimelineEdit}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="gantt-export-btn gantt-focus-action-btn gantt-focus-action-btn--primary"
                    onClick={finishTimelineEdit}
                  >
                    Done
                  </button>
                </>
              ) : (
                <>
                  {onUpdateProject ? (
                    <button
                      type="button"
                      className="gantt-export-btn gantt-focus-action-btn"
                      onClick={beginTimelineEdit}
                      disabled={!projectHasMilestones(timelineFocusProject)}
                      title={
                        projectHasMilestones(timelineFocusProject)
                          ? 'Edit schedule beside the timeline'
                          : 'Add milestones to edit schedule'
                      }
                    >
                      Edit
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="gantt-export-btn gantt-focus-action-btn"
                    onClick={() => setShowOverview(true)}
                    disabled={!projectHasMilestones(timelineFocusProject)}
                    title={!projectHasMilestones(timelineFocusProject) ? 'Add milestones to export' : 'Export timeline overview'}
                  >
                    Export
                  </button>
                </>
              )}
            </div>
            {timelineToolCluster}
          </>
        ) : (
          <div className="gantt-timeline-chrome-main">
            {timelineToolCluster}
          </div>
        )}
      </div>
      {focusMode && timelineEditMode ? (
        <p className="gantt-focus-edit-hint" role="status">
          Changes update the timeline. Cancel restores the previous dates.
        </p>
      ) : null}
      <div
        className={
          focusMode && timelineEditMode && !mobileLayout && timelineFocusProject
            ? 'gantt-edit-layout'
            : 'gantt-edit-layout--passthrough'
        }
      >
        {focusMode && timelineEditMode && !mobileLayout && timelineFocusProject ? (
          <TimelineEditRail
            project={timelineFocusProject}
            onPhaseDates={handleEditRailPhaseDates}
            onTaskDates={handleEditRailTaskDates}
            onMarkerDate={handleEditRailMarkerDate}
            onMarkerPatch={handleEditRailMarkerPatch}
            onMarkerRelink={handleEditRailMarkerRelink}
          />
        ) : null}
        <div className="gantt-wrapper" ref={scrollRef}>
          <div
            className={[
              'gantt-chart',
              mobileLayout ? 'gantt-chart--mobile' : '',
              focusMode ? 'gantt-chart--focused' : '',
              focusMode && timelineEditMode ? 'gantt-chart--editing' : '',
            ].filter(Boolean).join(' ')}
            style={{ minWidth: chartMinWidthPx }}
          >
          <div className="gantt-chart-weekends" aria-hidden>
            {ganttLeadW > 0 ? (
              <>
                <div className="gantt-lines-spacer" />
                <div className="gantt-weekend-track">
                  {renderWeekendBands('wknd')}
                </div>
              </>
            ) : (
              <div className="gantt-weekend-track">
                {renderWeekendBands('wknd')}
              </div>
            )}
          </div>
          {todayPct >= 0 && todayPct <= 100 && (
            <div className="gantt-chart-today" aria-hidden>
              {ganttLeadW > 0 ? (
                <>
                  <div className="gantt-lines-spacer" />
                  <div className="gantt-today-track">
                    <div
                      className="gantt-today-marker"
                      style={{ left: `${todayPct}%` }}
                    />
                  </div>
                </>
              ) : (
                <div className="gantt-today-track">
                  <div
                    className="gantt-today-marker"
                    style={{ left: `${todayPct}%` }}
                  />
                </div>
              )}
            </div>
          )}
          <div className={`gantt-chart-header${focusMode ? ' gantt-chart-header--focus' : ''}`}>
          {ganttLeadW > 0 ? <div className="gantt-lines-spacer" aria-hidden /> : null}
          <div className="gantt-ruler">
            <div className="gantt-ruler-months">
              {monthMarkers.map((m) => (
                <span
                  key={m.day}
                  className="gantt-ruler-month"
                  style={{ left: `${m.left}%` }}
                >
                  {m.label}
                </span>
              ))}
            </div>
            <div className={`gantt-ruler-ticks${mobileLayout ? ' gantt-ruler-ticks--mobile' : ''}`}>
              {gridLines.map((line) => (
                <div
                  key={line.day}
                  className="gantt-tick"
                  style={{ left: `${line.left}%` }}
                >
                  <span
                    className={[
                      'gantt-tick-label',
                      line.labelTier === 'full' ? 'gantt-tick-label--week-full' : '',
                      line.labelTier === 'day' ? 'gantt-tick-label--week-day' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {line.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
          </div>

          <div className="gantt-chart-body">
          <div className="gantt-rows">
            {sectionsToRender.map((section, sectionIndex) => (
              <Fragment key={section.key}>
                {!focusMode && section.label ? (
                  <>
                    {sectionIndex > 0 ? <div className="gantt-section-rule" aria-hidden /> : null}
                    <div
                      className="gantt-section-header"
                      role="heading"
                      aria-level={3}
                    >
                      <span className="gantt-section-header-title">{section.label}</span>
                    </div>
                  </>
                ) : null}
            {section.projects.map((project) => {
              const assignedDesigners = getProjectDesigners(project, designers);
              const designer = assignedDesigners[0];
              const colors = designer ? getDesignerPalette(designer) : { bg: '#EEE', bar: '#CCC', text: '#888' };
              const isWaiting = project.status === 'In Review';
              const isComplete = project.status === 'Complete';
              const isAwaitingStart = isPipelineStatus(normalizeProjectStatus(project.status));
              const hasMilestones = projectHasMilestones(project);
              const isExpanded = focusMode || expandedProjectId === project.id;
              const canInteract = Boolean(onSelectProject);

              return (
                <div
                  key={project.id}
                  className={[
                    'gantt-job-group',
                    isExpanded ? 'gantt-job-group--open' : '',
                    hasMilestones ? 'gantt-job-group--has-milestones' : '',
                    focusMode && isExpanded ? 'gantt-job-group--focus-layout' : '',
                  ].filter(Boolean).join(' ')}
                >
                  {focusMode && isExpanded && hasMilestones ? (
                    <div className="gantt-job-focus-wrap">
                      <div className="gantt-job-focus-body">
                        <div
                          className="gantt-row gantt-row--job gantt-row--track-only"
                        >
                          <div className="gantt-track">
                            {renderJobAvatarPopover(project.startDate, assignedDesigners)}
                            {renderGanttBar({
                              startDate: project.startDate,
                              endDate: project.endDate,
                              colors,
                              isWaiting,
                              isComplete,
                              isAwaitingStart,
                              barClass: 'gantt-bar--overview gantt-bar--bare',
                              showLabels: false,
                            })}
                          </div>
                        </div>
                        <div className="gantt-job-phases">
                          {project.milestones.map((phase, phaseIndex) => {
                            const phaseTitle = phase.title.trim() || `Phase ${phaseIndex + 1}`;
                            return (
                              <div
                                key={phase.id}
                                className={[
                                  'gantt-phase-group',
                                  timelineEditMode ? 'gantt-phase-group--editable' : '',
                                  canMovePhases ? 'gantt-phase-group--movable' : '',
                                  phaseMovePhaseId === phase.id ? 'gantt-phase-group--moving' : '',
                                  phaseMovePendingId === phase.id ? 'gantt-phase-group--pending' : '',
                                ].filter(Boolean).join(' ')}
                                {...phaseGroupMoveProps(project, phase, phaseTitle)}
                              >
                                <div
                                  className={[
                                    'gantt-row',
                                    'gantt-row--phase',
                                    'gantt-row--track-only',
                                    mobileLayout && phase.tasks.length > 0 ? 'gantt-row--phase-expandable' : '',
                                  ].filter(Boolean).join(' ')}
                                  {...(mobileLayout
                                    ? mobilePhaseRowProps(project, phase, phaseTitle)
                                    : {})}
                                >
                                  <div className="gantt-track gantt-track--lane gantt-track--phase-lane">
                                    {renderLaneLabel(phase.startDate, phaseTitle, 'phase')}
                                    {renderGanttBar({
                                      startDate: phase.startDate,
                                      endDate: phase.endDate,
                                      colors,
                                      barClass: 'gantt-bar--phase',
                                      showLabels: false,
                                      resizable: canResizePhases,
                                      resizeLabel: phaseTitle,
                                      isResizing: resizePreviewProject?.id === project.id,
                                      onResizeStart: canResizePhases
                                        ? (e) => beginPhaseResize(e, project, phase)
                                        : undefined,
                                    })}
                                    {renderPhaseMarkers(project.markers, phase.phaseKey, colors)}
                                  </div>
                                </div>
                                {mobileLayout
                                  ? renderMobilePhaseTasks(project, phase, colors, { isComplete, isAwaitingStart })
                                  : renderDesktopPhaseTasks(project, phase, {
                                    allowEdit: false,
                                    colors,
                                    isComplete,
                                    isAwaitingStart,
                                  })}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : (
                  <>
                  <div
                    className={`gantt-row gantt-row--job${isExpanded ? ' gantt-row--expanded' : ''}${hasMilestones ? ' gantt-row--has-milestones' : ''}`}
                    role={canInteract ? 'button' : undefined}
                    tabIndex={canInteract ? 0 : undefined}
                    aria-expanded={hasMilestones ? isExpanded : undefined}
                    aria-label={
                      canInteract
                        ? hasMilestones
                          ? `${isExpanded ? 'Collapse' : 'Expand'} ${project.name} milestones`
                          : `Edit ${project.name}`
                        : undefined
                    }
                    onClick={() => handleProjectRowClick(project)}
                    onKeyDown={(e) => {
                      if (!canInteract) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleProjectRowClick(project);
                      }
                    }}
                  >
                    <div className="gantt-label gantt-label--ghost" aria-hidden />
                    <div
                      className={[
                        'gantt-track',
                        !isExpanded ? 'gantt-track--lane gantt-track--job-lane' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      {!isExpanded ? renderJobLaneLabel(project.startDate, project.client, project.name) : null}
                      {renderJobAvatarPopover(project.startDate, assignedDesigners)}
                      {renderGanttBar({
                        startDate: project.startDate,
                        endDate: project.endDate,
                        colors,
                        isWaiting,
                        isComplete,
                        isAwaitingStart,
                        barClass: [
                          !isExpanded ? 'gantt-bar--job' : '',
                          hasMilestones && isExpanded ? 'gantt-bar--overview' : '',
                          isExpanded ? 'gantt-bar--bare' : '',
                        ].filter(Boolean).join(' '),
                        showLabels: false,
                      })}
                    </div>
                  </div>

                  {hasMilestones && isExpanded && !focusMode ? (
                    <div className="gantt-job-phases">
                      {project.milestones.map((phase, phaseIndex) => {
                        const phaseTitle = phase.title.trim() || `Phase ${phaseIndex + 1}`;
                        return (
                        <div key={phase.id} className="gantt-phase-group">
                          <div
                            className={[
                              'gantt-row',
                              'gantt-row--phase',
                              mobileLayout && phase.tasks.length > 0 ? 'gantt-row--phase-expandable' : '',
                            ].filter(Boolean).join(' ')}
                            {...(mobileLayout
                              ? mobilePhaseRowProps(project, phase, phaseTitle)
                              : editableRowProps(project, `Edit ${project.name} — ${phaseTitle}`))}
                          >
                            <div className="gantt-label gantt-label--ghost" aria-hidden />
                            <div className="gantt-track gantt-track--lane gantt-track--phase-lane">
                              {renderLaneLabel(phase.startDate, phaseTitle, 'phase')}
                              {renderGanttBar({
                                startDate: phase.startDate,
                                endDate: phase.endDate,
                                colors,
                                barClass: 'gantt-bar--phase',
                                showLabels: false,
                              })}
                              {renderPhaseMarkers(project.markers, phase.phaseKey, colors)}
                            </div>
                          </div>
                          {mobileLayout
                            ? renderMobilePhaseTasks(project, phase, colors, { isComplete, isAwaitingStart })
                            : renderDesktopPhaseTasks(project, phase, {
                              colors,
                              isComplete,
                              isAwaitingStart,
                            })}
                        </div>
                        );
                      })}
                    </div>
                  ) : null}
                  </>
                  )}
                </div>
              );
            })}
              </Fragment>
            ))}
          </div>
          </div>
        </div>
      </div>
      </div>
    </div>
    {showOverview && timelineFocusProject ? (
      <ClientOverviewModal
        project={normalizeProjectMilestones(timelineFocusProject)}
        onClose={() => setShowOverview(false)}
      />
    ) : null}
    </>
  );
}

const STUDIO_ACCESS_STORAGE = 'ew_studio_access';
const STUDIO_ACCESS_CODE = '3131';

function normalizeRemoteProject(p) {
  return normalizeProjectMilestones(
    normalizeProjectDesignersOnProject({
      ...p,
      status: normalizeProjectStatus(p.status),
      priority: normalizeProjectCategory(p.priority),
    }),
  );
}

function normalizeRemoteWorkspace({ designers, projects }) {
  return {
    designers: designers.map(designerWithNormalizedColor),
    projects: projects.map(normalizeRemoteProject),
  };
}

function parseUpdatedAt(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function isRemoteNewer(remoteAt, knownAt) {
  if (!remoteAt) return false;
  if (!knownAt) return true;
  return parseUpdatedAt(remoteAt) > parseUpdatedAt(knownAt);
}

function AccessScreen({ onUnlock }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    if (value === STUDIO_ACCESS_CODE) {
      try {
        localStorage.setItem(STUDIO_ACCESS_STORAGE, '1');
      } catch {
        /* ignore */
      }
      setError(false);
      onUnlock();
    } else {
      setError(true);
    }
  };

  return (
    <div className="access-gate">
      <form className="access-gate-form" onSubmit={submit}>
        <p className="access-gate-brand">Extended Whānau</p>
        <input
          className="access-gate-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="••••"
          aria-label="Access code"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
        />
        {error && <p className="access-gate-error">Code not recognised.</p>}
        <button type="submit" className="access-gate-continue" disabled={!value.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [accessUnlocked, setAccessUnlocked] = useState(() => {
    try {
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        if (params.has('lock') || params.get('logout') === '1') {
          localStorage.removeItem(STUDIO_ACCESS_STORAGE);
          window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
          return false;
        }
      }
      return localStorage.getItem(STUDIO_ACCESS_STORAGE) === '1';
    } catch {
      return false;
    }
  });

  const [view, setView] = useState('projects');
  const [designers, setDesigners] = useState(loadDesignersFromStorage);
  const [projects, setProjects] = useState(() => {
    let raw;
    try {
      raw = JSON.parse(localStorage.getItem('studio_projects'));
    } catch {
      raw = null;
    }
    const list = Array.isArray(raw) && raw.length > 0 ? raw : buildSampleProjects();
    return list.map((p) =>
      normalizeProjectMilestones(
        normalizeProjectDesignersOnProject({
          ...p,
          status: normalizeProjectStatus(p.status),
          priority: normalizeProjectCategory(p.priority),
        }),
      ),
    );
  });
  const [editingProject, setEditingProject] = useState(null);
  const [editingProjectTab, setEditingProjectTab] = useState('details');
  const openProjectEdit = useCallback((project, tab = 'details') => {
    setEditingProjectTab(tab);
    setEditingProject(project);
  }, []);
  const [showNewProject, setShowNewProject] = useState(false);
  const [designerModalOpen, setDesignerModalOpen] = useState(false);
  const [designerBeingEdited, setDesignerBeingEdited] = useState(null);
  const [filterDesigner, setFilterDesigner] = useState('all');
  const [teamOpen, setTeamOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [ganttFocusProjectId, setGanttFocusProjectId] = useState(null);
  const [ganttFocusMeta, setGanttFocusMeta] = useState(null);
  const [overviewPreviewProject, setOverviewPreviewProject] = useState(() => (
    shouldShowDevOverviewPreview() ? getDevOverviewPreviewProject() : null
  ));
  /** After first Supabase pull (or immediately if Supabase off), cloud saves are allowed. */
  const [cloudReady, setCloudReady] = useState(() => !isSupabaseConfigured());

  const designersRef = useRef(designers);
  const projectsRef = useRef(projects);
  designersRef.current = designers;
  projectsRef.current = projects;
  const remoteUpdatedAtRef = useRef(null);
  const pendingRemoteUpdatedAtRef = useRef(null);
  const remotePullInFlightRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const applyRemoteRef = useRef(async () => {});

  const applyRemoteFromServer = useCallback(async (updatedAtHint) => {
    if (!cloudReady) return;

    if (updatedAtHint && !isRemoteNewer(updatedAtHint, remoteUpdatedAtRef.current)) return;

    if (remotePullInFlightRef.current) {
      if (updatedAtHint && isRemoteNewer(updatedAtHint, pendingRemoteUpdatedAtRef.current)) {
        pendingRemoteUpdatedAtRef.current = updatedAtHint;
      }
      return;
    }

    remotePullInFlightRef.current = true;
    try {
      const remote = await loadWorkspacePayload();
      if (!remote?.updatedAt) return;
      if (!isRemoteNewer(remote.updatedAt, remoteUpdatedAtRef.current)) return;

      if (editingProject || showNewProject || designerModalOpen) {
        pendingRemoteUpdatedAtRef.current = remote.updatedAt;
        return;
      }

      if (remote.designers.length > 0 || remote.projects.length > 0) {
        applyingRemoteRef.current = true;
        const normalized = normalizeRemoteWorkspace(remote);
        setDesigners(normalized.designers);
        setProjects(normalized.projects);
      }
      remoteUpdatedAtRef.current = remote.updatedAt;
      pendingRemoteUpdatedAtRef.current = null;
    } finally {
      remotePullInFlightRef.current = false;
      const pending = pendingRemoteUpdatedAtRef.current;
      if (pending && isRemoteNewer(pending, remoteUpdatedAtRef.current)) {
        if (!editingProject && !showNewProject && !designerModalOpen) {
          pendingRemoteUpdatedAtRef.current = null;
          applyRemoteRef.current(pending);
        }
      }
    }
  }, [cloudReady, editingProject, showNewProject, designerModalOpen]);

  applyRemoteRef.current = applyRemoteFromServer;

  const ganttNavRef = useRef({
    scrollBy: () => {},
    scrollToToday: () => {},
  });
  const registerGanttNav = useCallback((api) => {
    if (api) {
      ganttNavRef.current = api;
    } else {
      ganttNavRef.current = {
        scrollBy: () => {},
        scrollToToday: () => {},
      };
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured()) return undefined;
    let cancelled = false;
    (async () => {
      const remote = await loadWorkspacePayload();
      if (cancelled) return;
      if (remote === null) {
        setCloudReady(true);
        return;
      }
      if (remote.designers.length > 0 || remote.projects.length > 0) {
        const normalized = normalizeRemoteWorkspace(remote);
        setDesigners(normalized.designers);
        setProjects(normalized.projects);
        if (remote.updatedAt) {
          remoteUpdatedAtRef.current = remote.updatedAt;
        }
      } else {
        const result = await saveWorkspacePayload({
          designers: designersRef.current,
          projects: projectsRef.current,
        });
        if (result.ok && result.updatedAt) {
          remoteUpdatedAtRef.current = result.updatedAt;
        } else if (remote.updatedAt) {
          remoteUpdatedAtRef.current = remote.updatedAt;
        }
      }
      setCloudReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('studio_designers', JSON.stringify(designers));
    } catch {
      /* ignore */
    }
    try {
      localStorage.setItem('studio_projects', JSON.stringify(projects));
    } catch {
      /* ignore */
    }

    if (!isSupabaseConfigured() || !cloudReady) return undefined;

    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false;
      return undefined;
    }

    const t = window.setTimeout(() => {
      saveWorkspacePayload({ designers, projects }).then((result) => {
        if (result.ok && result.updatedAt) {
          remoteUpdatedAtRef.current = result.updatedAt;
          if (pendingRemoteUpdatedAtRef.current
            && !isRemoteNewer(pendingRemoteUpdatedAtRef.current, result.updatedAt)) {
            pendingRemoteUpdatedAtRef.current = null;
          }
        }
      });
    }, 550);
    return () => window.clearTimeout(t);
  }, [designers, projects, cloudReady]);

  useEffect(() => {
    if (!isSupabaseConfigured() || !cloudReady) return undefined;
    return subscribeWorkspaceChanges((updatedAt) => {
      applyRemoteRef.current(updatedAt);
    });
  }, [cloudReady]);

  useEffect(() => {
    if (!isSupabaseConfigured() || !cloudReady) return undefined;
    const onVisible = () => {
      if (document.hidden) return;
      fetchWorkspaceUpdatedAt().then((updatedAt) => {
        if (updatedAt) applyRemoteRef.current(updatedAt);
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [cloudReady]);

  useEffect(() => {
    if (editingProject || showNewProject || designerModalOpen) return undefined;
    const pending = pendingRemoteUpdatedAtRef.current;
    if (!pending) return undefined;
    const t = window.setTimeout(() => {
      const stillPending = pendingRemoteUpdatedAtRef.current;
      if (!stillPending) return;
      if (!isRemoteNewer(stillPending, remoteUpdatedAtRef.current)) {
        pendingRemoteUpdatedAtRef.current = null;
        return;
      }
      pendingRemoteUpdatedAtRef.current = null;
      applyRemoteRef.current(stillPending);
    }, 650);
    return () => window.clearTimeout(t);
  }, [editingProject, showNewProject, designerModalOpen]);

  useEffect(() => {
    const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
    const syncScrollLock = () => {
      document.documentElement.classList.toggle('app-nav-open', sidebarOpen && isMobile());
    };
    syncScrollLock();
    const onResize = () => syncScrollLock();
    window.addEventListener('resize', onResize);
    const onKey = (e) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    if (sidebarOpen) window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('app-nav-open');
    };
  }, [sidebarOpen]);

  const closeSidebar = () => setSidebarOpen(false);

  const clearGanttFocusProject = useCallback(() => {
    setGanttFocusProjectId(null);
  }, []);

  const handleGanttFocusMetaChange = useCallback((meta) => {
    setGanttFocusMeta(meta);
  }, []);

  useEffect(() => {
    if (view !== 'gantt') setGanttFocusMeta(null);
  }, [view]);

  const saveProject = (p) => {
    const withDesigners = normalizeProjectDesignersOnProject(p);
    const withMilestones = normalizeProjectMilestones(withDesigners);
    const base = {
      ...withMilestones,
      status: normalizeProjectStatus(withMilestones.status),
      priority: normalizeProjectCategory(withMilestones.priority),
    };
    const normalized = base.status === 'Complete'
      ? { ...base, completedAt: base.completedAt || today() }
      : (() => {
          const { completedAt, ...rest } = base;
          return rest;
        })();
    setProjects(prev => {
      const exists = prev.find(x => x.id === normalized.id);
      return exists ? prev.map(x => x.id === normalized.id ? normalized : x) : [...prev, normalized];
    });
  };
  const deleteProject = (id) => setProjects(prev => prev.filter(p => p.id !== id));

  const openProjectTimeline = useCallback((project) => {
    if (!project?.id || !projectHasMilestones(project) || !project.startDate || !project.endDate) {
      return;
    }
    saveProject(project);
    setGanttFocusProjectId(project.id);
    setView('gantt');
    setSidebarOpen(false);
    setEditingProject(null);
    setEditingProjectTab('details');
    setShowNewProject(false);
  }, []);

  const saveDesigner = (d) => {
    setDesigners((prev) => {
      const exists = prev.find((x) => x.id === d.id);
      return exists ? prev.map((x) => (x.id === d.id ? d : x)) : [...prev, d];
    });
  };

  const deleteDesigner = (id) => {
    setDesigners((prev) => prev.filter((x) => x.id !== id));
    setProjects((prev) => prev.map((p) => {
      if (!getProjectDesignerIds(p).includes(id)) return p;
      const nextIds = getProjectDesignerIds(p).filter((x) => x !== id);
      return normalizeProjectDesignersOnProject({ ...p, designerIds: nextIds });
    }));
    setFilterDesigner((fd) => (fd === id ? 'all' : fd));
  };

  const updateProjectStatus = (id, status) => {
    setProjects(prev => prev.map((p) => {
      if (p.id !== id) return p;
      if (status === 'Complete' && p.status !== 'Complete') {
        return { ...p, status, completedAt: today() };
      }
      if (status !== 'Complete' && p.status === 'Complete') {
        const { completedAt, ...rest } = p;
        return { ...rest, status };
      }
      return { ...p, status };
    }));
  };

  const designerFiltered = filterDesigner === 'all'
    ? projects
    : projects.filter((p) => getProjectDesignerIds(p).includes(filterDesigner));

  const activeProjects = designerFiltered.filter(p => p.status !== 'Complete');
  const devTimelinePreview = shouldUseDevTimelinePreview(activeProjects);
  const ganttProjects = devTimelinePreview
    ? getDevTimelinePreviewProjects(designers)
    : activeProjects;
  const mainProjects = activeProjects.filter(p => !isPipelineStatus(p.status));
  const pipelineProjects = activeProjects.filter(p => isPipelineStatus(p.status));
  const archivedProjects = designerFiltered
    .filter(p => p.status === 'Complete')
    .slice()
    .sort((a, b) =>
      (b.completedAt || b.endDate || '').localeCompare(a.completedAt || a.endDate || ''));

  const sortFeed = (list) =>
    list.slice().sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''));

  /** Secondary list: In progress first, then in review; within each group by due date. */
  const SECONDARY_STATUS_ORDER = { 'In Progress': 0, 'In Review': 1 };
  const sortSecondaryFeed = (list) =>
    list.slice().sort((a, b) => {
      const sa = normalizeProjectStatus(a.status);
      const sb = normalizeProjectStatus(b.status);
      const ra = SECONDARY_STATUS_ORDER[sa] ?? 99;
      const rb = SECONDARY_STATUS_ORDER[sb] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.endDate || '').localeCompare(b.endDate || '');
    });

  const priorityFeed = sortFeed(mainProjects.filter((p) => getProjectCategory(p) === 'priority'));
  const secondaryFeed = sortSecondaryFeed(mainProjects.filter((p) => getProjectCategory(p) === 'secondary'));
  const pipelinePriorityFeed = sortFeed(pipelineProjects.filter((p) => getProjectCategory(p) === 'priority'));
  const pipelineSecondaryFeed = sortFeed(pipelineProjects.filter((p) => getProjectCategory(p) === 'secondary'));

  const mainProjectCount = projects.filter(
    p => p.status !== 'Complete' && !isPipelineStatus(p.status),
  ).length;
  const scheduledCount = projects.filter(p => isPipelineStatus(p.status)).length;
  const archivedCount = projects.filter(p => p.status === 'Complete').length;

  const existingClientNames = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const p of projects) {
      const raw = p?.client != null ? String(p.client).trim() : '';
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    }
    out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return out;
  }, [projects]);

  if (!accessUnlocked) {
    return <AccessScreen onUnlock={() => setAccessUnlocked(true)} />;
  }

  return (
    <div className="app">
      <button
        type="button"
        className={`sidebar-backdrop ${sidebarOpen ? 'is-visible' : ''}`}
        aria-label="Close menu"
        onClick={closeSidebar}
      />

      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar-top">
          <div className="logo">
            <span className="logo-text">Extended Whānau</span>
          </div>
          <button type="button" className="sidebar-close-btn" onClick={closeSidebar} aria-label="Close menu">
            ✕
          </button>
        </div>

        <nav className="sidebar-nav">
          <button
            type="button"
            className={`nav-item ${view === 'projects' ? 'active' : ''}`}
            onClick={() => { setView('projects'); closeSidebar(); }}
          >
            Projects
          </button>
          <button
            type="button"
            className={`nav-item ${view === 'gantt' ? 'active' : ''}`}
            onClick={() => { setView('gantt'); closeSidebar(); }}
          >
            Timeline
          </button>
          <button
            type="button"
            className={`nav-item ${view === 'scheduled' ? 'active' : ''}`}
            onClick={() => { setView('scheduled'); closeSidebar(); }}
          >
            Schedule
          </button>
          <button
            type="button"
            className={`nav-item ${view === 'archive' ? 'active' : ''}`}
            onClick={() => { setView('archive'); closeSidebar(); }}
          >
            Archive
          </button>
        </nav>

        <div className={`sidebar-section${teamOpen ? ' sidebar-section--open' : ''}`}>
          <div className="sidebar-section-header">
            <button
              type="button"
              className="sidebar-section-toggle"
              onClick={() => setTeamOpen((open) => !open)}
              aria-expanded={teamOpen}
              aria-controls="sidebar-team-list"
            >
              <span>Team</span>
              <span className={`sidebar-section-chevron${teamOpen ? ' sidebar-section-chevron--open' : ''}`} aria-hidden>
                ›
              </span>
            </button>
            <button
              type="button"
              className="sidebar-add-btn"
              onClick={() => {
                setDesignerBeingEdited(null);
                setDesignerModalOpen(true);
                closeSidebar();
              }}
              aria-label="Add team member"
            >
              +
            </button>
          </div>
          {teamOpen ? (
          <div id="sidebar-team-list" className="designer-list">
            <button
              type="button"
              className={`designer-chip ${filterDesigner === 'all' ? 'selected' : ''}`}
              onClick={() => { setFilterDesigner('all'); closeSidebar(); }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#CCC' }} />
              All
            </button>
            {designers.map((d) => {
              const c = getDesignerPalette(d);
              return (
                <div key={d.id} className="designer-row">
                  <button
                    type="button"
                    className={`designer-chip ${filterDesigner === d.id ? 'selected' : ''}`}
                    onClick={() => {
                      setFilterDesigner(filterDesigner === d.id ? 'all' : d.id);
                      closeSidebar();
                    }}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.bar }} />
                    <span className="designer-chip-name">{d.name}</span>
                  </button>
                  <button
                    type="button"
                    className="designer-edit-btn"
                    title="Edit or remove"
                    aria-label={`Edit ${d.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDesignerBeingEdited(d);
                      setDesignerModalOpen(true);
                      closeSidebar();
                    }}
                  >
                    ···
                  </button>
                </div>
              );
            })}
          </div>
          ) : null}
        </div>

        <div className="sidebar-bottom">
          <div className="sidebar-date">
            {new Date().toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'long' })}
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="main">
        <header className="main-header">
          <div className="main-header-title-row">
            <button
              type="button"
              className="mobile-nav-toggle"
              aria-label="Open menu"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <span className="mobile-nav-bars" aria-hidden />
            </button>
            <div className="page-title-cluster">
              <h1 className="page-title">
                {view === 'projects'
                  ? 'Projects'
                  : view === 'scheduled'
                    ? 'Schedule'
                    : view === 'archive'
                      ? 'Archive'
                      : 'Timeline'}
              </h1>
              {view === 'gantt' && ganttFocusMeta ? (
                <button
                  type="button"
                  className="page-title-focus-meta"
                  onClick={() => {
                    const project = projects.find((p) => p.id === ganttFocusMeta.id);
                    if (project) openProjectEdit(project, 'phases');
                  }}
                  aria-label={`Open project details for ${ganttFocusMeta.name}`}
                >
                  <span className="page-title-focus-name">{ganttFocusMeta.name}</span>
                  <span className="page-title-focus-dates">
                    {formatMilestoneDateShort(ganttFocusMeta.startDate)}
                    {' — '}
                    {formatMilestoneDateShort(ganttFocusMeta.endDate)}
                  </span>
                </button>
              ) : null}
            </div>
          </div>
          <div className="main-header-actions">
            {((view === 'projects' && mainProjectCount > 0)
              || (view === 'scheduled' && scheduledCount > 0)
              || (view === 'archive' && archivedCount > 0)
              || view !== 'archive') && (
              <div className="main-header-trailing">
                {view === 'projects' && mainProjectCount > 0 && (
                  <span className="page-title-badge" aria-label={`${mainProjectCount} active projects`}>
                    {mainProjectCount}
                  </span>
                )}
                {view === 'scheduled' && scheduledCount > 0 && (
                  <span
                    className="page-title-badge page-title-badge--muted"
                    aria-label={`${scheduledCount} jobs on Schedule`}
                  >
                    {scheduledCount}
                  </span>
                )}
                {view === 'archive' && archivedCount > 0 && (
                  <span
                    className="page-title-badge page-title-badge--muted"
                    aria-label={`${archivedCount} archived projects`}
                  >
                    {archivedCount}
                  </span>
                )}
                {view !== 'archive' && (
                  <button
                    type="button"
                    className="sidebar-add-btn header-new-project"
                    onClick={() => setShowNewProject(true)}
                    aria-label="New Project"
                  >
                    +
                  </button>
                )}
              </div>
            )}
          </div>
        </header>

        <div className="main-content">
          {view === 'projects' && (
            <div className="project-list">
              {mainProjects.length === 0 ? (
                <div className="empty-state">
                  {pipelineProjects.length > 0
                    ? 'Nothing in progress on this list. Open Schedule for jobs that have not started yet.'
                    : 'No active projects. Add one to get started—it appears on Schedule until you move it forward—or check Archive for completed work.'}
                </div>
              ) : (
                <>
                  {priorityFeed.length > 0 && (
                    <div className="project-section">
                      <h2 className="project-feed-heading">Priority</h2>
                      {priorityFeed.map(p => (
                        <ProjectRow
                          key={p.id}
                          project={p}
                          designers={designers}
                          variant="projects"
                          onClick={() => openProjectEdit(p)}
                          onStatusChange={updateProjectStatus}
                        />
                      ))}
                    </div>
                  )}
                  {secondaryFeed.length > 0 && (
                    <div className="project-section">
                      <h2 className="project-feed-heading">Secondary</h2>
                      {secondaryFeed.map(p => (
                        <ProjectRow
                          key={p.id}
                          project={p}
                          designers={designers}
                          variant="projects"
                          onClick={() => openProjectEdit(p)}
                          onStatusChange={updateProjectStatus}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {view === 'scheduled' && (
            <div className="project-list">
              {pipelineProjects.length === 0 ? (
                <div className="empty-state">
                  Nothing on Schedule yet. New projects start with status Scheduled; move them to Ready to Start or In progress when work begins.
                </div>
              ) : (
                <>
                  {pipelinePriorityFeed.length > 0 && (
                    <div className="project-section">
                      <h2 className="project-feed-heading">Priority</h2>
                      {pipelinePriorityFeed.map(p => (
                        <ProjectRow
                          key={p.id}
                          project={p}
                          designers={designers}
                          variant="schedule"
                          onClick={() => openProjectEdit(p)}
                          onStatusChange={updateProjectStatus}
                        />
                      ))}
                    </div>
                  )}
                  {pipelineSecondaryFeed.length > 0 && (
                    <div className="project-section">
                      <h2 className="project-feed-heading">Secondary</h2>
                      {pipelineSecondaryFeed.map(p => (
                        <ProjectRow
                          key={p.id}
                          project={p}
                          designers={designers}
                          variant="schedule"
                          onClick={() => openProjectEdit(p)}
                          onStatusChange={updateProjectStatus}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {view === 'archive' && (
            <div className="project-list">
              {archivedProjects.length === 0 ? (
                <div className="empty-state">
                  Nothing archived yet.
                </div>
              ) : (
                <div className="project-section">
                  {archivedProjects.map(p => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      designers={designers}
                      onClick={() => openProjectEdit(p)}
                      onStatusChange={updateProjectStatus}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {view === 'gantt' && (
            <GanttChart
              projects={ganttProjects}
              designers={designers}
              onSelectProject={(p) => openProjectEdit(p, 'phases')}
              onUpdateProject={saveProject}
              onRegisterNav={registerGanttNav}
              onFocusMetaChange={handleGanttFocusMetaChange}
              previewMode={devTimelinePreview}
              focusProjectId={ganttFocusProjectId}
              onFocusProjectHandled={clearGanttFocusProject}
            />
          )}
        </div>
      </main>

      {/* Modals */}
      {showNewProject && (
        <ProjectModal
          project={null}
          designers={designers}
          existingClients={existingClientNames}
          onClose={() => setShowNewProject(false)}
          onSave={saveProject}
          onDelete={deleteProject}
          onOpenTimeline={openProjectTimeline}
        />
      )}
      {editingProject && (
        <ProjectModal
          project={editingProject}
          designers={designers}
          existingClients={existingClientNames}
          initialTab={editingProjectTab}
          onClose={() => {
            setEditingProject(null);
            setEditingProjectTab('details');
          }}
          onSave={saveProject}
          onDelete={deleteProject}
          onOpenTimeline={openProjectTimeline}
        />
      )}
      {designerModalOpen && (
        <DesignerModal
          key={designerBeingEdited?.id ?? 'new'}
          initialDesigner={designerBeingEdited}
          onClose={() => {
            setDesignerModalOpen(false);
            setDesignerBeingEdited(null);
          }}
          onSave={saveDesigner}
          onDelete={deleteDesigner}
        />
      )}
      {overviewPreviewProject && (
        <ClientOverviewModal
          project={overviewPreviewProject}
          onClose={() => setOverviewPreviewProject(null)}
        />
      )}
    </div>
  );
}
