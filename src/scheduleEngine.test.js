import {
  addDays,
  cascadeAfterPhaseEndChange,
  cascadeAfterTaskChange,
  daysFromEpoch,
} from './scheduleEngine';

function makePhase(id, phaseKey, start, end, tasks = []) {
  return {
    id,
    phaseKey,
    title: phaseKey,
    scheduleMode: 'custom',
    startDate: start,
    endDate: end,
    tasks,
  };
}

describe('scheduleEngine cascade', () => {
  test('phase end +7 days slides later phases, tasks, and markers', () => {
    const phases = [
      makePhase('a', 'strategy', '2026-07-01', '2026-07-14'),
      makePhase('b', 'design', '2026-07-15', '2026-07-28', [
        { id: 't1', title: 'Concepts', startDate: '2026-07-15', endDate: '2026-07-21' },
      ]),
      makePhase('c', 'build', '2026-07-29', '2026-08-11'),
    ];
    const markers = [
      { id: 'm1', title: 'Review', date: '2026-07-14', phaseKey: 'strategy' },
      { id: 'm2', title: 'Handoff', date: '2026-07-28', phaseKey: 'design' },
      { id: 'm3', title: 'Late in strategy', date: '2026-07-20', phaseKey: 'strategy' },
    ];

    const { phases: nextPhases, markers: nextMarkers } = cascadeAfterPhaseEndChange(
      phases,
      markers,
      'a',
      '2026-07-14',
      '2026-07-21',
    );

    expect(nextPhases[0].endDate).toBe('2026-07-14'); // caller updates source phase
    expect(nextPhases[1].startDate).toBe('2026-07-22');
    expect(nextPhases[1].endDate).toBe('2026-08-04');
    expect(nextPhases[1].tasks[0].startDate).toBe('2026-07-22');
    expect(nextPhases[2].startDate).toBe('2026-08-05');
    expect(nextMarkers.find((m) => m.id === 'm2').date).toBe('2026-08-04');
    expect(nextMarkers.find((m) => m.id === 'm3').date).toBe('2026-07-27');
    expect(nextMarkers.find((m) => m.id === 'm1').date).toBe('2026-07-14');
  });

  test('task end +7 days pushes later tasks and later phases', () => {
    const phases = [
      makePhase('a', 'strategy', '2026-07-01', '2026-07-21', [
        { id: 't1', title: 'Research', startDate: '2026-07-01', endDate: '2026-07-07' },
        { id: 't2', title: 'Workshop', startDate: '2026-07-08', endDate: '2026-07-14' },
      ]),
      makePhase('b', 'design', '2026-07-22', '2026-08-04'),
    ];

    const updatedTask = {
      id: 't1',
      title: 'Research',
      startDate: '2026-07-01',
      endDate: '2026-07-14',
    };

    const { phases: nextPhases } = cascadeAfterTaskChange(
      phases,
      [],
      'a',
      't1',
      updatedTask,
      '2026-07-07',
    );

    expect(nextPhases[0].tasks[0].endDate).toBe('2026-07-14');
    expect(nextPhases[0].tasks[1].startDate).toBe('2026-07-15');
    expect(nextPhases[0].tasks[1].endDate).toBe('2026-07-21');
    expect(nextPhases[0].endDate).toBe('2026-07-28');
    expect(nextPhases[1].startDate).toBe('2026-07-29');
    expect(nextPhases[1].endDate).toBe('2026-08-11');
    expect(daysFromEpoch(nextPhases[1].startDate) - daysFromEpoch('2026-07-22')).toBe(7);
  });

  test('addDays helper stays calendar-stable', () => {
    expect(addDays('2026-07-07', 7)).toBe('2026-07-14');
  });
});
