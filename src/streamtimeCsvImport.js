import {
  MILESTONE_PHASE_CATALOG,
  createCatalogPhase,
  getPhaseByTitle,
  taskKeyFromTitle,
} from './milestoneCatalog.js';

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseMilestoneCsvDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const short = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
  if (short) {
    const day = short[1].padStart(2, '0');
    const monthIdx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .indexOf(short[2].toLowerCase());
    if (monthIdx >= 0) {
      let year = parseInt(short[3], 10);
      if (year < 100) year += 2000;
      const month = String(monthIdx + 1).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return '';
}

function normalizeCsvHeader(header) {
  return String(header || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Synonym / keyword bags for catalog phases. */
const PHASE_SIGNAL_WORDS = {
  strategy: ['strategy', 'discovery', 'research', 'insight', 'territory', 'campaign strategy'],
  design: ['design', 'expression', 'brand expression', 'campaign expression', 'guidelines', 'assets'],
  production: [
    'production', 'content creation', 'content', 'animation', 'video', 'photography',
    'copywriting', 'creative direction', 'videographer', 'animator',
  ],
  rollout: ['rollout', 'roll out', 'roll-out', 'launch', 'campaign rollout'],
  signage: ['signage', 'wayfinding', 'environmental'],
  publication: ['publication', 'print', 'editorial', 'brochure', 'book'],
  website: ['website', 'microsite', 'web', 'site', 'wireframe', 'wireframes', 'web build'],
};

/** Extra task keywords beyond the catalog title tokens. */
const TASK_SIGNAL_WORDS = {
  discovery: ['discovery'],
  research: ['research'],
  territory: ['territory', 'benchmarking'],
  insight: ['insight', 'insight development'],
  strategy: ['strategy', 'campaign strategy'],
  concept: [
    'concept', 'wireframe', 'wireframes',
    'expression development', 'expression',
    'roll out', 'rollout', 'roll-out',
  ],
  refinement: ['developed design', 'expression refinement'],
  guidelines: ['guidelines'],
  assets: ['assets'],
  'plan-and-brief': ['plan', 'brief', 'ideas', 'content streams', 'develop ideas'],
  'creative-direction': ['creative direction'],
  photography: ['photography', 'photo'],
  animation: ['animation', 'animator', 'animation development'],
  video: ['video', 'videographer', 'capture', 'editing', 'video capture'],
  copywriting: ['copywriting', 'copy'],
  'audit-and-scope': ['audit', 'scope', 'scoping'],
  'artworking-and-documentation': ['artworking', 'documentation'],
  'production-management': ['production management', 'quality control'],
  'design-system': ['design system'],
  'development-handover': [
    'handover', 'hand over', 'engage', 'website builder',
    'brief website', 'engage & brief',
  ],
  'copywriting-and-content': ['copywriting and content'],
  'build-and-quality-assurance': ['build', 'microsite build', 'quality assurance', 'qa'],
  'testing-and-refinement': [
    'testing', 'content refinement and testing', 'content refinement', 'testing and refinement',
  ],
  'launch-management': ['launch'],
  'content-flow': ['content flow', 'flow through'],
  'mark-ups': ['mark ups', 'markups'],
  artworking: ['artworking', 'art working'],
  'print-management': ['print management'],
  'site-audit-and-scoping': ['site audit'],
};

function scoreTokenOverlap(haystackTokens, needleTokens) {
  if (!needleTokens.length) return 0;
  let hits = 0;
  needleTokens.forEach((token) => {
    if (haystackTokens.includes(token)) hits += 1;
  });
  return hits / needleTokens.length;
}

function scorePhraseHits(haystack, phrases) {
  const text = String(haystack || '').toLowerCase();
  let score = 0;
  (phrases || []).forEach((phrase) => {
    if (!phrase) return;
    if (text.includes(phrase.toLowerCase())) {
      score += phrase.includes(' ') ? 2.2 : 1.1;
    }
  });
  return score;
}

/**
 * Score a Streamtime phase name + its item titles against a catalog phase.
 */
export function scorePhaseMatch(phaseName, itemNames, catalogPhase) {
  const blob = [phaseName, ...(itemNames || [])].filter(Boolean).join(' ');
  const blobTokens = tokenize(blob);
  const titleTokens = tokenize(catalogPhase.title);
  let score = scoreTokenOverlap(blobTokens, titleTokens) * 3;

  // Exact / near-exact title containment
  const phaseNorm = String(phaseName || '').toLowerCase().trim();
  const catalogNorm = catalogPhase.title.toLowerCase();
  if (phaseNorm === catalogNorm) score += 8;
  else if (phaseNorm.includes(catalogNorm) || catalogNorm.includes(phaseNorm)) score += 4;

  score += scorePhraseHits(blob, PHASE_SIGNAL_WORDS[catalogPhase.key] || []);

  // Task-title evidence inside items
  (catalogPhase.tasks || []).forEach((taskTitle) => {
    score += scorePhraseHits(blob, [taskTitle]) * 0.35;
  });

  return score;
}

export function matchCatalogPhase(phaseName, itemNames = []) {
  const exact = getPhaseByTitle(phaseName);
  if (exact) {
    return { phase: exact, score: 100, confidence: 'high' };
  }

  let best = null;
  let bestScore = 0;
  let secondScore = 0;

  MILESTONE_PHASE_CATALOG.forEach((phase) => {
    const score = scorePhaseMatch(phaseName, itemNames, phase);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = phase;
    } else if (score > secondScore) {
      secondScore = score;
    }
  });

  if (!best || bestScore < 2.2) {
    return { phase: null, score: bestScore, confidence: 'none' };
  }

  const margin = bestScore - secondScore;
  const confidence = bestScore >= 5 && margin >= 1.2
    ? 'high'
    : bestScore >= 3
      ? 'medium'
      : 'low';

  return { phase: best, score: bestScore, confidence };
}

/**
 * Prefer the most specific catalog titles when several are substrings
 * (e.g. keep "Testing & Refinement" over bare "Refinement").
 */
function preferSpecificTitles(titles) {
  return titles.filter((title) => {
    const t = title.toLowerCase();
    return !titles.some((other) => {
      if (other === title) return false;
      const o = other.toLowerCase();
      return o.includes(t) && o.length > t.length;
    });
  });
}

/**
 * Map a Streamtime item name onto one or more catalog tasks in a phase.
 * Prefers explicit multi-matches (e.g. "Discovery & Research" → both).
 */
export function matchCatalogTasks(phaseKey, itemName) {
  const catalog = MILESTONE_PHASE_CATALOG.find((p) => p.key === phaseKey);
  if (!catalog) return [];

  const name = String(itemName || '').trim();
  if (!name) return [];
  const nameNorm = name.toLowerCase();
  const nameTokens = tokenize(name);

  const contained = preferSpecificTitles(
    catalog.tasks.filter((taskTitle) => nameNorm.includes(taskTitle.toLowerCase())),
  );
  if (contained.length > 1) return contained;
  if (contained.length === 1 && contained[0].toLowerCase() === nameNorm) {
    return contained;
  }

  const scored = catalog.tasks.map((taskTitle) => {
    const key = taskKeyFromTitle(taskTitle);
    const titleTokens = tokenize(taskTitle);
    const titleNorm = taskTitle.toLowerCase();
    let score = scoreTokenOverlap(nameTokens, titleTokens) * 2.4;
    score += scorePhraseHits(name, TASK_SIGNAL_WORDS[key] || []);
    if (nameNorm === titleNorm) score += 10;
    else if (nameNorm.includes(titleNorm)) score += 1.8 + titleNorm.length * 0.12;
    else if (titleNorm.includes(nameNorm) && nameNorm.length > 5) score += 1.6;
    return { taskTitle, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 1.8) return [];

  // Include near-ties only when both are strong (combined item names)
  const tied = scored.filter((row) => row.score >= best.score - 0.4 && row.score >= 2.4);
  if (tied.length > 1) return preferSpecificTitles(tied.map((row) => row.taskTitle));
  return [best.taskTitle];
}

function mergeDateRange(current, startDate, endDate) {
  const next = current || { startDate: '', endDate: '' };
  const start = startDate || '';
  const end = endDate || start;
  if (!start && !end) return next;
  return {
    startDate: !next.startDate || (start && start < next.startDate) ? start : next.startDate,
    endDate: !next.endDate || (end && end > next.endDate) ? end : next.endDate,
  };
}

function buildCatalogPhaseFromImport(phaseKey, itemRows, warnings, sourcePhaseName) {
  const phase = createCatalogPhase(phaseKey);
  if (!phase) return null;

  const taskDates = new Map();
  let phaseRange = null;

  itemRows.forEach((item) => {
    phaseRange = mergeDateRange(phaseRange, item.startDate, item.endDate || item.startDate);

    const matchedTitles = matchCatalogTasks(phaseKey, item.name);
    if (matchedTitles.length === 0) {
      warnings.push(
        `“${item.name}” under ${sourcePhaseName} didn’t match a catalog task — used for dates only.`,
      );
      return;
    }
    matchedTitles.forEach((title) => {
      const key = taskKeyFromTitle(title);
      taskDates.set(
        key,
        mergeDateRange(taskDates.get(key), item.startDate, item.endDate || item.startDate),
      );
    });
  });

  phase.scheduleMode = 'custom';
  phase.durationWeeks = null;
  phase.startDate = phaseRange?.startDate || '';
  phase.endDate = phaseRange?.endDate || phase.startDate || '';
  phase.tasks = phase.tasks.map((task) => {
    const range = taskDates.get(task.taskKey);
    if (!range?.startDate) return task;
    return {
      ...task,
      startDate: range.startDate,
      endDate: range.endDate || range.startDate,
    };
  });

  return phase;
}

function detectFormat(headers) {
  const hasPhaseName = headers.includes('phase name');
  const hasName = headers.includes('name');
  const hasTitle = headers.includes('title');
  const hasType = headers.includes('type');
  if (hasType && hasPhaseName && hasName) return 'streamtime';
  if (hasType && hasTitle) return 'legacy';
  return null;
}

function parseStreamtimeRows(lines, headers, col) {
  const groups = new Map();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const type = col(cells, 'type').toLowerCase();
    const phaseName = col(cells, 'phase name', 'phase');
    const name = col(cells, 'name', 'title');
    const startDate = parseMilestoneCsvDate(col(cells, 'start date'));
    const endDate = parseMilestoneCsvDate(col(cells, 'end date'));

    if (!type || !phaseName) continue;
    // Streamtime review/signoff rows — skip for catalog mapping (v1)
    if (type === 'milestone') continue;
    if (type !== 'item' && type !== 'task') continue;
    if (!name) continue;

    const key = phaseName.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { phaseName, items: [] });
    }
    groups.get(key).items.push({ name, startDate, endDate });
  }

  return [...groups.values()];
}

function parseLegacyRows(lines, headers, col) {
  const groups = new Map();
  const phaseOrder = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const type = col(cells, 'type').toLowerCase();
    const title = col(cells, 'title', 'name');
    const phaseName = col(cells, 'phase', 'phase name');
    const startDate = parseMilestoneCsvDate(col(cells, 'start date'));
    const endDate = parseMilestoneCsvDate(col(cells, 'end date'));

    if (!type) continue;

    if (type === 'phase') {
      if (!title) throw new Error(`Row ${i + 1}: Phase rows need a Title.`);
      const key = title.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { phaseName: title, items: [], phaseDates: { startDate, endDate } });
        phaseOrder.push(key);
      } else {
        groups.get(key).phaseDates = mergeDateRange(groups.get(key).phaseDates, startDate, endDate);
      }
      continue;
    }

    if (type === 'task' || type === 'item') {
      if (!title) throw new Error(`Row ${i + 1}: Task rows need a Title.`);
      if (!phaseName) throw new Error(`Row ${i + 1}: Task rows need a Phase.`);
      const key = phaseName.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { phaseName, items: [] });
        phaseOrder.push(key);
      }
      groups.get(key).items.push({ name: title, startDate, endDate });
      continue;
    }

    if (type === 'milestone') continue;
    throw new Error(`Row ${i + 1}: Unknown type "${type}".`);
  }

  return phaseOrder.map((key) => groups.get(key)).filter(Boolean);
}

