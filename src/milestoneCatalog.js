import { v4 as uuidv4 } from 'uuid';

export const MILESTONE_PHASE_CATALOG = [
  {
    key: 'strategy',
    title: 'Strategy',
    tasks: ['Discovery', 'Research', 'Territory', 'Insight', 'Strategy'],
  },
  {
    key: 'design',
    title: 'Design',
    tasks: ['Concept', 'Refinement', 'Guidelines', 'Assets'],
  },
  {
    key: 'production',
    title: 'Production',
    tasks: ['Plan & Brief', 'Creative Direction', 'Photography', 'Animation', 'Video', 'Copywriting'],
  },
  {
    key: 'rollout',
    title: 'Rollout',
    tasks: ['Audit & Scope', 'Concept', 'Refinement', 'Artworking & Documentation', 'Production Management'],
  },
  {
    key: 'signage',
    title: 'Signage',
    tasks: ['Site Audit & Scoping', 'Concept', 'Refinement', 'Artworking & Documentation', 'Production Management'],
  },
  {
    key: 'publication',
    title: 'Publication',
    tasks: ['Concept', 'Refinement', 'Content Flow', 'Mark-ups', 'Artworking', 'Print Management'],
  },
  {
    key: 'website',
    title: 'Website',
    tasks: [
      'Concept',
      'Refinement',
      'Design System',
      'Development Handover',
      'Copywriting & Content',
      'Build & Quality Assurance',
      'Testing & Refinement',
      'Launch Management',
    ],
  },
];

/** Maps retired phase keys to their current catalog keys. */
const LEGACY_PHASE_KEYS = {
  'brand-expression': 'design',
};

/** Maps retired task keys/titles to their current catalog labels. */
const LEGACY_TASK_ALIASES = {
  'audit-and-scoping': 'Audit & Scope',
  'quality-control': 'Production Management',
  'art-working': 'Artworking',
  benchmarking: 'Territory',
  'flow-through': 'Content Flow',
};

export function taskKeyFromTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function getPhaseByKey(key) {
  const resolved = LEGACY_PHASE_KEYS[key] || key;
  return MILESTONE_PHASE_CATALOG.find((phase) => phase.key === resolved) || null;
}

export function getPhaseByTitle(title) {
  const normalized = String(title || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'brand expression' || normalized === 'expression') {
    return getPhaseByKey('design');
  }
  return MILESTONE_PHASE_CATALOG.find((phase) => phase.title.toLowerCase() === normalized) || null;
}

export function getPhaseCatalogIndex(key) {
  const resolved = LEGACY_PHASE_KEYS[key] || key;
  return MILESTONE_PHASE_CATALOG.findIndex((phase) => phase.key === resolved);
}

export function getTaskCatalogIndex(phaseKey, taskKeyOrTitle) {
  const phase = getPhaseByKey(phaseKey);
  if (!phase) return -1;
  const needle = String(taskKeyOrTitle || '').trim();
  if (!needle) return -1;
  const byKey = taskKeyFromTitle(needle);
  const legacyTitle = LEGACY_TASK_ALIASES[byKey] || LEGACY_TASK_ALIASES[needle];
  if (legacyTitle) {
    return phase.tasks.findIndex((task) => task === legacyTitle);
  }
  return phase.tasks.findIndex(
    (task) => taskKeyFromTitle(task) === byKey || task.toLowerCase() === needle.toLowerCase(),
  );
}

export function sortTasksByCatalog(phaseKey, tasks) {
  return (tasks || []).slice().sort((a, b) => {
    const ai = getTaskCatalogIndex(phaseKey, a.taskKey || a.title);
    const bi = getTaskCatalogIndex(phaseKey, b.taskKey || b.title);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

export function getTaskTitleForPhase(phaseKey, taskKeyOrTitle) {
  const phase = getPhaseByKey(phaseKey);
  if (!phase) return null;
  const needle = String(taskKeyOrTitle || '').trim();
  if (!needle) return null;
  const byKey = taskKeyFromTitle(needle);
  const legacyTitle = LEGACY_TASK_ALIASES[byKey] || LEGACY_TASK_ALIASES[needle];
  if (legacyTitle) {
    return phase.tasks.find((task) => task === legacyTitle) || null;
  }
  return phase.tasks.find(
    (task) => taskKeyFromTitle(task) === byKey || task.toLowerCase() === needle.toLowerCase(),
  ) || null;
}

export function availablePhases(currentPhases) {
  const used = new Set(
    (currentPhases || [])
      .map((phase) => getPhaseByKey(phase.phaseKey)?.key || phase.phaseKey)
      .filter(Boolean),
  );
  return MILESTONE_PHASE_CATALOG.filter((phase) => !used.has(phase.key));
}

export function availableTasks(phaseKey, currentTasks) {
  const phase = getPhaseByKey(phaseKey);
  if (!phase) return [];
  const used = new Set(
    (currentTasks || []).map((task) => task.taskKey || taskKeyFromTitle(task.title)).filter(Boolean),
  );
  return phase.tasks.filter((task) => !used.has(taskKeyFromTitle(task)));
}

export function sortPhasesByCatalog(phases) {
  return (phases || []).slice().sort((a, b) => {
    const ai = getPhaseCatalogIndex(a.phaseKey);
    const bi = getPhaseCatalogIndex(b.phaseKey);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

export function createCatalogPhase(phaseKey) {
  const catalog = getPhaseByKey(phaseKey);
  if (!catalog) return null;
  return {
    id: uuidv4(),
    phaseKey: catalog.key,
    title: catalog.title,
    scheduleMode: 'weeks',
    durationWeeks: 2,
    startDate: '',
    endDate: '',
    tasks: catalog.tasks.map((title) => ({
      id: uuidv4(),
      taskKey: taskKeyFromTitle(title),
      title,
    })),
  };
}

export function createCatalogTask(phaseKey, taskKeyOrTitle) {
  const title = getTaskTitleForPhase(phaseKey, taskKeyOrTitle);
  if (!title) return null;
  return {
    id: uuidv4(),
    taskKey: taskKeyFromTitle(title),
    title,
  };
}

export function insertPhaseInCatalogOrder(phases, newPhase) {
  return sortPhasesByCatalog([...(phases || []), newPhase]);
}
