// Pacing a turn.
//
// Tabbit's free tier rejects by request rate (429 with code 492), and an agent
// spends one turn per tool round — the shape that trips it. These tests pin the
// pacing: turns are spaced, concurrent turns are serialised rather than fired
// together, and an aborted turn does not wedge the queue.

import assert from "node:assert/strict"
import test from "node:test"

// Read at module load, so it has to be set before the import below.
process.env.TABBIT_TURN_INTERVAL_MS = "120"

const { runTurn, credsOf } = await import("../src/api.mjs")

const realFetch = globalThis.fetch
let seen = []

function stubFetch() {
  seen = []
  globalThis.fetch = async (url) => {
    seen.push(Date.now())
    return new Response(JSON.stringify({ run_id: "r" }), { status: 200, headers: { "content-type": "application/json" } })
  }
}

const CREDS = credsOf({ access: "synthetic-token" })

test.afterEach(() => {
  globalThis.fetch = realFetch
})

test("two turns in a row are spaced by the interval", async () => {
  stubFetch()
  const started = Date.now()
  await runTurn(CREDS, "room-a", { content: "one", model: "m" })
  await runTurn(CREDS, "room-b", { content: "two", model: "m" })
  const gap = seen[1] - seen[0]
  assert.ok(gap >= 110, `turns went out ${gap}ms apart, expected at least the interval`)
  assert.ok(Date.now() - started >= 120)
})

test("turns issued together are serialised, not fired together", async () => {
  stubFetch()
  // The shape an agent produces: several rounds in flight at once.
  await Promise.all([
    runTurn(CREDS, "room-1", { content: "a", model: "m" }),
    runTurn(CREDS, "room-2", { content: "b", model: "m" }),
    runTurn(CREDS, "room-3", { content: "c", model: "m" }),
  ])
  assert.equal(seen.length, 3)
  const sorted = [...seen].sort((x, y) => x - y)
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    assert.ok(gap >= 100, `request ${i} came ${gap}ms after the previous one`)
  }
})

test("an aborted turn does not block the turns after it", async () => {
  stubFetch()
  const controller = new AbortController()
  const first = runTurn(CREDS, "room-x", { content: "x", model: "m", signal: controller.signal })
  controller.abort(new Error("cancelled"))
  await first.catch(() => {})
  // The queue must still move.
  await runTurn(CREDS, "room-y", { content: "y", model: "m" })
  assert.ok(seen.length >= 1, "a later turn never reached the network")
})