/**
 * Parse a Streamtime (or legacy) timeline CSV into catalog-only milestone phases.
 * @returns {{ phases: object[], warnings: string[] }}
 */
export function importTimelineCsv(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!normalized) throw new Error('CSV file is empty.');

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV must include a header row and at least one data row.');

  const headers = splitCsvLine(lines[0]).map(normalizeCsvHeader);
  const col = (row, ...names) => {
    for (let i = 0; i < names.length; i += 1) {
      const idx = headers.indexOf(names[i]);
      if (idx >= 0) return (row[idx] || '').trim();
    }
    return '';
  };

  const format = detectFormat(headers);
  if (!format) {
    throw new Error('CSV must include Type plus Name/Phase Name (Streamtime) or Title/Phase columns.');
  }

  const groups = format === 'streamtime'
    ? parseStreamtimeRows(lines, headers, col)
    : parseLegacyRows(lines, headers, col);

  if (groups.length === 0) {
    throw new Error('No timeline items found in CSV.');
  }

  const warnings = [];
  const phases = [];
  const usedPhaseKeys = new Set();

  groups.forEach((group) => {
    const itemNames = group.items.map((item) => item.name);
    const match = matchCatalogPhase(group.phaseName, itemNames);

    if (!match.phase) {
      warnings.push(`Skipped “${group.phaseName}” — no confident catalog phase match.`);
      return;
    }

    if (usedPhaseKeys.has(match.phase.key)) {
      warnings.push(
        `“${group.phaseName}” also mapped to ${match.phase.title}, which is already imported — skipped duplicate.`,
      );
      return;
    }

    if (match.confidence === 'low') {
      warnings.push(
        `Mapped “${group.phaseName}” → ${match.phase.title} with low confidence. Check this phase.`,
      );
    } else if (match.confidence === 'medium' && group.phaseName.toLowerCase() !== match.phase.title.toLowerCase()) {
      warnings.push(`Mapped “${group.phaseName}” → ${match.phase.title}.`);
    }

    const built = buildCatalogPhaseFromImport(
      match.phase.key,
      group.items,
      warnings,
      group.phaseName,
    );
    if (!built) return;

    // Legacy phase-level dates when no items carried dates
    if (!built.startDate && group.phaseDates) {
      built.startDate = group.phaseDates.startDate || '';
      built.endDate = group.phaseDates.endDate || built.startDate;
    }

    usedPhaseKeys.add(match.phase.key);
    phases.push(built);
  });

  if (phases.length === 0) {
    throw new Error('No phases could be mapped to the studio catalog.');
  }

  return { phases, warnings };
}
