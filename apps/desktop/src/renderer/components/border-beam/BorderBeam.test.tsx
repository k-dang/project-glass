// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { BorderBeam } from "./BorderBeam"

afterEach(cleanup)

const mount = (active: boolean) => {
  const onDeactivate = vi.fn<() => void>()
  const beamOf = (on: boolean) => (
    <BorderBeam active={on} onDeactivate={onDeactivate} data-testid="beam">
      <textarea />
    </BorderBeam>
  )
  const view = render(beamOf(active))
  const beam = view.getByTestId("beam")
  const rerender = (next: boolean) => view.rerender(beamOf(next))
  const state = () =>
    beam.hasAttribute("data-fading")
      ? "fading"
      : beam.hasAttribute("data-active")
        ? "active"
        : "off"
  const fadeOutEnds = () => fireEvent.animationEnd(beam, { animationName: "beam-fade-out-x" })
  return { rerender, state, fadeOutEnds, onDeactivate }
}

it("fades out when deactivated and turns off when the fade ends", () => {
  const beam = mount(true)
  expect(beam.state()).toBe("active")

  beam.rerender(false)
  expect(beam.state()).toBe("fading")

  beam.fadeOutEnds()
  expect(beam.state()).toBe("off")
  expect(beam.onDeactivate).toHaveBeenCalledOnce()
})

it("turns back on after a fade when reactivated while fading", () => {
  const beam = mount(true)
  beam.rerender(false)
  beam.rerender(true)
  expect(beam.state()).toBe("fading")

  beam.fadeOutEnds()
  expect(beam.state()).toBe("active")
  expect(beam.onDeactivate).toHaveBeenCalledOnce()
})
