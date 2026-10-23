import React, { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { STANDARD_WORK_HOURS } from './timeTrackerConfig';

const ENTRIES_STORAGE = 'time_tracker_entries';
const TIMER_STORAGE = 'time_tracker_timer';
const ENTRIES_EVENT = 'time-tracker-entries-changed';
const STOP_AFTER_MS = 5 * 60 * 1000;
const MIN_LOG_MS = 60 * 1000;

function todayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return '0h';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function jobLabel(project) {
  if (!project) return '';
  const name = String(project.name || '').trim() || 'Untitled';
  const client = String(project.client || '').trim();
  return client ? `${client}: ${name}` : name;
}

function loadEntries() {
  try {
    const raw = JSON.parse(localStorage.getItem(ENTRIES_STORAGE));
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object') : [];
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  try {
    localStorage.setItem(ENTRIES_STORAGE, JSON.stringify(entries));
  } catch (err) {
    console.error('[Time] save failed:', err);
  }
  window.dispatchEvent(new Event(ENTRIES_EVENT));
}

function useTodayEntries() {
  const [entries, setEntries] = useState(loadEntries);
  useEffect(() => {
    const refresh = () => setEntries(loadEntries());
    window.addEventListener(ENTRIES_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(ENTRIES_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const today = todayDateString();
  return entries.filter((e) => e.date === today);
}

const EMPTY_TIMER = {
  jobId: '',
  running: false,
  segmentStartedAt: null,
  accumulatedMs: 0,
  firstStartedAt: null,
};

function loadTimer() {
  try {
    const raw = JSON.parse(localStorage.getItem(TIMER_STORAGE));
    if (!raw || typeof raw !== 'object') return EMPTY_TIMER;
    return { ...EMPTY_TIMER, ...raw };
  } catch {
    return EMPTY_TIMER;
  }
}

function elapsedMs(timer, now) {
  const live = timer.running && timer.segmentStartedAt ? now - timer.segmentStartedAt : 0;
  return (timer.accumulatedMs || 0) + Math.max(0, live);
}

function logTime(timer, project, ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return;
  const entry = {
    id: uuidv4(),
    date: todayDateString(),
    jobId: timer.jobId,
    jobName: project?.name || '',
    jobClient: project?.client || '',
    minutes,
    status: 'Logged',
    startTime: timer.firstStartedAt ? new Date(timer.firstStartedAt).toISOString() : null,
    endTime: new Date().toISOString(),
    notes: '',
  };
  saveEntries([...loadEntries(), entry]);
}

/**
 * Small always-on timer pill, bottom centre. Job picker lists the signed-in
 * designer's jobs first, then everything else.
 */
export function TimerDock({ myJobs, otherJobs, raised = false }) {
  const [timer, setTimerState] = useState(loadTimer);
  const [now, setNow] = useState(() => Date.now());

  const setTimer = useCallback((next) => {
    setTimerState(next);
    try {
      localStorage.setItem(TIMER_STORAGE, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!timer.running) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timer.running]);

  const [open, setOpen] = useState(false);
  const pillRef = useRef(null);
  const closeTimer = useRef(null);

  const openPill = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };

  const schedulePillClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      const root = pillRef.current;
      if (root && root.contains(document.activeElement)) return;
      setOpen(false);
    }, 120);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (pillRef.current && !pillRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const allJobs = [...myJobs, ...otherJobs];
  const project = allJobs.find((p) => p.id === timer.jobId) || null;
  const elapsed = elapsedMs(timer, now);
  const canStop = !timer.running && elapsed >= STOP_AFTER_MS;
  const expanded = open || !project;

  const changeJob = (nextId) => {
    if (!nextId || nextId === timer.jobId) return;
    const at = Date.now();
    const spent = elapsedMs(timer, at);
    if (timer.jobId && spent >= MIN_LOG_MS) logTime(timer, project, spent);
    setTimer({
      ...EMPTY_TIMER,
      jobId: nextId,
      running: timer.running,
      segmentStartedAt: timer.running ? at : null,
      firstStartedAt: timer.running ? at : null,
    });
  };

  const toggle = () => {
    const at = Date.now();
    if (timer.running) {
      setTimer({
        ...timer,
        running: false,
        segmentStartedAt: null,
        accumulatedMs: elapsedMs(timer, at),
      });
    } else {
      setTimer({
        ...timer,
        running: true,
        segmentStartedAt: at,
        firstStartedAt: timer.firstStartedAt || at,
      });
    }
    setNow(at);
  };

  const stop = () => {
    logTime(timer, project, elapsed);
    setTimer({ ...EMPTY_TIMER, jobId: timer.jobId });
  };

  return (
    <div className={`timer-dock${raised ? ' timer-dock--raised' : ''}`}>
      <div
        ref={pillRef}
        className={[
          'timer-pill',
          timer.running ? 'timer-pill--running' : '',
          expanded ? 'timer-pill--open' : '',
        ].filter(Boolean).join(' ')}
        onMouseEnter={openPill}
        onMouseLeave={schedulePillClose}
        onBlur={schedulePillClose}
        onClick={openPill}
      >
        <label
          className={`timer-job${project ? '' : ' timer-job--empty'}`}
          aria-hidden={!expanded}
        >
          <span className="timer-job-label">
            {project ? (String(project.client || '').trim() || jobLabel(project)) : '+ Job'}
          </span>
          <select
            className="timer-job-select"
            tabIndex={expanded ? 0 : -1}
            onFocus={openPill}
            value={timer.jobId}
            aria-label="Job to track time against"
            onChange={(e) => changeJob(e.target.value)}
          >
            <option value="" disabled>Pick a job</option>
            {myJobs.map((p) => (
              <option key={p.id} value={p.id}>{jobLabel(p)}</option>
            ))}
            {myJobs.length > 0 && otherJobs.length > 0 ? (
              <option disabled value="__divider">–</option>
            ) : null}
            {otherJobs.map((p) => (
              <option key={p.id} value={p.id}>{jobLabel(p)}</option>
            ))}
          </select>
        </label>
        <span className="timer-clock" aria-live="off">{formatClock(elapsed)}</span>
        <button
          type="button"
          className="timer-btn timer-btn--toggle"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          disabled={!project}
          aria-label={timer.running ? 'Pause timer' : 'Start timer'}
        >
          {timer.running ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
              <rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M4.5 2.8v10.4a.8.8 0 0 0 1.2.7l8.4-5.2a.8.8 0 0 0 0-1.4L5.7 2.1a.8.8 0 0 0-1.2.7z" fill="currentColor" />
            </svg>
          )}
        </button>
        {canStop && expanded ? (
          <button
            type="button"
            className="timer-btn timer-btn--stop"
            onClick={stop}
            aria-label="Stop and log time"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TimeEntry({ entry, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState(String(Math.floor((entry.minutes || 0) / 60)));
  const [mins, setMins] = useState(String((entry.minutes || 0) % 60));

  const save = () => {
    const total = (parseInt(hours, 10) || 0) * 60 + (parseInt(mins, 10) || 0);
    if (total > 0) {
      onEdit({ ...entry, minutes: total });
      setEditing(false);
    }
  };

  const title = entry.jobClient
    ? `${entry.jobClient}: ${entry.jobName || 'Untitled'}`
    : (entry.jobName || 'No job');

  return (
    <div className="time-tracker-entry">
      <div className="time-tracker-entry-header">
        <div className="time-tracker-entry-client">{title}</div>
        {editing ? (
          <div className="time-tracker-entry-edit">
            <input
              type="number"
              min="0"
              inputMode="numeric"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="time-tracker-minutes-input"
              aria-label="Hours"
            />
            <span>h</span>
            <input
              type="number"
              min="0"
              max="59"
              inputMode="numeric"
              value={mins}
              onChange={(e) => setMins(e.target.value)}
              className="time-tracker-minutes-input"
              aria-label="Minutes"
            />
            <span>m</span>
          </div>
        ) : (
          <div className="time-tracker-entry-duration">{formatDuration(entry.minutes)}</div>
        )}
      </div>
      <div className="time-tracker-entry-actions">
        {editing ? (
          <>
            <button type="button" onClick={save} className="time-tracker-entry-action">Save</button>
            <button type="button" onClick={() => setEditing(false)} className="time-tracker-entry-action">Cancel</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setEditing(true)} className="time-tracker-entry-action">Edit</button>
            <button
              type="button"
              onClick={() => onDelete(entry.id)}
              className="time-tracker-entry-action time-tracker-entry-action--danger"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Today's logged time against the standard day. The timer itself lives in TimerDock. */
export default function TimeTracker({ onSyncToStreamtime }) {
  const todayEntries = useTodayEntries();

  const editEntry = (updated) => {
    saveEntries(loadEntries().map((e) => (e.id === updated.id ? updated : e)));
  };

  const deleteEntry = (id) => {
    if (!window.confirm('Delete this time entry?')) return;
    saveEntries(loadEntries().filter((e) => e.id !== id));
  };

  const totalMinutes = todayEntries.reduce((sum, e) => sum + (e.minutes || 0), 0);
  const targetMinutes = STANDARD_WORK_HOURS * 60;
  const progressPercent = Math.min(100, (totalMinutes / targetMinutes) * 100);
  const remainingMinutes = Math.max(0, targetMinutes - totalMinutes);

  return (
    <div className="time-tracker">
      <p className="time-tracker-date">
        {new Date().toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' })}
      </p>

      <div className="time-tracker-progress">
        <div className="time-tracker-progress-bar">
          <div className="time-tracker-progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>
        <div className="time-tracker-progress-text">
          <span className="time-tracker-logged">{formatDuration(totalMinutes)}</span>
          <span className="time-tracker-separator">/</span>
          <span className="time-tracker-target">{STANDARD_WORK_HOURS}h</span>
          {remainingMinutes > 0 && (
            <span className="time-tracker-remaining">({formatDuration(remainingMinutes)} to go)</span>
          )}
        </div>
      </div>

      {todayEntries.length === 0 ? (
        <p className="time-tracker-empty">
          Nothing logged yet today. Pick a job in the timer at the bottom left and press play.
        </p>
      ) : (
        <div className="time-tracker-entries">
          {todayEntries.map((entry) => (
            <TimeEntry key={entry.id} entry={entry} onEdit={editEntry} onDelete={deleteEntry} />
          ))}
        </div>
      )}

      <div className="time-tracker-sync-section">
        <p className="time-tracker-sync-note">
          Time is saved in this browser. Streamtime sync isn’t connected yet.
        </p>
        <button
          type="button"
          onClick={onSyncToStreamtime}
          disabled={todayEntries.length === 0}
          className="time-tracker-sync-btn"
        >
          Sync to Streamtime
        </button>
      </div>
    </div>
  );
}
