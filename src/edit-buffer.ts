/**
 * Local edit buffer for a weekly shift grid. The grid shows `buffer ?? server`;
 * the buffer is sent in one batch after a short delay. A flush plan is a diff
 * against the server state: entries equal to the server (for example a change
 * undone before the flush) are never written, so they produce no
 * notification either.
 */

/** `${userId}_${date}` where date = yyyy-MM-dd. */
export type CellKey = string;
/** A shift id, or null for "no shift". */
export type EditValue = string | null;
export type ServerCell = { id: string; shiftId: string | null };
export type Edits = ReadonlyMap<CellKey, EditValue>;
export type ServerCells = ReadonlyMap<CellKey, ServerCell>;

export function splitCellKey(key: CellKey): { userId: string; date: string } {
  const at = key.lastIndexOf("_");
  return { userId: key.slice(0, at), date: key.slice(at + 1) };
}

export function applyEdits(
  edits: Edits,
  changes: Array<[CellKey, EditValue]>,
): Map<CellKey, EditValue> {
  const next = new Map(edits);
  for (const [key, value] of changes) next.set(key, value);
  return next;
}

export type FlushPlan = {
  assign: Array<{ user_id: string; date: string; shift_id: string }>;
  deleteIds: string[];
  /** Every entry this flush closes, including the ones that turned out to be no-ops. */
  flushed: Array<[CellKey, EditValue]>;
};

export function planFlush(edits: Edits, server: ServerCells): FlushPlan {
  const plan: FlushPlan = { assign: [], deleteIds: [], flushed: [] };
  for (const [key, value] of edits) {
    plan.flushed.push([key, value]);
    const existing = server.get(key);
    if (value === null) {
      if (existing) plan.deleteIds.push(existing.id);
      continue;
    }
    // A row whose shift was deleted elsewhere (shiftId null) is assigned again.
    if (existing?.shiftId === value) continue;
    const { userId, date } = splitCellKey(key);
    plan.assign.push({ user_id: userId, date, shift_id: value });
  }
  return plan;
}

/** The writes the server confirmed for one flush: created rows and deleted ids. */
export type Acknowledged = {
  assigned: Array<[CellKey, ServerCell]>;
  deletedIds: string[];
};

/** Records `plan` as it happened on the server. `created` are the rows the server returned. */
export function acknowledgedWrites(
  plan: FlushPlan,
  created: ReadonlyArray<{
    id: string;
    user_id: string;
    date: string;
    shift_id: string | null;
  }>,
): Acknowledged {
  return {
    assigned: created.map((row) => [
      `${row.user_id}_${row.date}`,
      { id: row.id, shiftId: row.shift_id },
    ]),
    deletedIds: plan.deleteIds,
  };
}

/** Applies later-confirmed writes, in order, on top of a server snapshot (the input is not mutated). */
export function overlayAcknowledged(
  server: ServerCells,
  acks: readonly Acknowledged[],
): Map<CellKey, ServerCell> {
  const next = new Map(server);
  for (const ack of acks) {
    const deleted = new Set(ack.deletedIds);
    for (const [key, cell] of next) {
      if (deleted.has(cell.id)) next.delete(key);
    }
    for (const [key, cell] of ack.assigned) next.set(key, cell);
  }
  return next;
}

/** Drops the flushed entries; entries edited again since the flush stay. */
export function settleFlushed(
  edits: Edits,
  flushed: Array<[CellKey, EditValue]>,
): Map<CellKey, EditValue> {
  const next = new Map(edits);
  for (const [key, value] of flushed) {
    if (next.has(key) && next.get(key) === value) next.delete(key);
  }
  return next;
}
