import { describe, expect, it } from "vitest";
import {
  acknowledgedWrites,
  applyEdits,
  overlayAcknowledged,
  planFlush,
  settleFlushed,
  splitCellKey,
  type ServerCell,
} from "./edit-buffer";

const U1 = "user-1";
const U2 = "user-2";
const k = (user: string, date: string) => `${user}_${date}`;

const server = new Map<string, ServerCell>([
  [k(U1, "2026-09-28"), { id: "row-1", shiftId: "morning" }],
  [k(U1, "2026-09-29"), { id: "row-2", shiftId: "night" }],
]);

describe("splitCellKey", () => {
  it("splits on the last underscore, so ids may contain underscores", () => {
    expect(splitCellKey(k("user_with_underscores", "2026-09-28"))).toEqual({
      userId: "user_with_underscores",
      date: "2026-09-28",
    });
  });
});

describe("applyEdits", () => {
  it("returns a new map and leaves the input alone", () => {
    const before = new Map<string, string | null>();
    const after = applyEdits(before, [[k(U2, "2026-09-30"), "morning"]]);
    expect(before.size).toBe(0);
    expect(after.get(k(U2, "2026-09-30"))).toBe("morning");
  });
});

describe("planFlush", () => {
  it("turns real changes into one assign batch and one delete batch", () => {
    const edits = new Map<string, string | null>([
      [k(U2, "2026-09-30"), "morning"], // new
      [k(U1, "2026-09-28"), "night"], // reassign
      [k(U1, "2026-09-29"), null], // clear existing
    ]);
    const plan = planFlush(edits, server);
    expect(plan.assign).toEqual([
      { user_id: U2, date: "2026-09-30", shift_id: "morning" },
      { user_id: U1, date: "2026-09-28", shift_id: "night" },
    ]);
    expect(plan.deleteIds).toEqual(["row-2"]);
    expect(plan.flushed).toHaveLength(3);
  });

  it("drops no-ops but still reports them as flushed", () => {
    const edits = new Map<string, string | null>([
      [k(U1, "2026-09-28"), "morning"], // same as server
      [k(U2, "2026-09-28"), null], // clearing an empty cell
    ]);
    const plan = planFlush(edits, server);
    expect(plan.assign).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.flushed).toHaveLength(2);
  });

  it("re-assigns a row whose shift was deleted elsewhere", () => {
    const orphan = new Map<string, ServerCell>([
      [k(U1, "2026-09-28"), { id: "row-9", shiftId: null }],
    ]);
    const plan = planFlush(new Map([[k(U1, "2026-09-28"), "morning"]]), orphan);
    expect(plan.assign).toHaveLength(1);
  });
});

describe("acknowledgedWrites / overlayAcknowledged", () => {
  it("records created rows by cell key and the ids that were deleted", () => {
    const plan = planFlush(
      new Map<string, string | null>([
        [k(U2, "2026-09-30"), "morning"],
        [k(U1, "2026-09-29"), null],
      ]),
      server,
    );
    const ack = acknowledgedWrites(plan, [
      { id: "new-1", user_id: U2, date: "2026-09-30", shift_id: "morning" },
    ]);
    expect(ack).toEqual({
      assigned: [[k(U2, "2026-09-30"), { id: "new-1", shiftId: "morning" }]],
      deletedIds: ["row-2"],
    });
  });

  it("applies deletions and assignments on top of a snapshot without mutating it", () => {
    const next = overlayAcknowledged(server, [
      {
        assigned: [[k(U2, "2026-09-30"), { id: "new-1", shiftId: "morning" }]],
        deletedIds: ["row-2"],
      },
    ]);
    expect([...next.keys()]).toEqual([k(U1, "2026-09-28"), k(U2, "2026-09-30")]);
    expect(server.size).toBe(2);
  });

  it("applies several acknowledgements in order, so a later delete removes an earlier create", () => {
    const next = overlayAcknowledged(new Map(), [
      { assigned: [[k(U1, "2026-09-28"), { id: "new-1", shiftId: "A" }]], deletedIds: [] },
      { assigned: [], deletedIds: ["new-1"] },
    ]);
    expect(next.size).toBe(0);
  });
});

describe("settleFlushed", () => {
  it("drops flushed entries but keeps ones edited again since", () => {
    const flushed: Array<[string, string | null]> = [
      [k(U1, "2026-09-28"), "night"],
      [k(U2, "2026-09-28"), "morning"],
    ];
    const current = new Map<string, string | null>([
      [k(U1, "2026-09-28"), "night"], // unchanged -> drop
      [k(U2, "2026-09-28"), null], // edited again -> keep
      [k(U2, "2026-09-29"), "night"], // never flushed -> keep
    ]);
    const settled = settleFlushed(current, flushed);
    expect([...settled.keys()]).toEqual([k(U2, "2026-09-28"), k(U2, "2026-09-29")]);
  });
});
