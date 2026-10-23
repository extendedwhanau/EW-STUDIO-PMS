import React, { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { STANDARD_WORK_HOURS } from './timeTrackerConfig';

/**
 * TimeTracker — Simple mobile-friendly time tracking interface
 * 
 * Features:
 * - Start/pause/stop timer with job selection
 * - View today's tracked time vs 8h goal
 * - List of recent/active jobs for quick switching
 * - Manual time entry and editing
 */

function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return '0h';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-NZ', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
}

function todayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function JobSelector({ projects, selectedJobId, selectedJobItemId, onSelect }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [showItems, setShowItems] = useState(false);
  
  const activeProjects = projects.filter(p => 
    p.status === 'In Play' || p.status === 'Active'
  );

  const filteredProjects = searchTerm
    ? activeProjects.filter(p =>
        p.client?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.name?.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : activeProjects;

  return (
    <div className="time-tracker-job-selector">
      <input
        type="text"
        className="time-tracker-search"
        placeholder="Search jobs..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        autoFocus
      />
      <div className="time-tracker-job-list">
        {filteredProjects.length === 0 ? (
          <div className="time-tracker-no-jobs">No active jobs found</div>
        ) : (
          filteredProjects.map(project => (
            <div key={project.id} className="time-tracker-job-option">
              <button
                type="button"
                className={`time-tracker-job-btn ${selectedJobId === project.id ? 'selected' : ''}`}
                onClick={() => {
                  onSelect(project.id, null);
                  setShowItems(showItems === project.id ? false : project.id);
                }}
              >
                <span className="time-tracker-job-client">{project.client || 'No client'}</span>
                <span className="time-tracker-job-name">{project.name}</span>
              </button>
              {showItems === project.id && project.milestones?.length > 0 && (
                <div className="time-tracker-job-items">
                  {project.milestones.flatMap(phase =>
                    (phase.tasks || []).map(task => (
                      <button
                        key={task.id}
                        type="button"
                        className={`time-tracker-job-item-btn ${selectedJobItemId === task.id ? 'selected' : ''}`}
                        onClick={() => onSelect(project.id, task.id)}
                      >
                        {task.title}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TimeEntry({ entry, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState(entry.minutes);

  const handleSave = () => {
    if (minutes > 0) {
      onEdit({ ...entry, minutes });
      setEditing(false);
    }
  };

  return (
    <div className="time-tracker-entry">
      <div className="time-tracker-entry-header">
        <div className="time-tracker-entry-job">
          <div className="time-tracker-entry-client">{entry.jobName || 'Personal time'}</div>
          {entry.jobItemName && (
            <div className="time-tracker-entry-task">{entry.jobItemName}</div>
          )}
        </div>
        {editing ? (
          <div className="time-tracker-entry-edit">
            <input
              type="number"
              min="1"
              value={Math.floor(minutes / 60)}
              onChange={(e) => setMinutes(parseInt(e.target.value, 10) * 60)}
              className="time-tracker-minutes-input"
            />
            <span>h</span>
            <button onClick={handleSave} className="time-tracker-btn-save">Save</button>
            <button onClick={() => setEditing(false)} className="time-tracker-btn-cancel">Cancel</button>
          </div>
        ) : (
          <div className="time-tracker-entry-duration">
            {formatDuration(entry.minutes)}
          </div>
        )}
      </div>
      {!editing && (
        <div className="time-tracker-entry-actions">
          <button onClick={() => setEditing(true)} className="time-tracker-entry-action">Edit</button>
          <button onClick={() => onDelete(entry.id)} className="time-tracker-entry-action time-tracker-entry-action--danger">Delete</button>
        </div>
      )}
    </div>
  );
}

export default function TimeTracker({ 
  projects, 
  streamtimeUserId,
  onSyncToStreamtime 
}) {
  const [timerState, setTimerState] = useState('stopped'); // stopped, running, paused
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [selectedJobItemId, setSelectedJobItemId] = useState(null);
  const [startTime, setStartTime] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [todayEntries, setTodayEntries] = useState([]);
  const [showJobSelector, setShowJobSelector] = useState(false);
  const intervalRef = useRef(null);

  const selectedProject = projects.find(p => p.id === selectedJobId);

  // Load today's entries from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('time_tracker_entries');
      if (stored) {
        const entries = JSON.parse(stored);
        const today = todayDateString();
        setTodayEntries(entries.filter(e => e.date === today));
      }
    } catch (err) {
      console.error('Failed to load time entries:', err);
    }
  }, []);

  // Save entries to localStorage
  const saveEntries = useCallback((entries) => {
    try {
      localStorage.setItem('time_tracker_entries', JSON.stringify(entries));
      const today = todayDateString();
      setTodayEntries(entries.filter(e => e.date === today));
    } catch (err) {
      console.error('Failed to save time entries:', err);
    }
  }, []);

  // Timer tick
  useEffect(() => {
    if (timerState === 'running') {
      intervalRef.current = setInterval(() => {
        setElapsedSeconds(s => s + 1);
      }, 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [timerState]);

  const startTimer = () => {
    setStartTime(new Date());
    setElapsedSeconds(0);
    setTimerState('running');
  };

  const pauseTimer = () => {
    setTimerState('paused');
  };

  const resumeTimer = () => {
    setTimerState('running');
  };

  const stopTimer = () => {
    if (elapsedSeconds < 60) {
      if (window.confirm('Timer has less than 1 minute. Discard this time?')) {
        setTimerState('stopped');
        setStartTime(null);
        setElapsedSeconds(0);
        setSelectedJobId(null);
        setSelectedJobItemId(null);
      }
      return;
    }

    const minutes = Math.round(elapsedSeconds / 60);
    const entry = {
      id: uuidv4(),
      date: todayDateString(),
      jobId: selectedJobId,
      jobName: selectedProject?.name,
      jobClient: selectedProject?.client,
      jobItemId: selectedJobItemId,
      jobItemName: null, // TODO: get from project structure
      minutes,
      status: 'Logged',
      startTime: startTime?.toISOString(),
      endTime: new Date().toISOString(),
      notes: '',
    };

    try {
      const stored = localStorage.getItem('time_tracker_entries') || '[]';
      const allEntries = JSON.parse(stored);
      allEntries.push(entry);
      saveEntries(allEntries);
    } catch (err) {
      console.error('Failed to save entry:', err);
    }

    setTimerState('stopped');
    setStartTime(null);
    setElapsedSeconds(0);
    setSelectedJobId(null);
    setSelectedJobItemId(null);
  };

  const handleJobSelect = (jobId, jobItemId) => {
    setSelectedJobId(jobId);
    setSelectedJobItemId(jobItemId);
    setShowJobSelector(false);
  };

  const handleEditEntry = (updatedEntry) => {
    try {
      const stored = localStorage.getItem('time_tracker_entries') || '[]';
      const allEntries = JSON.parse(stored);
      const index = allEntries.findIndex(e => e.id === updatedEntry.id);
      if (index >= 0) {
        allEntries[index] = updatedEntry;
        saveEntries(allEntries);
      }
    } catch (err) {
      console.error('Failed to update entry:', err);
    }
  };

  const handleDeleteEntry = (entryId) => {
    if (window.confirm('Delete this time entry?')) {
      try {
        const stored = localStorage.getItem('time_tracker_entries') || '[]';
        const allEntries = JSON.parse(stored);
        saveEntries(allEntries.filter(e => e.id !== entryId));
      } catch (err) {
        console.error('Failed to delete entry:', err);
      }
    }
  };

  const totalMinutesLogged = todayEntries.reduce((sum, e) => sum + (e.minutes || 0), 0);
  const targetMinutes = STANDARD_WORK_HOURS * 60;
  const progressPercent = Math.min(100, (totalMinutesLogged / targetMinutes) * 100);
  const remainingMinutes = Math.max(0, targetMinutes - totalMinutesLogged);

  return (
    <div className="time-tracker">
      <div className="time-tracker-header">
        <h1>Time Tracker</h1>
        <p className="time-tracker-date">{new Date().toLocaleDateString('en-NZ', { 
          weekday: 'long', 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })}</p>
      </div>

      <div className="time-tracker-progress">
        <div className="time-tracker-progress-bar">
          <div 
            className="time-tracker-progress-fill" 
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="time-tracker-progress-text">
          <span className="time-tracker-logged">{formatDuration(totalMinutesLogged)}</span>
          <span className="time-tracker-separator">/</span>
          <span className="time-tracker-target">{STANDARD_WORK_HOURS}h</span>
          {remainingMinutes > 0 && (
            <span className="time-tracker-remaining">({formatDuration(remainingMinutes)} to go)</span>
          )}
        </div>
      </div>

      <div className="time-tracker-timer-section">
        {timerState === 'stopped' ? (
          <>
            {selectedJobId ? (
              <div className="time-tracker-selected-job">
                <div className="time-tracker-selected-job-name">
                  {selectedProject?.client} — {selectedProject?.name}
                </div>
                <button
                  type="button"
                  onClick={() => setShowJobSelector(true)}
                  className="time-tracker-change-job"
                >
                  Change job
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowJobSelector(true)}
                className="time-tracker-select-job"
              >
                Select a job
              </button>
            )}
            <button
              type="button"
              onClick={startTimer}
              disabled={!selectedJobId}
              className="time-tracker-start-btn"
            >
              Start my day
            </button>
          </>
        ) : (
          <>
            <div className="time-tracker-active">
              <div className="time-tracker-active-job">
                {selectedProject?.client} — {selectedProject?.name}
              </div>
              <div className="time-tracker-active-time">
                {formatDuration(Math.floor(elapsedSeconds / 60))}
              </div>
              <div className="time-tracker-active-since">
                Started at {startTime ? formatTime(startTime) : '—'}
              </div>
            </div>
            <div className="time-tracker-controls">
              {timerState === 'running' ? (
                <button
                  type="button"
                  onClick={pauseTimer}
                  className="time-tracker-pause-btn"
                >
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  onClick={resumeTimer}
                  className="time-tracker-resume-btn"
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                onClick={stopTimer}
                className="time-tracker-stop-btn"
              >
                Stop & Log
              </button>
              <button
                type="button"
                onClick={() => setShowJobSelector(true)}
                className="time-tracker-switch-btn"
              >
                Switch job
              </button>
            </div>
          </>
        )}
      </div>

      {todayEntries.length > 0 && (
        <div className="time-tracker-entries">
          <h2 className="time-tracker-entries-title">Today's entries</h2>
          {todayEntries.map(entry => (
            <TimeEntry
              key={entry.id}
              entry={entry}
              onEdit={handleEditEntry}
              onDelete={handleDeleteEntry}
            />
          ))}
        </div>
      )}

      {showJobSelector && (
        <div className="time-tracker-modal">
          <div className="time-tracker-modal-backdrop" onClick={() => setShowJobSelector(false)} />
          <div className="time-tracker-modal-content">
            <div className="time-tracker-modal-header">
              <h2>Select a job</h2>
              <button
                type="button"
                onClick={() => setShowJobSelector(false)}
                className="time-tracker-modal-close"
              >
                ✕
              </button>
            </div>
            <JobSelector
              projects={projects}
              selectedJobId={selectedJobId}
              selectedJobItemId={selectedJobItemId}
              onSelect={handleJobSelect}
            />
          </div>
        </div>
      )}

      <div className="time-tracker-sync-section">
        <p className="time-tracker-sync-note">
          Time is saved locally. Sync to Streamtime to submit your hours.
        </p>
        <button
          type="button"
          onClick={onSyncToStreamtime}
          disabled={todayEntries.length === 0}
          className="time-tracker-sync-btn"
        >
          Sync {todayEntries.length} {todayEntries.length === 1 ? 'entry' : 'entries'} to Streamtime
        </button>
      </div>
    </div>
  );
}
