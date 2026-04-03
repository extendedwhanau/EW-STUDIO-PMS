import React, {
  useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback,
} from 'react';
import { v4 as uuidv4 } from 'uuid';
import './App.css';
import './gantt-timeline.css';

// ── Designer palette ──────────────────────────────────────────────────────────
const DESIGNER_COLORS = [
  { bg: '#E8D5C4', bar: '#C4956A', text: '#7A5230' },
  { bg: '#C8D8C8', bar: '#6A9E6A', text: '#2D5A2D' },
  { bg: '#C4CDD8', bar: '#6A85A8', text: '#1F3A5F' },
  { bg: '#D8C8D8', bar: '#9E6AA8', text: '#4A1F5A' },
  { bg: '#D8D4C4', bar: '#A89E6A', text: '#5A4E1F' },
];

const STATUS_OPTIONS = ['In Progress', 'In Review', 'Complete'];

/** Row dot colours — green / amber / grey. */
const STATUS_ACCENT = {
  'In Progress': '#22A45A',
  'In Review': '#E5A50A',
  Complete: '#9CA3AF',
};

const LEGACY_STATUS_MAP = {
  'Waiting on Client': 'In Review',
  'Ready to Print': 'In Progress',
};

function normalizeProjectStatus(status) {
  if (STATUS_OPTIONS.includes(status)) return status;
  if (LEGACY_STATUS_MAP[status]) return LEGACY_STATUS_MAP[status];
  return 'In Progress';
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

// ── Sample data ───────────────────────────────────────────────────────────────
const SAMPLE_DESIGNERS = [
  { id: 'd1', name: 'Tyrone', colorIdx: 0 },
  { id: 'd2', name: 'Max', colorIdx: 1 },
  { id: 'd3', name: 'Eva', colorIdx: 2 },
  { id: 'd4', name: 'Shaun', colorIdx: 3 },
  { id: 'd5', name: 'Poi', colorIdx: 4 },
];

const SAMPLE_PROJECTS = [
  {
    id: 'p1', name: 'Annual Report', client: 'Meridian Co.',
    designerId: 'd1', status: 'In Progress', priority: 'priority',
    startDate: '2025-04-01', endDate: '2025-04-28',
    notes: 'Cover options due first.',
  },
  {
    id: 'p2', name: 'Brand Identity', client: 'Volta Studio',
    designerId: 'd2', status: 'In Review', priority: 'priority',
    startDate: '2025-04-05', endDate: '2025-05-10',
    notes: 'Awaiting logo feedback.',
  },
  {
    id: 'p3', name: 'Packaging Suite', client: 'Bloom Foods',
    designerId: 'd3', status: 'In Review', priority: 'background',
    startDate: '2025-04-10', endDate: '2025-04-24',
    notes: '',
  },
  {
    id: 'p4', name: 'Campaign Collateral', client: 'Meridian Co.',
    designerId: 'd5', status: 'In Progress', priority: 'background',
    startDate: '2025-04-15', endDate: '2025-05-05',
    notes: 'Three formats needed.',
  },
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
      return canon ? { ...d, name: canon.name, colorIdx: canon.colorIdx } : d;
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
    return applyTeamSchemaVersion(list);
  } catch {
    return [...SAMPLE_DESIGNERS];
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
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'long' });
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

