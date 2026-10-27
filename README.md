# Ordered flush queue for a buffered edit grid

A small TypeScript module (no runtime dependencies) from a shift-planning
grid. Users edit cells quickly; edits collect in a local buffer and are sent to
the server in batches. The hard part is correctness when a second batch is
queued while the first is still in flight.

## Files

- `src/edit-buffer.ts` — pure functions: diff the buffer against the server
  state (`planFlush`), record what the server confirmed (`acknowledgedWrites`),
  replay confirmations over a snapshot (`overlayAcknowledged`), drop sent
  entries but keep ones edited again (`settleFlushed`).
- `src/flush-queue.ts` — `createFlushQueue`: sends run one at a time, and each
  plan is computed when its turn comes, from the intents captured at enqueue
  time and the server state *as acknowledged by then*.
- `src/*.test.ts` — unit tests, plus queue tests that control the interleaving
  of in-flight requests by hand.

## The bug this design prevents

1. User assigns shift A to a cell; send 1 starts.
2. Before it returns, the user clears the cell; send 2 is queued.
3. If send 2 were planned at enqueue time it would see an empty cell, produce
   no delete, and the clear would be lost while send 1 writes A.

Planning at run time against "snapshot + acknowledged writes" produces the
correct delete of the row send 1 created.

## Run

```bash
npm install
npx vitest run
npx tsc --noEmit   # optional typecheck
```

Tested with Node.js 24, Vitest 4.1.12 and TypeScript 5.9.3.
