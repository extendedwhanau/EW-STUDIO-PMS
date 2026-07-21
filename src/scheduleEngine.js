/** Cascading schedule helpers — used when project.linkedSchedule is on. */

function parseISODateLocal(str) {
  const [y, m, day] = str.split('-').map(Number);
  return new Date(y, m - 1, day, 12, 0, 0, 0);
}

/** Civil YYYY-MM-DD → stable UTC day index (timezone-independent). */
export function daysFromEpoch(str) {
  const [y, m, day] = String(str).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, day) / 86400000);
}

export function addDays(str, n) {
  const d = parseISODateLocal(str);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function shiftTaskDates(tasks, deltaDays) {
  if (!deltaDays) return tasks || [];
  return (tasks || []).map((task) => {
    if (!task?.startDate && !task?.endDate) return task;
    const startDate = task.startDate ? addDays(task.startDate, deltaDays) : '';
    const endDate = task.endDate
      ? addDays(task.endDate, deltaDays)
      : startDate;
    return { ...task, startDate, endDate };
  });
}

function shiftPhaseSpan(phase, deltaDays) {
  if (!deltaDays) return phase;
  return {
    ...phase,
    startDate: phase.startDate ? addDays(phase.startDate, deltaDays) : phase.startDate,
    endDate: phase.endDate ? addDays(phase.endDate, deltaDays) : phase.endDate,
    tasks: shiftTaskDates(phase.tasks, deltaDays),
  };
}

function shiftMarkers(
  markers,
  deltaDays,
  {
    laterPhaseKeys = new Set(),
    currentPhaseKey = '',
    afterDate = '',
  } = {},
) {
  if (!deltaDays) return markers || [];
  return (markers || []).map((marker) => {
    if (!marker?.date) return marker;
    if (laterPhaseKeys.has(marker.phaseKey)) {
      return { ...marker, date: addDays(marker.date, deltaDays) };
    }
    if (currentPhaseKey && marker.phaseKey === currentPhaseKey && afterDate && marker.date > afterDate) {
      return { ...marker, date: addDays(marker.date, deltaDays) };
    }
    if (!marker.phaseKey && afterDate && marker.date > afterDate) {
      return { ...marker, date: addDays(marker.date, deltaDays) };
    }
    return marker;
  });
}

/**
 * After a phase end changes, slide later phases (and their tasks/markers) by the same delta.
 * Gaps between phases are preserved.
 */
export function cascadeAfterPhaseEndChange(phases, markers, phaseId, oldEnd, newEnd) {
  const list = phases || [];
  if (!oldEnd || !newEnd) {
    return { phases: list, markers: markers || [] };
  }
  const deltaDays = daysFromEpoch(newEnd) - daysFromEpoch(oldEnd);
  if (!deltaDays) {
    return { phases: list, markers: markers || [] };
  }

  const index = list.findIndex((phase) => phase.id === phaseId);
  if (index < 0) {
    return { phases: list, markers: markers || [] };
  }

  const currentPhaseKey = list[index]?.phaseKey || '';
  const laterPhaseKeys = new Set(
    list.slice(index + 1).map((phase) => phase.phaseKey).filter(Boolean),
  );

  const nextPhases = list.map((phase, i) => (
    i > index ? shiftPhaseSpan(phase, deltaDays) : phase
  ));

  const nextMarkers = shiftMarkers(markers, deltaDays, {
    laterPhaseKeys,
    currentPhaseKey,
    afterDate: oldEnd,
  });

  return { phases: nextPhases, markers: nextMarkers };
}

/**
 * Apply an updated task, push later tasks in the same phase, grow the phase end if needed,
 * then cascade later phases by how much the phase end moved.
 */
export function cascadeAfterTaskChange(phases, markers, phaseId, taskId, updatedTask, oldTaskEnd) {
  const list = (phases || []).map((phase) => ({ ...phase, tasks: [...(phase.tasks || [])] }));
  const index = list.findIndex((phase) => phase.id === phaseId);
  if (index < 0) {
    return { phases: phases || [], markers: markers || [] };
  }

  const phase = list[index];
  const taskIndex = (phase.tasks || []).findIndex((task) => task.id === taskId);
  if (taskIndex < 0) {
    return { phases: list, markers: markers || [] };
  }

  const previousTask = phase.tasks[taskIndex];
  const prevEnd = oldTaskEnd || previousTask.endDate || previousTask.startDate || '';
  const nextEnd = updatedTask.endDate || updatedTask.startDate || '';
  const oldPhaseEnd = phase.endDate || '';

  phase.tasks[taskIndex] = updatedTask;

  if (prevEnd && nextEnd) {
    const deltaDays = daysFromEpoch(nextEnd) - daysFromEpoch(prevEnd);
    if (deltaDays) {
      phase.tasks = phase.tasks.map((task, i) => {
        if (i === taskIndex) return task;
        if (i < taskIndex) return task;
        // Later in list, or starting on/after the previous task end
        if (i > taskIndex) return shiftTaskDates([task], deltaDays)[0];
        return task;
      });

      if (oldPhaseEnd) {
        phase.endDate = addDays(oldPhaseEnd, deltaDays);
        if (phase.scheduleMode === 'custom') {
          phase.durationWeeks = null;
        }
      } else if (nextEnd) {
        phase.endDate = nextEnd;
      }
    }
  } else if (nextEnd && oldPhaseEnd && nextEnd > oldPhaseEnd) {
    phase.endDate = nextEnd;
  }

  list[index] = phase;

  const newPhaseEnd = phase.endDate || '';
  if (oldPhaseEnd && newPhaseEnd && newPhaseEnd !== oldPhaseEnd) {
    return cascadeAfterPhaseEndChange(list, markers, phaseId, oldPhaseEnd, newPhaseEnd);
  }

  return { phases: list, markers: markers || [] };
}

export function latestScheduleEnd(phases) {
  let max = '';
  (phases || []).forEach((phase) => {
    if (phase.endDate && (!max || phase.endDate > max)) max = phase.endDate;
    (phase.tasks || []).forEach((task) => {
      if (task.endDate && (!max || task.endDate > max)) max = task.endDate;
      if (task.startDate && (!max || task.startDate > max)) max = task.startDate;
    });
  });
  return max;
}