function daysFromEpoch(str) {
  return Math.floor(new Date(str + 'T00:00:00').getTime() / 86400000);
}
function addDays(str, n) {
  const d = new Date(str + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Components ────────────────────────────────────────────────────────────────

function Avatar({ designer, size = 32 }) {
  if (!designer) return null;
  const c = DESIGNER_COLORS[designer.colorIdx % DESIGNER_COLORS.length];
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
function ProjectModal({ project, designers, onClose, onSave, onDelete }) {
  const [form, setForm] = useState(() => {
    if (project) {
      return {
        ...project,
        status: normalizeProjectStatus(project.status),
        priority: project.priority || 'priority',
      };
    }
    return {
      id: uuidv4(), name: '', client: '', designerId: designers[0]?.id || '',
      status: 'In Progress', startDate: today(), endDate: addDays(today(), 14),
      notes: '', priority: 'priority',
    };
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const designer = designers.find(d => d.id === form.designerId);

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--project">
        <div className="modal-header modal-header--project">
          <h2 className="modal-project-sheet-heading">
            {project ? 'Edit' : 'Create Project'}
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body modal-body--project">
          <div className="sheet-grid-row sheet-grid-row--bare-fields">
            <input
              id="project-modal-client"
              className="sheet-text-input sheet-text-input--left"
              type="text"
              placeholder="Client"
              aria-label="Client"
              value={form.client}
              onChange={e => set('client', e.target.value)}
              autoFocus
            />
            <input
              id="project-modal-name"
              className="sheet-text-input sheet-text-input--left"
              type="text"
              placeholder="Project"
              aria-label="Project"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
          </div>

          <div className="sheet-grid-row">
            <div className="sheet-pair">
              <label htmlFor="project-modal-designer" className="sheet-field-label">
                Designer
              </label>
              <div className="sheet-field-value">
                <div className="sheet-select-hit sheet-select-hit--designer">
                  <span className="sheet-select-visual" aria-hidden>
                    <span className="sheet-value">{designer?.name || 'Unassigned'}</span>
                  </span>
                  <select
                    id="project-modal-designer"
                    className="sheet-select-native"
                    value={form.designerId}
                    onChange={e => set('designerId', e.target.value)}
                  >
                    {designers.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                    <option value="">Unassigned</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="sheet-pair">
              <label htmlFor="project-priority-yesno" className="sheet-field-label">
                Priority
              </label>
              <div className="sheet-field-value">
                <button
                  id="project-priority-yesno"
                  type="button"
                  className="priority-yesno"
                  onClick={() => set('priority', form.priority === 'priority' ? 'background' : 'priority')}
                  aria-pressed={form.priority === 'priority'}
                  title={form.priority === 'priority' ? 'Priority list — click for Secondary' : 'Secondary list — click for Priority'}
                >
                  {form.priority === 'priority' ? 'Yes' : 'No'}
                </button>
              </div>
            </div>
          </div>

          <div className="sheet-grid-row">
            <div className="sheet-pair">
              <label htmlFor="project-modal-start" className="sheet-field-label">
                Start
              </label>
              <div className="sheet-field-value sheet-field-value--date">
                <input
                  id="project-modal-start"
                  type="date"
                  className="sheet-date"
                  value={form.startDate}
                  onChange={e => set('startDate', e.target.value)}
                />
              </div>
            </div>
            <div className="sheet-pair">
              <label htmlFor="project-modal-end" className="sheet-field-label">
                End
              </label>
              <div className="sheet-field-value sheet-field-value--date">
                <input
                  id="project-modal-end"
                  type="date"
                  className="sheet-date"
                  value={form.endDate}
                  onChange={e => set('endDate', e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="sheet-grid-row">
            <div className="sheet-pair sheet-pair--blank" aria-hidden="true" />
            <div className="sheet-pair">
              <label htmlFor="project-modal-status" className="sheet-field-label">
                Status
              </label>
              <div className="sheet-field-value">
                <div className="sheet-select-hit">
                  <span className="sheet-select-visual" aria-hidden>
                    <span className="sheet-value sheet-value--nowrap">
                      {formatStatusForDisplay(form.status)}
                    </span>
                  </span>
                  <select
                    id="project-modal-status"
                    className="sheet-select-native"
                    value={form.status}
                    onChange={e => set('status', e.target.value)}
                  >
                    {STATUS_OPTIONS.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div className="sheet-notes-block">
            <label htmlFor="project-modal-notes" className="sheet-field-label">
              Notes
            </label>
            <textarea
              id="project-modal-notes"
              className="sheet-notes"
              placeholder="Any notes for this project…"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <div className="modal-footer modal-footer--project">
          {project && (
            <button type="button" className="btn-delete" onClick={() => { onDelete(project.id); onClose(); }}>
              Delete
            </button>
          )}
          <div className="modal-footer-actions">
            <button type="button" className="modal-btn-close" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="modal-btn-submit"
              onClick={() => { onSave(form); onClose(); }}
              disabled={!form.name.trim()}
            >
              {project ? 'Save changes' : 'Add project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Designer Modal (add or edit profile) ─────────────────────────────────────
function DesignerModal({ initialDesigner, onClose, onSave, onDelete }) {
  const isEdit = initialDesigner != null;
  const [name, setName] = useState(initialDesigner?.name ?? '');
  const [colorIdx, setColorIdx] = useState(initialDesigner?.colorIdx ?? 0);

  const handleSave = () => {
    if (!name.trim()) return;
    if (isEdit) {
      onSave({ ...initialDesigner, name: name.trim(), colorIdx });
    } else {
      onSave({ id: uuidv4(), name: name.trim(), colorIdx });
    }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-narrow">
        <div className="modal-header">
          <span className="modal-sheet-title">{isEdit ? 'Edit profile' : 'Add team member'}</span>
          <button type="button" className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Name</label>
            <input
              placeholder="Name"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label>Colour</label>
            <div className="designer-color-picks">
              {DESIGNER_COLORS.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  className={`designer-color-pick ${colorIdx === i ? 'selected' : ''}`}
                  style={{ background: c.bar }}
                  onClick={() => setColorIdx(i)}
                  aria-label={`Colour ${i + 1}`}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          {isEdit && (
            <button
              type="button"
              className="btn-delete"
              onClick={() => {
                onDelete(initialDesigner.id);
                onClose();
              }}
            >
              Remove from team
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={!name.trim()}>
              {isEdit ? 'Save' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Project Row ───────────────────────────────────────────────────────────────
function ProjectRow({ project, designers, onClick, onStatusChange }) {
  const designer = designers.find(d => d.id === project.designerId);
  const accent = statusAccent(project.status);
  const dueSeg = project.endDate ? formatDueDaysSegment(project.endDate) : '';
  return (
    <div className="project-row" onClick={() => onClick(project)}>
      <div className="project-row-inner">
        <div className="project-row-client-span">
          <span className="project-client">{project.client}</span>
        </div>
        <div className="project-row-col project-row-col--lead">
          <span className="project-name">{project.name}</span>
        </div>
        <div className="project-row-col project-row-col--due">
          {project.endDate ? (
            <div
              className="project-row-due-pair"
              title="Day count is working days (Mon–Fri)"
              aria-label={`${dueSeg}, ${formatDueDateLong(project.endDate)}. Working weekdays.`}
            >
              <span className="project-due-date-main">{formatDueDateLong(project.endDate)}</span>
              <span className="project-due-days">{formatDueDaysDisplay(project.endDate)}</span>
            </div>
          ) : (
            <span className="project-due-date-main project-due-date-main--empty">—</span>
          )}
        </div>
        <div className="project-row-col project-row-col--trail">
          <div
            className="project-status-hit"
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
          {designer ? <Avatar designer={designer} size={28} /> : null}
        </div>
      </div>
    </div>
  );
}

const GANTT_NZ_TZ = 'Pacific/Auckland';

function ganttNzNoonMs(epochDay) {
  return epochDay * 86400000 + 12 * 60 * 60 * 1000;
}

/** Calendar Friday in NZ (avoids DST midnight edge cases). */
function isFridayNZ(epochDay) {
  const wk = new Intl.DateTimeFormat('en-NZ', {
    timeZone: GANTT_NZ_TZ,
    weekday: 'short',
  }).format(new Date(ganttNzNoonMs(epochDay)));
  return wk === 'Fri';
}

/** Day of month only (NZ), for Friday ticks. */
function ganttTickDayNumberNZ(epochDay) {
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: GANTT_NZ_TZ,
    day: 'numeric',
  }).format(new Date(ganttNzNoonMs(epochDay)));
}

function nzYearMonthKey(epochDay) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: GANTT_NZ_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(ganttNzNoonMs(epochDay)));
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  return `${y}-${m}`;
}

function isFirstOfMonthNZ(epochDay) {
  const dom = new Intl.DateTimeFormat('en-NZ', {
    timeZone: GANTT_NZ_TZ,
    day: 'numeric',
  }).format(new Date(ganttNzNoonMs(epochDay)));
  return dom === '1';
}

/** ~3 calendar months of days shown across the scroll viewport (desktop). */
const GANTT_DESKTOP_VIEWPORT_DAYS = 92;
const GANTT_MOBILE_BREAKPOINT_PX = 768;

/** Timeline rows: group by designer (sidebar roster order), then due date like project feed. */
function sortTimelineProjectsByDesigner(projects, designers) {
  const rank = Object.fromEntries(designers.map((d, i) => [d.id, i]));
  const tail = designers.length;
  return projects.slice().sort((a, b) => {
    const ra = a.designerId != null && a.designerId !== '' && rank[a.designerId] !== undefined
      ? rank[a.designerId]
      : tail;
    const rb = b.designerId != null && b.designerId !== '' && rank[b.designerId] !== undefined
      ? rank[b.designerId]
      : tail;
    if (ra !== rb) return ra - rb;
    return (a.endDate || '').localeCompare(b.endDate || '');
  });
}

// ── Gantt Chart ───────────────────────────────────────────────────────────────
function GanttChart({ projects, designers, onSelectProject, onRegisterNav }) {
  const validProjects = projects.filter(p => p.startDate && p.endDate);
  if (!validProjects.length) {
    return <div className="empty-state">No projects with timelines yet.</div>;
  }
  return (
    <GanttChartInner
      projects={validProjects}
      designers={designers}
      onSelectProject={onSelectProject}
      onRegisterNav={onRegisterNav}
    />
  );
}

function GanttChartInner({ projects: validProjects, designers, onSelectProject, onRegisterNav }) {
  const scrollRef = useRef(null);
  const mobileTodayScrollDone = useRef(false);
  const [viewportW, setViewportW] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );
  const todayDay = daysFromEpoch(today());

  const orderedProjects = useMemo(
    () => sortTimelineProjectsByDesigner(validProjects, designers),
    [validProjects, designers]
  );

  const allStarts = validProjects.map(p => daysFromEpoch(p.startDate));
  const allEnds = validProjects.map(p => daysFromEpoch(p.endDate));
  const minStart = Math.min(...allStarts);
  const maxEnd = Math.max(...allEnds);
  const ganttLastDay = daysFromEpoch('2026-12-31');
  let minDay = minStart - 14;
  // Room to plan ahead, but timeline never extends past 31 Dec 2026
  let maxDay = Math.min(
    Math.max(maxEnd + 380, todayDay + 460, minStart + 120),
    ganttLastDay
  );
  if (maxDay <= minDay) {
    minDay = maxDay - 365;
  }
  const totalDays = Math.max(7, maxDay - minDay);

  /** Desktop: ~3 months per viewport width; mobile: dense chart + horizontal pan. */
  const chartMinWidthPx = useMemo(() => {
    if (viewportW <= GANTT_MOBILE_BREAKPOINT_PX) {
      return Math.max(1280, Math.ceil(totalDays * 2.65));
    }
    const w = Math.max(480, viewportW);
    const pxPerDay = w / GANTT_DESKTOP_VIEWPORT_DAYS;
    return Math.ceil(totalDays * pxPerDay);
  }, [viewportW, totalDays]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w > 0) setViewportW(w);
    });
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pct = (day) => ((day - minDay) / totalDays) * 100;

  const minYear = new Date(minDay * 86400000).getFullYear();
  const maxYear = new Date(maxDay * 86400000).getFullYear();
  const monthLabelOpts = minYear !== maxYear ? { month: 'short', year: '2-digit' } : { month: 'short' };

  const months = [];
  let cur = new Date(minDay * 86400000);
  cur.setDate(1);
  while (daysFromEpoch(cur.toISOString().slice(0, 10)) <= maxDay) {
    const day = daysFromEpoch(cur.toISOString().slice(0, 10));
    if (day >= minDay && day <= maxDay) {
      months.push({
        label: cur.toLocaleDateString('en-NZ', monthLabelOpts),
        day,
      });
    }
    cur.setMonth(cur.getMonth() + 1);
  }

  const gridLines = [];
  let prevFridayYm = null;
  for (let day = minDay; day <= maxDay; day++) {
    if (!isFridayNZ(day)) continue;
    const ym = nzYearMonthKey(day);
    const firstFridayOfMonth = prevFridayYm === null || ym !== prevFridayYm;
    prevFridayYm = ym;
    gridLines.push({
      day,
      left: pct(day),
      monthStart: isFirstOfMonthNZ(day),
      firstFridayOfMonth,
      showLabel: true,
    });
  }

  const todayPct = pct(todayDay);
  const compactTimeline = viewportW <= GANTT_MOBILE_BREAKPOINT_PX;

  const scrollTimelineBy = useCallback((direction) => {
    const el = scrollRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const step =
      viewportW > GANTT_MOBILE_BREAKPOINT_PX
        ? Math.floor(w * 0.9)
        : Math.max(240, Math.floor(w * 0.72));
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  }, [viewportW]);

  const scrollToToday = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    const x = (todayPct / 100) * el.scrollWidth - el.clientWidth / 2;
    el.scrollTo({ left: Math.max(0, Math.min(maxScroll, x)), behavior: 'smooth' });
  }, [todayPct]);

  useLayoutEffect(() => {
    if (!onRegisterNav) return undefined;
    onRegisterNav({ scrollBy: scrollTimelineBy, scrollToToday });
    return () => onRegisterNav(null);
  }, [onRegisterNav, scrollTimelineBy, scrollToToday]);

  useLayoutEffect(() => {
    if (mobileTodayScrollDone.current) return;
    const el = scrollRef.current;
    if (!el || typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 768px)').matches) return;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScroll <= 0) return;
    const x = (todayPct / 100) * el.scrollWidth - el.clientWidth / 2;
    el.scrollLeft = Math.max(0, Math.min(maxScroll, x));
    mobileTodayScrollDone.current = true;
  }, [todayPct, chartMinWidthPx]);

  return (
    <div className="gantt-frame">
      <div className="gantt-wrapper" ref={scrollRef}>
        <div
          className={`gantt-chart${compactTimeline ? ' gantt-chart--compact' : ''}`}
          style={{ minWidth: chartMinWidthPx }}
        >
          <div className="gantt-chart-lines" aria-hidden>
            <div className="gantt-lines-spacer" />
            <div className="gantt-vgrid">
              {gridLines.map((line) => (
                <div
                  key={`v-full-${line.day}`}
                  className={`gantt-vline ${line.monthStart ? 'gantt-vline-month' : ''}`}
                  style={{ left: `${line.left}%` }}
                />
              ))}
              {todayPct >= 0 && todayPct <= 100 && (
                <div
                  className="gantt-today-line"
                  style={{ left: `${todayPct}%` }}
                />
              )}
            </div>
          </div>
          <div className="gantt-chart-header">
          <div className="gantt-header-lead" />
          <div className="gantt-ruler">
            <div className="gantt-ruler-months">
              {months.map((m, i) => (
                <span
                  key={i}
                  className="gantt-ruler-month"
                  style={{ left: `${pct(m.day)}%` }}
                >
                  {m.label}
                </span>
              ))}
            </div>
            <div className="gantt-ruler-ticks">
              {todayPct >= 0 && todayPct <= 100 && (
                <div
                  className="gantt-today-marker"
                  style={{ left: `${todayPct}%` }}
                  aria-hidden
                />
              )}
              {gridLines.map((line) => (
                <div
                  key={line.day}
                  className="gantt-tick"
                  style={{ left: `${line.left}%` }}
                >
                  {line.showLabel && (
                    <span
                      className={`gantt-tick-label${line.firstFridayOfMonth ? ' gantt-tick-label--month' : ''}`}
                    >
                      {ganttTickDayNumberNZ(line.day)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          </div>

          <div className="gantt-chart-body">
          <div className="gantt-rows">
            {orderedProjects.map((project) => {
              const designer = designers.find(d => d.id === project.designerId);
              const colors = designer ? DESIGNER_COLORS[designer.colorIdx % DESIGNER_COLORS.length] : { bg: '#EEE', bar: '#CCC', text: '#888' };
              const startPct = pct(daysFromEpoch(project.startDate));
              const endPct = pct(daysFromEpoch(project.endDate));
              const widthPct = endPct - startPct;
              const isWaiting = project.status === 'In Review';
              const isComplete = project.status === 'Complete';

              return (
                <div
                  key={project.id}
                  className="gantt-row"
                  role={onSelectProject ? 'button' : undefined}
                  tabIndex={onSelectProject ? 0 : undefined}
                  aria-label={onSelectProject ? `Edit ${project.name}` : undefined}
                  onClick={() => onSelectProject?.(project)}
                  onKeyDown={(e) => {
                    if (!onSelectProject) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectProject(project);
                    }
                  }}
                >
                  <div className="gantt-label">
                    <div className="gantt-avatar-float">
                      <Avatar designer={designer} size={compactTimeline ? 22 : 28} />
                    </div>
                  </div>
                  <div className="gantt-track">
                    <div
                      className="gantt-bar"
                      style={{
                        left: `${startPct}%`,
                        width: `${Math.max(widthPct, 0.35)}%`,
                        background: isComplete ? '#F2F2F7' : colors.bg,
                        opacity: isWaiting ? 0.55 : 1,
                        backgroundImage: isWaiting
                          ? `repeating-linear-gradient(-45deg, transparent, transparent 4px, ${colors.bar}18 4px, ${colors.bar}18 8px)`
                          : 'none',
                      }}
                    >
                      <div
                        className="gantt-bar-label-stack"
                        style={{ color: isComplete ? 'rgba(60, 60, 67, 0.45)' : colors.text }}
                      >
                        <span className="gantt-bar-client">{project.client}</span>
                        <span className="gantt-bar-project">{project.name}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const STUDIO_ACCESS_STORAGE = 'ew_studio_access';
const STUDIO_ACCESS_CODE = '3131';

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
      <form className="access-gate-card" onSubmit={submit}>
        <p className="access-gate-brand">Extended Whānau</p>
        <p className="access-gate-label">Access code</p>
        <input
          className="access-gate-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="••••"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
        />
        {error && <p className="access-gate-error">Code not recognised.</p>}
        <button type="submit" className="btn-primary access-gate-submit" disabled={!value}>
          Continue
        </button>
        <p className="access-gate-note">Casual protection only — not for sensitive data.</p>
      </form>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [accessUnlocked, setAccessUnlocked] = useState(() => {
    try {
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
    const list = Array.isArray(raw) && raw.length > 0 ? raw : SAMPLE_PROJECTS;
    return list.map((p) => ({ ...p, status: normalizeProjectStatus(p.status) }));
  });
  const [editingProject, setEditingProject] = useState(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [designerModalOpen, setDesignerModalOpen] = useState(false);
  const [designerBeingEdited, setDesignerBeingEdited] = useState(null);
  const [filterDesigner, setFilterDesigner] = useState('all');
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
    localStorage.setItem('studio_designers', JSON.stringify(designers));
  }, [designers]);
  useEffect(() => {
    localStorage.setItem('studio_projects', JSON.stringify(projects));
  }, [projects]);

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

  const saveProject = (p) => {
    const normalized = {
      ...p,
      status: normalizeProjectStatus(p.status),
      priority: p.priority === 'background' ? 'background' : 'priority',
    };
    setProjects(prev => {
      const exists = prev.find(x => x.id === normalized.id);
      return exists ? prev.map(x => x.id === normalized.id ? normalized : x) : [...prev, normalized];
    });
  };
  const deleteProject = (id) => setProjects(prev => prev.filter(p => p.id !== id));

  const saveDesigner = (d) => {
    setDesigners((prev) => {
      const exists = prev.find((x) => x.id === d.id);
      return exists ? prev.map((x) => (x.id === d.id ? d : x)) : [...prev, d];
    });
  };

  const deleteDesigner = (id) => {
    setDesigners((prev) => prev.filter((x) => x.id !== id));
    setProjects((prev) => prev.map((p) => (p.designerId === id ? { ...p, designerId: '' } : p)));
    setFilterDesigner((fd) => (fd === id ? 'all' : fd));
  };

  const updateProjectStatus = (id, status) => {
    setProjects(prev => prev.map(p => (p.id === id ? { ...p, status } : p)));
  };

  const designerFiltered = filterDesigner === 'all'
    ? projects
    : projects.filter(p => p.designerId === filterDesigner);

  const activeProjects = designerFiltered.filter(p => p.status !== 'Complete');
  const archivedProjects = designerFiltered
    .filter(p => p.status === 'Complete')
    .slice()
    .sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''));

  const sortFeed = (list) =>
    list.slice().sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''));

  const priorityFeed = sortFeed(activeProjects.filter(p => (p.priority || 'priority') === 'priority'));
  const smallerJobsFeed = sortFeed(activeProjects.filter(p => (p.priority || 'priority') === 'background'));

  const activeCount = projects.filter(p => p.status !== 'Complete').length;
  const archivedCount = projects.filter(p => p.status === 'Complete').length;

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
            <span className="nav-icon">≡</span> Projects
            {activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
          </button>
          <button
            type="button"
            className={`nav-item ${view === 'gantt' ? 'active' : ''}`}
            onClick={() => { setView('gantt'); closeSidebar(); }}
          >
            <span className="nav-icon">▤</span> Timeline
          </button>
          <button
            type="button"
            className={`nav-item ${view === 'archive' ? 'active' : ''}`}
            onClick={() => { setView('archive'); closeSidebar(); }}
          >
            <span className="nav-icon">▣</span> Archive
            {archivedCount > 0 && <span className="nav-badge nav-badge-muted">{archivedCount}</span>}
          </button>
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span>Team</span>
            <button
              type="button"
              className="sidebar-add-btn"
              onClick={() => {
                setDesignerBeingEdited(null);
                setDesignerModalOpen(true);
                closeSidebar();
              }}
            >
              +
            </button>
          </div>
          <div className="designer-list">
            <button
              type="button"
              className={`designer-chip ${filterDesigner === 'all' ? 'selected' : ''}`}
              onClick={() => { setFilterDesigner('all'); closeSidebar(); }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#CCC' }} />
              All
            </button>
            {designers.map((d) => {
              const c = DESIGNER_COLORS[d.colorIdx % DESIGNER_COLORS.length];
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
            <h1 className="page-title">
              {view === 'projects' ? 'Projects' : view === 'archive' ? 'Archive' : 'Timeline'}
            </h1>
          </div>
          <div className="main-header-actions">
            {view === 'gantt' && (
              <div className="gantt-toolbar gantt-toolbar--header">
                <div className="gantt-toolbar-inner" role="toolbar" aria-label="Timeline navigation">
                  <button
                    type="button"
                    className="gantt-nav-btn gantt-nav-btn--arrow"
                    onClick={() => ganttNavRef.current.scrollBy(-1)}
                    aria-label="Pan timeline left"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    className="gantt-nav-btn gantt-nav-btn--today"
                    onClick={() => ganttNavRef.current.scrollToToday()}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    className="gantt-nav-btn gantt-nav-btn--arrow"
                    onClick={() => ganttNavRef.current.scrollBy(1)}
                    aria-label="Pan timeline right"
                  >
                    ›
                  </button>
                </div>
              </div>
            )}
            {view !== 'archive' && (
              <button
                type="button"
                className="modal-btn-submit header-new-project"
                onClick={() => setShowNewProject(true)}
                aria-label="New Project"
              >
                New Project
              </button>
            )}
          </div>
        </header>

        <div className="main-content">
          {view === 'projects' && (
            <div className="project-list">
              {activeProjects.length === 0 ? (
                <div className="empty-state">
                  No active projects. Add one to get started, or check Archive for completed work.
                </div>
              ) : (
                <>
                  {priorityFeed.length > 0 && (
                    <div className="project-section">
                      {priorityFeed.map(p => (
                        <ProjectRow
                          key={p.id}
                          project={p}
                          designers={designers}
                          onClick={() => setEditingProject(p)}
                          onStatusChange={updateProjectStatus}
                        />
                      ))}
                    </div>
                  )}
                  {smallerJobsFeed.length > 0 && (
                    <div className="project-section">
                      {smallerJobsFeed.map(p => (
                        <ProjectRow
                          key={p.id}
                          project={p}
                          designers={designers}
                          onClick={() => setEditingProject(p)}
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
                      onClick={() => setEditingProject(p)}
                      onStatusChange={updateProjectStatus}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {view === 'gantt' && (
            <GanttChart
              projects={activeProjects}
              designers={designers}
              onSelectProject={setEditingProject}
              onRegisterNav={registerGanttNav}
            />
          )}
        </div>
      </main>

      {/* Modals */}
      {showNewProject && (
        <ProjectModal
          project={null}
          designers={designers}
          onClose={() => setShowNewProject(false)}
          onSave={saveProject}
          onDelete={deleteProject}
        />
      )}
      {editingProject && (
        <ProjectModal
          project={editingProject}
          designers={designers}
          onClose={() => setEditingProject(null)}
          onSave={saveProject}
          onDelete={deleteProject}
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
    </div>
  );
}
