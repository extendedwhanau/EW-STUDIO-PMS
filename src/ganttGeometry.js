/**
 * Timeline geometry helpers — keep milestone / today / ruler positions
 * consistent across zoom levels and desktop/focus layouts.
 */

/** Civil YYYY-MM-DD → stable UTC day index (timezone-independent). */
export function daysFromEpochCivil(str) {
  const [y, m, day] = String(str).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, day) / 86400000);
}

/** Inclusive day span for a schedule range (min/max epoch days). */
export function ganttTotalDays(minDay, maxDay, { minSpan = 7 } = {}) {
  return Math.max(minSpan, maxDay - minDay + 1);
}

/** Left edge of a day as % of the track. */
export function ganttDayLeftPct(day, minDay, totalDays) {
  if (totalDays <= 0) return 0;
  return ((day - minDay) / totalDays) * 100;
}

/** Midpoint of a day as % of the track (today line, markers). */
export function ganttDayCenterPct(day, minDay, totalDays) {
  return ganttDayLeftPct(day + 0.5, minDay, totalDays);
}

/**
 * Inclusive bar placement: startDate through endDate both occupy a full day cell.
 */
export function ganttInclusiveBarPct(startDay, endDay, minDay, totalDays) {
  const left = ganttDayLeftPct(startDay, minDay, totalDays);
  const right = ganttDayLeftPct(endDay + 1, minDay, totalDays);
  return {
    left,
    width: Math.max(right - left, 0),
  };
}

/**
 * Chart widths: track is exactly totalDays * pxPerDay; lead sits beside it.
 * leadW must be 0 in focus mode and mobile (no label column / spacer).
 */
export function ganttChartWidths(totalDays, pxPerDay, leadW = 0) {
  const trackWidthPx = Math.max(1, totalDays * pxPerDay);
  return {
    trackWidthPx,
    chartMinWidthPx: Math.ceil(leadW + trackWidthPx),
  };
}

/**
 * Map a pointer X on the track to the civil day cell under it.
 */
export function pointerDayFromTrack(clientX, trackWidthPx, trackLeftPx, minDay, totalDays) {
  if (trackWidthPx <= 0 || totalDays <= 0) return minDay;
  const x = Math.max(0, Math.min(trackWidthPx - 0.001, clientX - trackLeftPx));
  const dayIndex = Math.floor((x / trackWidthPx) * totalDays);
  return minDay + dayIndex;
}

/**
 * Scroll offset that centres a track-percentage under the viewport,
 * accounting for the lead column that sits before the track.
 */
export function ganttScrollLeftForTrackPct(trackPct, {
  leadW = 0,
  trackWidthPx,
  clientWidth,
  scrollWidth,
}) {
  const trackX = leadW + (trackPct / 100) * trackWidthPx;
  const maxScroll = Math.max(0, scrollWidth - clientWidth);
  return Math.max(0, Math.min(maxScroll, trackX - clientWidth / 2));
}
