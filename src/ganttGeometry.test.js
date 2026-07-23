import {
  daysFromEpochCivil,
  ganttChartWidths,
  ganttDayCenterPct,
  ganttDayLeftPct,
  ganttInclusiveBarPct,
  ganttScrollLeftForTrackPct,
  ganttTotalDays,
  pointerDayFromTrack,
} from './ganttGeometry';
import { daysFromEpoch } from './scheduleEngine';

describe('ganttGeometry date positioning', () => {
  test('daysFromEpoch is timezone-independent civil date', () => {
    expect(daysFromEpochCivil('2026-07-21')).toBe(daysFromEpoch('2026-07-21'));
    expect(daysFromEpoch('2026-07-21') - daysFromEpoch('2026-07-20')).toBe(1);
  });

  test('totalDays includes both endpoints', () => {
    const minDay = daysFromEpoch('2026-07-01');
    const maxDay = daysFromEpoch('2026-07-10');
    expect(ganttTotalDays(minDay, maxDay)).toBe(10);
  });

  test('inclusive bars abut consecutive milestone phases', () => {
    const minDay = daysFromEpoch('2026-07-01');
    const maxDay = daysFromEpoch('2026-07-31');
    const totalDays = ganttTotalDays(minDay, maxDay);

    const strategyEnd = daysFromEpoch('2026-07-14');
    const designStart = daysFromEpoch('2026-07-15');

    const a = ganttInclusiveBarPct(
      daysFromEpoch('2026-07-01'),
      strategyEnd,
      minDay,
      totalDays,
    );
    const b = ganttInclusiveBarPct(
      designStart,
      daysFromEpoch('2026-07-28'),
      minDay,
      totalDays,
    );

    expect(a.left + a.width).toBeCloseTo(b.left, 10);
  });

  test('today centre and marker date share the same day cell', () => {
    const minDay = daysFromEpoch('2026-07-01');
    const totalDays = 31;
    const day = daysFromEpoch('2026-07-21');
    expect(ganttDayCenterPct(day, minDay, totalDays)).toBeCloseTo(
      ganttDayLeftPct(day + 0.5, minDay, totalDays),
      10,
    );
  });

  test('chart widths keep track = totalDays * pxPerDay at every zoom', () => {
    const zooms = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
    const totalDays = 100;
    zooms.forEach((pxPerDay) => {
      const focus = ganttChartWidths(totalDays, pxPerDay, 0);
      expect(focus.trackWidthPx).toBe(totalDays * pxPerDay);
      expect(focus.chartMinWidthPx).toBe(totalDays * pxPerDay);

      const main = ganttChartWidths(totalDays, pxPerDay, 124);
      expect(main.trackWidthPx).toBe(totalDays * pxPerDay);
      expect(main.chartMinWidthPx).toBe(124 + totalDays * pxPerDay);
    });
  });

  test('percentage left matches pixel left / trackWidth across zooms', () => {
    const minDay = daysFromEpoch('2026-07-01');
    const maxDay = daysFromEpoch('2026-09-30');
    const totalDays = ganttTotalDays(minDay, maxDay);
    const milestoneDay = daysFromEpoch('2026-08-15');
    const todayDay = daysFromEpoch('2026-07-21');

    [2, 5, 12, 24].forEach((pxPerDay) => {
      const { trackWidthPx } = ganttChartWidths(totalDays, pxPerDay, 0);
      const milestonePct = ganttDayLeftPct(milestoneDay, minDay, totalDays);
      const todayPct = ganttDayCenterPct(todayDay, minDay, totalDays);

      expect((milestonePct / 100) * trackWidthPx).toBeCloseTo(
        (milestoneDay - minDay) * pxPerDay,
        6,
      );
      expect((todayPct / 100) * trackWidthPx).toBeCloseTo(
        (todayDay - minDay + 0.5) * pxPerDay,
        6,
      );
    });
  });

  test('pointer day maps to the cell under the cursor', () => {
    const minDay = 1000;
    const totalDays = 10;
    const trackWidth = 200;
    // Middle of day index 3 → day 1003
    expect(pointerDayFromTrack(0, trackWidth, 0, minDay, totalDays)).toBe(minDay);
    expect(pointerDayFromTrack(70, trackWidth, 0, minDay, totalDays)).toBe(minDay + 3);
    expect(pointerDayFromTrack(199.9, trackWidth, 0, minDay, totalDays)).toBe(minDay + 9);
  });

  test('scroll-to-today accounts for lead column', () => {
    const trackPct = 50;
    const withoutLead = ganttScrollLeftForTrackPct(trackPct, {
      leadW: 0,
      trackWidthPx: 1000,
      clientWidth: 400,
      scrollWidth: 1000,
    });
    const withLead = ganttScrollLeftForTrackPct(trackPct, {
      leadW: 124,
      trackWidthPx: 1000,
      clientWidth: 400,
      scrollWidth: 1124,
    });
    expect(withLead - withoutLead).toBe(124);
  });

  /**
   * Regression: focused timeline used a 124px ruler spacer while phase tracks
   * were full-width. Same left% put "29 July" near the "20 Mon" tick.
   */
  test('focus mode (lead 0) keeps 29 July after 20 July on the shared track', () => {
    // Typical focused project window (~head/tail padding around Jul–Aug work).
    const minDay = daysFromEpoch('2026-06-23');
    const maxDay = daysFromEpoch('2026-09-30');
    const totalDays = ganttTotalDays(minDay, maxDay);
    const july20 = daysFromEpoch('2026-07-20');
    const july29 = daysFromEpoch('2026-07-29');

    [12, 16, 20, 24].forEach((pxPerDay) => {
      // Focus / mobile: no lead — marker track and ruler are the same width.
      const { trackWidthPx, chartMinWidthPx } = ganttChartWidths(totalDays, pxPerDay, 0);
      expect(chartMinWidthPx).toBe(trackWidthPx);

      const tick20Px = (ganttDayLeftPct(july20, minDay, totalDays) / 100) * trackWidthPx;
      const marker29Px = (ganttDayCenterPct(july29, minDay, totalDays) / 100) * trackWidthPx;

      expect(marker29Px).toBeGreaterThan(tick20Px);
      // ~9 days after Mon 20 (centre of Wed 29 ≈ 20 + 9.5)
      expect(marker29Px - tick20Px).toBeCloseTo(9.5 * pxPerDay, 6);

      // Ruler tick for 29 Jul Mon-week neighbour (27 Mon) must sit left of the marker.
      const july27 = daysFromEpoch('2026-07-27');
      const tick27Px = (ganttDayLeftPct(july27, minDay, totalDays) / 100) * trackWidthPx;
      expect(marker29Px).toBeGreaterThan(tick27Px);
      expect(marker29Px - tick27Px).toBeCloseTo(2.5 * pxPerDay, 6);
    });
  });
});
