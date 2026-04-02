import React, { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import './App.css';

// ── Designer palette ──────────────────────────────────────────────────────────
const DESIGNER_COLORS = [
  { bg: '#E8D5C4', bar: '#C4956A', text: '#7A5230' },
  { bg: '#C8D8C8', bar: '#6A9E6A', text: '#2D5A2D' },
  { bg: '#C4CDD8', bar: '#6A85A8', text: '#1F3A5F' },
  { bg: '#D8C8D8', bar: '#9E6AA8', text: '#4A1F5A' },
  { bg: '#D8D4C4', bar: '#A89E6A', text: '#5A4E1F' },
];

const DEFAULT_CHECKLIST = [
  { id: 'brief', label: 'Brief received', done: false },
  { id: 'content', label: 'Final content received', done: false },
  { id: 'quote', label: 'Print quote approved', done: false },
  { id: 'draft', label: 'First draft sent', done: false },
  { id: 'revisions', label: 'Revisions complete', done: false },
  { id: 'approval', label: 'Client approval', done: false },
  { id: 'files', label: 'Print-ready files delivered', done: false },
  { id: 'archived', label: 'Archived to Dropbox', done: false },
];

const STATUS_OPTIONS = ['In Progress', 'Waiting on Client', 'In Review', 'Ready to Print', 'Complete'];
const STATUS_COLORS = {
  'In Progress':      { bg: '#E8F0FF', text: '#2D5BE3' },
  'Waiting on Client':{ bg: '#FFF3E0', text: '#C47A00' },
  'In Review':        { bg: '#F0E8FF', text: '#6A35C4' },
  'Ready to Print':   { bg: '#E8F8EE', text: '#1E7A45' },
  'Complete':         { bg: '#F0F0F0', text: '#888' },
};

// ── Sample data ───────────────────────────────────────────────────────────────
const SAMPLE_DESIGNERS = [
  { id: 'd1', name: 'Alex', colorIdx: 0 },
  { id: 'd2', name: 'Jordan', colorIdx: 1 },
  { id: 'd3', name: 'Sam', colorIdx: 2 },
];

const SAMPLE_PROJECTS = [
  {
    id: 'p1', name: 'Annual Report', client: 'Meridian Co.',
    designerId: 'd1', status: 'In Progress',
    startDate: '2025-04-01', endDate: '2025-04-28',
    dropboxUrl: '', notes: 'Cover options due first.',
    checklist: DEFAULT_CHECKLIST.map((i, idx) => ({ ...i, done: idx < 2 })),
  },
  {
    id: 'p2', name: 'Brand Identity', client: 'Volta Studio',
    designerId: 'd2', status: 'Waiting on Client',
    startDate: '2025-04-05', endDate: '2025-05-10',
    dropboxUrl: '', notes: 'Awaiting logo feedback.',
    checklist: DEFAULT_CHECKLIST.map((i, idx) => ({ ...i, done: idx < 1 })),
  },
  {
    id: 'p3', name: 'Packaging Suite', client: 'Bloom Foods',
    designerId: 'd3', status: 'In Review',
    startDate: '2025-04-10', endDate: '2025-04-24',
    dropboxUrl: '', notes: '',
    checklist: DEFAULT_CHECKLIST.map((i, idx) => ({ ...i, done: idx < 4 })),
  },
  {
    id: 'p4', name: 'Campaign Collateral', client: 'Meridian Co.',
    designerId: 'd1', status: 'In Progress',
    startDate: '2025-04-15', endDate: '2025-05-05',
    dropboxUrl: '', notes: 'Three formats needed.',
    checklist: DEFAULT_CHECKLIST.map(i => ({ ...i, done: false })),
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
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
  return new Date().toISOString().slice(0, 10);
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

function StatusPill({ status }) {
  const c = STATUS_COLORS[status] || { bg: '#f0f0f0', text: '#888' };
  return (
    <span style={{
      background: c.bg, color: c.text,
      fontSize: 11, fontWeight: 500, padding: '3px 9px',
      borderRadius: 99, letterSpacing: '0.01em', whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  );
}

function ChecklistProgress({ checklist }) {
  const done = checklist.filter(i => i.done).length;
  const total = checklist.length;
  const pct = total ? (done / total) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 3, background: '#EBEBEB', borderRadius: 99, overflow: 'hidden', minWidth: 60 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: '#1A1A1A', borderRadius: 99, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 11, color: '#999', fontFamily: 'DM Mono', whiteSpace: 'nowrap' }}>
        {done}/{total}
      </span>
    </div>
  );
}

// ── Project Modal ─────────────────────────────────────────────────────────────
function ProjectModal({ project, designers, onClose, onSave, onDelete }) {
  const [form, setForm] = useState(project ? { ...project } : {
    id: uuidv4(), name: '', client: '', designerId: designers[0]?.id || '',
    status: 'In Progress', startDate: today(), endDate: addDays(today(), 14),
    dropboxUrl: '', notes: '',
    checklist: DEFAULT_CHECKLIST.map(i => ({ ...i })),
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggleCheck = (id) => setForm(f => ({
    ...f,
    checklist: f.checklist.map(i => i.id === id ? { ...i, done: !i.done } : i),
  }));

  const designer = designers.find(d => d.id === form.designerId);
  const colors = designer ? DESIGNER_COLORS[designer.colorIdx % DESIGNER_COLORS.length] : null;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        {/* Header accent */}
        {colors && <div style={{ height: 4, background: colors.bar, borderRadius: '12px 12px 0 0', margin: '-1px -1px 0' }} />}

        <div className="modal-header">
          <div>
            <input
              className="modal-title-input"
              placeholder="Project name"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
            <input
              className="modal-client-input"
              placeholder="Client name"
              value={form.client}
              onChange={e => set('client', e.target.value)}
            />
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="modal-row">
            <div className="field">
              <label>Designer</label>
              <select value={form.designerId} onChange={e => set('designerId', e.target.value)}>
                {designers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                <option value="">Unassigned</option>
              </select>
            </div>
            <div className="field">
              <label>Status</label>
              <select value={form.status} onChange={e => set('status', e.target.value)}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div className="modal-row">
            <div className="field">
              <label>Start date</label>
              <input type="date" value={form.startDate} onChange={e => set('startDate', e.target.value)} />
            </div>
            <div className="field">
              <label>End date</label>
              <input type="date" value={form.endDate} onChange={e => set('endDate', e.target.value)} />
            </div>
          </div>

          <div className="field">
            <label>Dropbox folder link</label>
            <input
              type="url" placeholder="https://dropbox.com/sh/..."
              value={form.dropboxUrl} onChange={e => set('dropboxUrl', e.target.value)}
            />
          </div>

          <div className="field">
            <label>Notes</label>
            <textarea
              placeholder="Any notes for this project..."
              value={form.notes} onChange={e => set('notes', e.target.value)}
              rows={3}
            />
          </div>

          <div className="field">
            <label>Checklist</label>
            <div className="checklist">
              {form.checklist.map(item => (
                <label key={item.id} className="check-item">
                  <input
                    type="checkbox" checked={item.done}
                    onChange={() => toggleCheck(item.id)}
                  />
                  <span style={{ textDecoration: item.done ? 'line-through' : 'none', color: item.done ? '#BBB' : '#1A1A1A' }}>
                    {item.label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          {project && (
            <button className="btn-delete" onClick={() => { onDelete(project.id); onClose(); }}>
              Delete project
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              onClick={() => { onSave(form); onClose(); }}
              disabled={!form.name}
            >
              {project ? 'Save changes' : 'Add project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Designer Modal ────────────────────────────────────────────────────────────
function DesignerModal({ onClose, onAdd }) {
  const [name, setName] = useState('');
  const [colorIdx, setColorIdx] = useState(0);
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 380 }}>
        <div className="modal-header">
          <span style={{ fontWeight: 600, fontSize: 16 }}>Add designer</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Name</label>
            <input placeholder="Designer name" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>Colour</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {DESIGNER_COLORS.map((c, i) => (
                <button key={i} onClick={() => setColorIdx(i)} style={{
                  width: 28, height: 28, borderRadius: '50%', background: c.bar,
                  border: colorIdx === i ? '2px solid #1A1A1A' : '2px solid transparent',
                  cursor: 'pointer', outline: 'none',
                }} />
              ))}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={() => { onAdd({ id: uuidv4(), name, colorIdx }); onClose(); }} disabled={!name}>
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Project Row ───────────────────────────────────────────────────────────────
function ProjectRow({ project, designers, onClick }) {
  const designer = designers.find(d => d.id === project.designerId);
  const colors = designer ? DESIGNER_COLORS[designer.colorIdx % DESIGNER_COLORS.length] : null;
  return (
    <div className="project-row" onClick={() => onClick(project)}>
      {colors && <div style={{ width: 3, background: colors.bar, borderRadius: 99, flexShrink: 0 }} />}
      <div className="project-row-main">
        <div className="project-row-top">
          <span className="project-name">{project.name}</span>
          <span className="project-client">{project.client}</span>
        </div>
        <ChecklistProgress checklist={project.checklist} />
      </div>
      <div className="project-row-meta">
        <StatusPill status={project.status} />
        {designer && <Avatar designer={designer} size={28} />}
        <span className="project-dates">{formatDate(project.startDate)} → {formatDate(project.endDate)}</span>
        {project.dropboxUrl && (
          <a href={project.dropboxUrl} target="_blank" rel="noreferrer"
            onClick={e => e.stopPropagation()}
            className="dropbox-link" title="Open Dropbox folder">
            ⬡
          </a>
        )}
      </div>
    </div>
  );
}

// ── Gantt Chart ───────────────────────────────────────────────────────────────
function GanttChart({ projects, designers }) {
  const containerRef = useRef(null);
  const todayStr = today();
  const todayDay = daysFromEpoch(todayStr);

  const validProjects = projects.filter(p => p.startDate && p.endDate);
  if (!validProjects.length) return (
    <div className="empty-state">No projects with timelines yet.</div>
  );

  const allStarts = validProjects.map(p => daysFromEpoch(p.startDate));
  const allEnds = validProjects.map(p => daysFromEpoch(p.endDate));
  const minDay = Math.min(...allStarts) - 3;
  const maxDay = Math.max(...allEnds) + 5;
  const totalDays = maxDay - minDay;

  const pct = (day) => ((day - minDay) / totalDays) * 100;

  // Build month labels
  const months = [];
  let cur = new Date(minDay * 86400000);
  cur.setDate(1);
  while (daysFromEpoch(cur.toISOString().slice(0, 10)) <= maxDay) {
    months.push({ label: cur.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }), day: daysFromEpoch(cur.toISOString().slice(0, 10)) });
    cur.setMonth(cur.getMonth() + 1);
  }

  const todayPct = pct(todayDay);

  return (
    <div className="gantt-wrapper" ref={containerRef}>
      {/* Month header */}
      <div className="gantt-months" style={{ position: 'relative', height: 28 }}>
        {months.map((m, i) => (
          <div key={i} style={{
            position: 'absolute', left: `${pct(m.day)}%`,
            fontSize: 11, color: '#AAA', fontFamily: 'DM Mono', fontWeight: 400,
            transform: 'none', top: 6,
          }}>
            {m.label}
          </div>
        ))}
      </div>

      {/* Rows */}
      <div className="gantt-rows">
        {validProjects.map(project => {
          const designer = designers.find(d => d.id === project.designerId);
          const colors = designer ? DESIGNER_COLORS[designer.colorIdx % DESIGNER_COLORS.length] : { bg: '#EEE', bar: '#CCC', text: '#888' };
          const startPct = pct(daysFromEpoch(project.startDate));
          const endPct = pct(daysFromEpoch(project.endDate));
          const widthPct = endPct - startPct;
          const isWaiting = project.status === 'Waiting on Client';
          const isComplete = project.status === 'Complete';
          const done = project.checklist.filter(i => i.done).length;
          const total = project.checklist.length;

          return (
            <div key={project.id} className="gantt-row">
              <div className="gantt-label">
                <Avatar designer={designer} size={22} />
                <span className="gantt-project-name">{project.name}</span>
                <span className="gantt-client-name">{project.client}</span>
              </div>
              <div className="gantt-track">
                {/* Today line */}
                {todayPct >= 0 && todayPct <= 100 && (
                  <div style={{
                    position: 'absolute', left: `${todayPct}%`, top: 0, bottom: 0,
                    width: 1, background: '#FF4D4D', zIndex: 2, opacity: 0.5,
                  }} />
                )}
                {/* Bar */}
                <div style={{
                  position: 'absolute',
                  left: `${startPct}%`,
                  width: `${Math.max(widthPct, 1)}%`,
                  top: '50%', transform: 'translateY(-50%)',
                  height: 28, borderRadius: 6,
                  background: isComplete ? '#EBEBEB' : colors.bg,
                  border: `1.5px solid ${isComplete ? '#DDD' : colors.bar}`,
                  display: 'flex', alignItems: 'center', overflow: 'hidden',
                  opacity: isWaiting ? 0.65 : 1,
                  backgroundImage: isWaiting
                    ? `repeating-linear-gradient(-45deg, transparent, transparent 4px, ${colors.bar}22 4px, ${colors.bar}22 8px)`
                    : 'none',
                }}>
                  {/* Progress fill */}
                  {!isComplete && total > 0 && (
                    <div style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0,
                      width: `${(done / total) * 100}%`,
                      background: colors.bar, opacity: 0.18, borderRadius: '4px 0 0 4px',
                    }} />
                  )}
                  <span style={{
                    fontSize: 11, fontWeight: 500, color: isComplete ? '#AAA' : colors.text,
                    paddingLeft: 8, whiteSpace: 'nowrap', overflow: 'hidden',
                    textOverflow: 'ellipsis', position: 'relative', zIndex: 1,
                  }}>
                    {project.name}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Today label */}
      {todayPct >= 0 && todayPct <= 100 && (
        <div style={{ position: 'relative', height: 20 }}>
          <span style={{
            position: 'absolute', left: `${todayPct}%`, transform: 'translateX(-50%)',
            fontSize: 10, color: '#FF4D4D', fontFamily: 'DM Mono', top: 4,
          }}>
            today
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState('projects');
  const [designers, setDesigners] = useState(() => {
    try { return JSON.parse(localStorage.getItem('studio_designers')) || SAMPLE_DESIGNERS; } catch { return SAMPLE_DESIGNERS; }
  });
  const [projects, setProjects] = useState(() => {
    try { return JSON.parse(localStorage.getItem('studio_projects')) || SAMPLE_PROJECTS; } catch { return SAMPLE_PROJECTS; }
  });
  const [editingProject, setEditingProject] = useState(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewDesigner, setShowNewDesigner] = useState(false);
  const [filterDesigner, setFilterDesigner] = useState('all');

  useEffect(() => {
    localStorage.setItem('studio_designers', JSON.stringify(designers));
  }, [designers]);
  useEffect(() => {
    localStorage.setItem('studio_projects', JSON.stringify(projects));
  }, [projects]);

  const saveProject = (p) => {
    setProjects(prev => {
      const exists = prev.find(x => x.id === p.id);
      return exists ? prev.map(x => x.id === p.id ? p : x) : [...prev, p];
    });
  };
  const deleteProject = (id) => setProjects(prev => prev.filter(p => p.id !== id));
  const addDesigner = (d) => setDesigners(prev => [...prev, d]);

  const visibleProjects = filterDesigner === 'all'
    ? projects
    : projects.filter(p => p.designerId === filterDesigner);

  const activeCount = projects.filter(p => p.status !== 'Complete').length;

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-mark">◆</span>
          <span className="logo-text">Studio</span>
        </div>

        <nav className="sidebar-nav">
          <button className={`nav-item ${view === 'projects' ? 'active' : ''}`} onClick={() => setView('projects')}>
            <span className="nav-icon">≡</span> Projects
            {activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
          </button>
          <button className={`nav-item ${view === 'gantt' ? 'active' : ''}`} onClick={() => setView('gantt')}>
            <span className="nav-icon">▤</span> Timeline
          </button>
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span>Team</span>
            <button className="sidebar-add-btn" onClick={() => setShowNewDesigner(true)}>+</button>
          </div>
          <div className="designer-list">
            <button
              className={`designer-chip ${filterDesigner === 'all' ? 'selected' : ''}`}
              onClick={() => setFilterDesigner('all')}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#CCC' }} />
              All
            </button>
            {designers.map(d => {
              const c = DESIGNER_COLORS[d.colorIdx % DESIGNER_COLORS.length];
              return (
                <button
                  key={d.id}
                  className={`designer-chip ${filterDesigner === d.id ? 'selected' : ''}`}
                  onClick={() => setFilterDesigner(filterDesigner === d.id ? 'all' : d.id)}
                >
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.bar }} />
                  {d.name}
                </button>
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
          <div>
            <h1 className="page-title">{view === 'projects' ? 'Projects' : 'Timeline'}</h1>
            <p className="page-subtitle">
              {view === 'projects'
                ? `${visibleProjects.length} project${visibleProjects.length !== 1 ? 's' : ''}${filterDesigner !== 'all' ? ` · ${designers.find(d => d.id === filterDesigner)?.name}` : ''}`
                : `${visibleProjects.length} project${visibleProjects.length !== 1 ? 's' : ''} across ${designers.length} designer${designers.length !== 1 ? 's' : ''}`}
            </p>
          </div>
          <button className="btn-primary" onClick={() => setShowNewProject(true)}>
            + New project
          </button>
        </header>

        <div className="main-content">
          {view === 'projects' && (
            <div className="project-list">
              {visibleProjects.length === 0 ? (
                <div className="empty-state">
                  No projects yet. Add one to get started.
                </div>
              ) : (
                visibleProjects.map(p => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    designers={designers}
                    onClick={() => setEditingProject(p)}
                  />
                ))
              )}
            </div>
          )}

          {view === 'gantt' && (
            <GanttChart projects={visibleProjects} designers={designers} />
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
      {showNewDesigner && (
        <DesignerModal
          onClose={() => setShowNewDesigner(false)}
          onAdd={addDesigner}
        />
      )}
    </div>
  );
}
