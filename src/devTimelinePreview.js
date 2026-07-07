/** Dev-only timeline rows so Gantt can be tested without live Supabase data. */

function localToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localAddDays(str, n) {
  const d = new Date(`${str}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {Array<{ id: string }>} designers
 */
export function getDevTimelinePreviewProjects(designers) {
  const t = localToday();
  const d = (offset) => localAddDays(t, offset);
  const ids = designers.length > 0 ? designers.map((x) => x.id) : ['d1', 'd2', 'd3'];
  const pick = (i) => ids[i % ids.length];

  const activeRows = [
    ['Annual Report', 'Meridian Co.', 'In Progress', -10, 18],
    ['Brand Identity', 'Volta Studio', 'In Review', -5, 24],
    ['Campaign Collateral', 'Meridian Co.', 'In Progress', -14, 7],
    ['Event Signage', 'Harbour Trust', 'In Progress', -7, 14],
    ['Print Catalogue', 'Bloom Foods', 'In Review', -21, -2],
    ['Pitch Deck', 'North & Co.', 'In Progress', -3, 11],
    ['Logo Refresh', 'Studio Nine', 'In Progress', 5, 42],
  ];

  const scheduledRows = [
    ['Packaging Suite', 'Bloom Foods', 'Scheduled', 3, 21],
    ['Website Refresh', 'North & Co.', 'Ready to Start', 0, 28],
    ['Social Templates', 'Volta Studio', 'Scheduled', 7, 35],
    ['Wayfinding System', 'Harbour Trust', 'Ready to Start', 10, 56],
    ['Newsletter Q3', 'Meridian Co.', 'Scheduled', 14, 49],
    ['Q4 Report', 'North & Co.', 'Ready to Start', 21, 52],
    ['Product Launch', 'Studio Nine', 'Scheduled', 28, 70],
    ['Annual Gala', 'Harbour Trust', 'Scheduled', 56, 98],
    ['Brand Guidelines', 'Volta Studio', 'Scheduled', 90, 130],
    ['Exhibition Kit', 'Bloom Foods', 'Scheduled', 120, 160],
  ];

  const rows = [...activeRows, ...scheduledRows];

  return rows.map(([name, client, status, startOff, endOff], i) => ({
    id: `preview-${i + 1}`,
    name,
    client,
    designerId: pick(i),
    designerIds: [pick(i), pick(i + 1)].filter((v, idx, arr) => arr.indexOf(v) === idx),
    status,
    priority: i % 2 === 0 ? 'priority' : 'secondary',
    startDate: d(startOff),
    endDate: d(endOff),
    notes: 'Local preview — not saved to cloud.',
  }));
}

/** True in development when timeline preview should replace real rows. */
export function shouldUseDevTimelinePreview(activeProjects) {
  if (process.env.NODE_ENV !== 'development') return false;
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('preview') === 'timeline') return true;
  }
  return activeProjects.filter((p) => p.startDate && p.endDate).length === 0;
}
