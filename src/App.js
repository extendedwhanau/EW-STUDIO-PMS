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

const STATUS_OPTIONS = ['In Progress', 'Waiting on Client', 'In Review', 'Ready to Print', 'Complete'];
const PRIORITY_OPTIONS = [
  { value: 'priority', label: 'Priority' },
  { value: 'background', label: 'Secondary' },
];

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
    designerId: 'd2', status: 'Waiting on Client', priority: 'priority',
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

// ── Project Modal ─────────────────────────────────────────────────────────────
function ProjectModal({ project, designers, onClose, onSave, onDelete }) {
  const [form, setForm] = useState(() => {
    if (project) {
      return {
        ...project,
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

          <div className="field">
            <label>Type</label>
            <select value={form.priority} onChange={e => set('priority', e.target.value)}>
              {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
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
            <label>Notes</label>
            <textarea
              placeholder="Any notes for this project..."
              value={form.notes} onChange={e => set('notes', e.target.value)}
              rows={3}
            />
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
function ProjectRow({ project, designers, onClick, onStatusChange }) {
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
      </div>
      <div className="project-row-meta">
        <select
          className="row-status-select"
          value={project.status}
          onChange={e => onStatusChange(project.id, e.target.value)}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {designer && <Avatar designer={designer} size={28} />}
        <span className="project-dates">{formatDate(project.startDate)} → {formatDate(project.endDate)}</span>
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
            fontSize: 11, color: '#AAA', fontFamily: "'Die Grotesk A', ui-monospace, monospace", fontWeight: 400, fontVariantNumeric: 'tabular-nums',
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
            fontSize: 10, color: '#FF4D4D', fontFamily: "'Die Grotesk A', ui-monospace, monospace", fontVariantNumeric: 'tabular-nums', top: 4,
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
    try {
      const raw = localStorage.getItem('studio_designers');
      if (!raw) return SAMPLE_DESIGNERS;
      return normalizeDesignersFromStorage(JSON.parse(raw));
    } catch {
      return SAMPLE_DESIGNERS;
    }
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
    const normalized = {
      ...p,
      priority: p.priority === 'background' ? 'background' : 'priority',
    };
    setProjects(prev => {
      const exists = prev.find(x => x.id === normalized.id);
      return exists ? prev.map(x => x.id === normalized.id ? normalized : x) : [...prev, normalized];
    });
  };
  const deleteProject = (id) => setProjects(prev => prev.filter(p => p.id !== id));
  const addDesigner = (d) => setDesigners(prev => [...prev, d]);

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

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-text">Extended Whānau</span>
        </div>

        <nav className="sidebar-nav">
          <button className={`nav-item ${view === 'projects' ? 'active' : ''}`} onClick={() => setView('projects')}>
            <span className="nav-icon">≡</span> Projects
            {activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
          </button>
          <button className={`nav-item ${view === 'archive' ? 'active' : ''}`} onClick={() => setView('archive')}>
            <span className="nav-icon">▣</span> Archive
            {archivedCount > 0 && <span className="nav-badge nav-badge-muted">{archivedCount}</span>}
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
            <h1 className="page-title">
              {view === 'projects' ? 'Projects' : view === 'archive' ? 'Archive' : 'Timeline'}
            </h1>
            {view === 'archive' && (
              <p className="page-subtitle">
                {archivedProjects.length} completed project{archivedProjects.length !== 1 ? 's' : ''}
                {filterDesigner !== 'all' ? ` · ${designers.find(d => d.id === filterDesigner)?.name}` : ''}
              </p>
            )}
          </div>
          {view !== 'archive' && (
            <div className="main-header-actions">
              {view === 'projects' && (
                <p className="header-stat">
                  {activeProjects.length} active
                  {filterDesigner !== 'all' ? ` · ${designers.find(d => d.id === filterDesigner)?.name}` : ''}
                </p>
              )}
              {view === 'gantt' && (
                <p className="header-stat">{activeProjects.length} active</p>
              )}
              <button className="btn-primary" onClick={() => setShowNewProject(true)}>
                + New project
              </button>
            </div>
          )}
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
                      <h2 className="project-section-title">Priority</h2>
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
                      <h2 className="project-section-title">Secondary</h2>
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
                  Nothing archived yet. Set a project&apos;s status to Complete and it will appear here.
                </div>
              ) : (
                archivedProjects.map(p => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    designers={designers}
                    onClick={() => setEditingProject(p)}
                    onStatusChange={updateProjectStatus}
                  />
                ))
              )}
            </div>
          )}

          {view === 'gantt' && (
            <GanttChart projects={activeProjects} designers={designers} />
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
