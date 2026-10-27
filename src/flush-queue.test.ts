import { describe, expect, it } from "vitest";
import {
  acknowledgedWrites,
  applyEdits,
  type Acknowledged,
  type CellKey,
  type EditValue,
  type FlushPlan,
  type ServerCell,
} from "./edit-buffer";
import { createFlushQueue } from "./flush-queue";

const U1 = "user-1";
const k = (user: string, date: string) => `${user}_${date}`;
const X = k(U1, "2026-09-28");
const Y = k(U1, "2026-09-29");

type Call = {
  plan: FlushPlan;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** An in-memory stand-in for the shifts table plus the React-side state the
 *  hook feeds the queue. Every persist() stays pending until the test resolves
 *  it, so the tests control the interleaving. */
function harness(initial: Array<[CellKey, ServerCell]> = []) {
  let edits: ReadonlyMap<CellKey, EditValue> = new Map();
  let server: ReadonlyMap<CellKey, ServerCell> = new Map(initial);
  const backend = new Map<CellKey, ServerCell>(initial);
  const calls: Call[] = [];
  const errors: unknown[] = [];
  let nextId = 1;

  const queue = createFlushQueue<{ week: string }>({
    getEdits: () => edits,
    commitEdits: (next) => {
      edits = next;
    },
    getServer: () => server,
    setServer: (next) => {
      server = next;
    },
    persist: (plan) =>
      new Promise<Acknowledged>((resolve, reject) => {
        calls.push({
          plan,
          reject,
          resolve: () => {
            const created = plan.assign.map((row) => {
              const cell = { id: `new-${nextId++}`, shiftId: row.shift_id };
              backend.set(`${row.user_id}_${row.date}`, cell);
              return {
                id: cell.id,
                user_id: row.user_id,
                date: row.date,
                shift_id: row.shift_id,
              };
            });
            for (const id of plan.deleteIds) {
              for (const [key, cell] of backend) {
                if (cell.id === id) backend.delete(key);
              }
            }
            resolve(acknowledgedWrites(plan, created));
          },
        });
      }),
    onError: (error) => {
      errors.push(error);
    },
  });

  return {
    queue,
    calls,
    errors,
    backend,
    edits: () => edits,
    server: () => server,
    edit(key: CellKey, value: EditValue) {
      edits = applyEdits(edits, [[key, value]]);
    },
    /** The grid's data prop changing underneath the hook (e.g. week switch). */
    replaceServer(next: Array<[CellKey, ServerCell]>) {
      server = new Map(next);
    },
    tick: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

describe("createFlushQueue", () => {
  it("does not lose a clear that is queued behind the assignment it undoes", async () => {
    const h = harness();
    h.edit(X, "A");
    h.queue.flush({ week: "w1" });
    await h.tick();
    expect(h.calls).toHaveLength(1);

    // While the first request is still in flight the user clears the cell.
    h.edit(X, null);
    h.queue.flush({ week: "w1" });
    await h.tick();
    expect(h.calls).toHaveLength(1);

    h.calls[0].resolve();
    await h.tick();

    // The second flush must be planned against what the first one wrote.
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].plan.deleteIds).toEqual(["new-1"]);
    h.calls[1].resolve();
    await h.queue.idle();

    expect(h.backend.size).toBe(0);
    expect(h.edits().size).toBe(0);
  });

  it("A -> B -> A before the first response sends nothing extra", async () => {
    const h = harness();
    h.edit(X, "A");
    h.queue.flush({ week: "w1" });
    await h.tick();

    h.edit(X, "B");
    h.edit(X, "A");
    h.queue.flush({ week: "w1" });
    await h.tick();

    h.calls[0].resolve();
    await h.queue.idle();

    expect(h.calls).toHaveLength(1);
    expect(h.backend.get(X)?.shiftId).toBe("A");
    expect(h.edits().size).toBe(0);
  });

  it("keeps the last intent when A is replaced by B while A is in flight", async () => {
    const h = harness();
    h.edit(X, "A");
    h.queue.flush({ week: "w1" });
    await h.tick();

    h.edit(X, "B");
    h.queue.flush({ week: "w1" });
    await h.tick();

    h.calls[0].resolve();
    await h.tick();
    h.calls[1].resolve();
    await h.queue.idle();

    expect(h.backend.get(X)?.shiftId).toBe("B");
    expect(h.edits().size).toBe(0);
  });

  it("retries the same intent after a failed flush and reports the error once", async () => {
    const h = harness();
    h.edit(X, "A");
    h.queue.flush({ week: "w1" });
    await h.tick();
    h.queue.flush({ week: "w1" }); // user keeps working; a second flush queues
    await h.tick();

    h.calls[0].reject(new Error("network"));
    await h.tick();

    expect(h.errors).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].plan.assign).toEqual([
      { user_id: U1, date: "2026-09-28", shift_id: "A" },
    ]);
    h.calls[1].resolve();
    await h.queue.idle();

    expect(h.backend.get(X)?.shiftId).toBe("A");
  });

  it("a failed flush does not touch a newer, different edit", async () => {
    const h = harness();
    h.edit(X, "A");
    h.queue.flush({ week: "w1" });
    await h.tick();

    h.edit(X, "B"); // edited again after the flush started
    h.calls[0].reject(new Error("network"));
    await h.queue.idle();

    expect(h.edits().get(X)).toBe("B");
  });

  it("plans a queued delete against the week it was flushed for, not the grid's current week", async () => {
    const h = harness([[X, { id: "r1", shiftId: "morning" }]]);

    h.edit(Y, "A");
    h.queue.flush({ week: "w1" });
    await h.tick(); // first request in flight

    h.edit(X, null);
    h.queue.flush({ week: "w1" }); // queued; the user is about to change week
    h.replaceServer([]); // grid now shows another week: no row for X

    h.calls[0].resolve();
    await h.tick();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].plan.deleteIds).toEqual(["r1"]);
  });

  it("settles a no-op without calling persist", async () => {
    const h = harness([[X, { id: "r1", shiftId: "morning" }]]);
    h.edit(X, "morning"); // same as the server
    h.queue.flush({ week: "w1" });
    await h.queue.idle();

    expect(h.calls).toHaveLength(0);
    expect(h.edits().size).toBe(0);
  });

  it("does nothing when there are no edits", async () => {
    const h = harness();
    h.queue.flush({ week: "w1" });
    await h.queue.idle();
    expect(h.calls).toHaveLength(0);
  });
});
