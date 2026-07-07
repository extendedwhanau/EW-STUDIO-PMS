import { v4 as uuidv4 } from 'uuid';

export const MILESTONE_PHASE_CATALOG = [
  {
    key: 'strategy',
    title: 'Strategy',
    tasks: ['Discovery', 'Research', 'Benchmarking', 'Insight'],
  },
  {
    key: 'brand-expression',
    title: 'Brand Expression',
    tasks: ['Concept', 'Refinement', 'Guidelines', 'Assets'],
  },
  {
    key: 'production',
    title: 'Production',
    tasks: ['Photography', 'Animation', 'Video'],
  },
  {
    key: 'rollout',
    title: 'Rollout',
    tasks: ['Audit & scoping', 'Concept', 'Refinement', 'Artworking & Documentation', 'Quality Control'],
  },
  {
    key: 'signage',
    title: 'Signage',
    tasks: ['Site audit & scoping', 'Concept', 'Refinement', 'Artworking & Documentation', 'Quality Control'],
  },
];

export function taskKeyFromTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function getPhaseByKey(key) {
  return MILESTONE_PHASE_CATALOG.find((phase) => phase.key === key) || null;
}

export function getPhaseByTitle(title) {
  const normalized = String(title || '').trim().toLowerCase();
  if (!normalized) return null;
  return MILESTONE_PHASE_CATALOG.find((phase) => phase.title.toLowerCase() === normalized) || null;
}

export function getPhaseCatalogIndex(key) {
  return MILESTONE_PHASE_CATALOG.findIndex((phase) => phase.key === key);
}

export function getTaskTitleForPhase(phaseKey, taskKeyOrTitle) {
  const phase = getPhaseByKey(phaseKey);
  if (!phase) return null;
  const needle = String(taskKeyOrTitle || '').trim();
  if (!needle) return null;
  const byKey = taskKeyFromTitle(needle);
  return phase.tasks.find(
    (task) => taskKeyFromTitle(task) === byKey || task.toLowerCase() === needle.toLowerCase(),
  ) || null;
}

export function availablePhases(currentPhases) {
  const used = new Set((currentPhases || []).map((phase) => phase.phaseKey).filter(Boolean));
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
