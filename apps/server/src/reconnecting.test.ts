import { assert, it } from "@effect/vitest"
import { Duration } from "effect"
import { missedConnection, type Recovery, recoveryReach } from "./reconnecting"

it("reports loss on the fourth miss, after three quick retries", () => {
  let state: Recovery<string> = { phase: "connecting", reach: "connecting" }

  for (let miss = 1; miss <= 3; miss += 1) {
    state = missedConnection(state)
    assert.equal(state.phase, "retrying")
    assert.equal(recoveryReach(state), "connecting")

    if (state.phase === "retrying") {
      assert.equal(state.misses, miss)
      assert.equal(Duration.toMillis(state.delay), 500)
    }
  }

  state = missedConnection(state)
  assert.equal(state.phase, "unreachable")
  assert.equal(recoveryReach(state), "unreachable")

  if (state.phase === "unreachable") {
    assert.equal(state.misses, 4)
    assert.equal(Duration.toSeconds(state.delay), 5)
  }
})

it("backs off to five-minute retries and abandons recovery after its retry budget", () => {
  let state: Recovery<string> = { phase: "connecting", reach: "connecting" }
  const delays: Array<number> = []

  for (let miss = 0; miss < 20 && state.phase !== "abandoned"; miss += 1) {
    state = missedConnection(state)

    if (state.phase === "retrying" || state.phase === "unreachable")
      delays.push(Duration.toMillis(state.delay))
  }

  assert.deepStrictEqual(
    delays,
    [500, 500, 500, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000],
  )
  assert.equal(state.phase, "abandoned")
  assert.equal(recoveryReach(state), "unreachable")
  assert.strictEqual(missedConnection(state), state)
})

it("a successful connection starts a fresh retry budget, keeping reach until the fourth miss", () => {
  let state: Recovery<string> = { phase: "connecting", reach: "connecting" }

  for (let miss = 0; miss < 9; miss += 1) state = missedConnection(state)
  assert.equal(state.phase, "unreachable")

  state = { phase: "reachable", client: "host" }

  for (let miss = 1; miss <= 3; miss += 1) {
    state = missedConnection(state)
    assert.equal(state.phase, "retrying")
    assert.equal(recoveryReach(state), "reachable")

    if (state.phase === "retrying") {
      assert.equal(state.misses, miss)
      assert.equal(Duration.toMillis(state.delay), 500)
    }
  }

  state = missedConnection(state)
  assert.equal(state.phase, "unreachable")

  if (state.phase === "unreachable") {
    assert.equal(state.misses, 4)
    assert.equal(Duration.toSeconds(state.lostFor), 5)
  }
})
