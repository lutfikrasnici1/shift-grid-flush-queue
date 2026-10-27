import {
  overlayAcknowledged,
  planFlush,
  settleFlushed,
  type Acknowledged,
  type CellKey,
  type EditValue,
  type Edits,
  type FlushPlan,
  type ServerCells,
} from "./edit-buffer";

type FlushQueueDeps<Ctx> = {
  getEdits: () => Edits;
  commitEdits: (next: Map<CellKey, EditValue>) => void;
  getServer: () => ServerCells;
  /** Reflects confirmed writes in the server view until the UI's own data catches up. */
  setServer: (next: ServerCells) => void;
  /** Writes the plan to the server and rejects on failure. Resolves with the writes the server confirmed. */
  persist: (plan: FlushPlan, ctx: Ctx) => Promise<Acknowledged>;
  onSaved?: (ack: Acknowledged, ctx: Ctx) => void;
  onError?: (error: unknown, ctx: Ctx) => void;
  /** +1 when a send starts, -1 when it ends. */
  onBusyChange?: (delta: 1 | -1) => void;
};

/**
 * Send queue for the edit buffer. Sends run one at a time. Each send's plan is
 * built from the edit intents captured when it was queued and from the server
 * state as it is **when the send runs**.
 *
 * Why: if the plan were computed at enqueue time, a "clear" queued behind an
 * in-flight "assign A" would still see the cell as empty, produce nothing, and
 * the intent would be dropped while the first send goes on to write A.
 *
 * Server state = the view at enqueue time + the writes acknowledged since.
 * Deliberately not "whatever the grid shows right now": the user may have
 * switched weeks, the old week's rows are gone from the view, and deletes
 * would be dropped silently.
 */
export function createFlushQueue<Ctx>(deps: FlushQueueDeps<Ctx>) {
  let chain: Promise<void> = Promise.resolve();
  const acks: Acknowledged[] = [];

  return {
    flush(ctx: Ctx): void {
      const intents = new Map(deps.getEdits());
      if (intents.size === 0) return;
      const baseServer = deps.getServer();
      const acksBefore = acks.length;

      const run = async () => {
        const plan = planFlush(
          intents,
          overlayAcknowledged(baseServer, acks.slice(acksBefore)),
        );
        const settle = () =>
          deps.commitEdits(settleFlushed(deps.getEdits(), plan.flushed));

        if (plan.assign.length === 0 && plan.deleteIds.length === 0) {
          settle();
          return;
        }

        deps.onBusyChange?.(1);
        try {
          const ack = await deps.persist(plan, ctx);
          acks.push(ack);
          deps.setServer(overlayAcknowledged(deps.getServer(), [ack]));
          deps.onSaved?.(ack, ctx);
        } catch (error) {
          // The failed send's cells fall back to the server state.
          deps.onError?.(error, ctx);
        } finally {
          settle();
          deps.onBusyChange?.(-1);
        }
      };

      chain = chain.then(run, run);
    },

    /** Resolves when every queued send has finished. */
    idle: () => chain,
  };
}
