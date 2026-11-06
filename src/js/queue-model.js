const ACTIVE_STATUSES = new Set([
  "queued",
  "probing",
  "downloading",
  "muxing",
  "extras",
  "paused",
]);

const ACTIVE_RANK = {
  downloading: 0,
  queued: 1,
  paused: 2,
};

export function upsertTask(queue, task) {
  if (!task?.id) return { previous: null, inserted: false };
  const index = queue.findIndex((item) => item.id === task.id);
  if (index >= 0) {
    const previous = queue[index];
    queue[index] = task;
    return { previous, inserted: false };
  }

  const addedAt = Number(task.addedAt) || 0;
  const insertAt = queue.findIndex((item) => (Number(item.addedAt) || 0) <= addedAt);
  queue.splice(insertAt < 0 ? queue.length : insertAt, 0, task);
  return { previous: null, inserted: true };
}

function activeRank(task) {
  return ACTIVE_RANK[task.status] ?? 3;
}

function sortActive(a, b) {
  const rank = activeRank(a) - activeRank(b);
  if (rank !== 0) return rank;
  if (a.status === "downloading") {
    return (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0);
  }
  if (a.status === "queued") {
    return (Number(a.queuedAt) || 0) - (Number(b.queuedAt) || 0);
  }
  return (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
}

export function groupQueue(queue) {
  const groups = { active: [], completed: [], terminated: [] };
  for (const task of queue) {
    if (task.status === "completed") groups.completed.push(task);
    else if (task.status === "cancelled" || task.status === "failed") groups.terminated.push(task);
    else if (ACTIVE_STATUSES.has(task.status) || !task.status) groups.active.push(task);
    else groups.active.push(task);
  }

  groups.active.sort(sortActive);
  groups.completed.sort((a, b) => (Number(b.completedAt) || 0) - (Number(a.completedAt) || 0));
  groups.terminated.sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));

  return {
    ...groups,
    counts: {
      active: groups.active.length,
      completed: groups.completed.length,
      terminated: groups.terminated.length,
    },
  };
}
