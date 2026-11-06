import test from "node:test";
import assert from "node:assert/strict";

import { groupQueue, upsertTask } from "../../src/js/queue-model.js";

test("upsertTask inserts once and updates in place", () => {
  const queue = [];
  const task = { id: "a", status: "queued", addedAt: 10 };
  const first = upsertTask(queue, task);
  assert.equal(first.inserted, true);
  assert.equal(queue.length, 1);

  const second = upsertTask(queue, { ...task, status: "downloading" });
  assert.equal(second.inserted, false);
  assert.equal(second.previous.status, "queued");
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "downloading");
});

test("queue is ordered newest first and never contains duplicate ids", () => {
  const queue = [];
  upsertTask(queue, { id: "old", status: "queued", addedAt: 10 });
  upsertTask(queue, { id: "new", status: "queued", addedAt: 20 });
  upsertTask(queue, { id: "new", status: "downloading", addedAt: 20 });
  assert.deepEqual(queue.map((task) => task.id), ["new", "old"]);
});

test("groupQueue separates active, completed and terminated tasks", () => {
  const queue = [
    { id: "cancelled", status: "cancelled", addedAt: 40 },
    { id: "done", status: "completed", completedAt: 30 },
    { id: "paused", status: "paused", addedAt: 5 },
    { id: "queued", status: "queued", queuedAt: 8 },
    { id: "active", status: "downloading", startedAt: 7 },
    { id: "failed", status: "failed", addedAt: 20 },
  ];
  const groups = groupQueue(queue);
  assert.deepEqual(groups.active.map((task) => task.id), ["active", "queued", "paused"]);
  assert.deepEqual(groups.completed.map((task) => task.id), ["done"]);
  assert.deepEqual(groups.terminated.map((task) => task.id), ["cancelled", "failed"]);
  assert.deepEqual(groups.counts, { active: 3, completed: 1, terminated: 2 });
});

test("completed and terminated groups use newest-first ordering", () => {
  const groups = groupQueue([
    { id: "done-old", status: "completed", completedAt: 1 },
    { id: "done-new", status: "completed", completedAt: 2 },
    { id: "failed-old", status: "failed", addedAt: 1 },
    { id: "failed-new", status: "failed", addedAt: 2 },
  ]);
  assert.deepEqual(groups.completed.map((task) => task.id), ["done-new", "done-old"]);
  assert.deepEqual(groups.terminated.map((task) => task.id), ["failed-new", "failed-old"]);
});

test("empty queue produces zero counts", () => {
  assert.deepEqual(groupQueue([]).counts, { active: 0, completed: 0, terminated: 0 });
});
