import { screen } from "@testing-library/react"
import type userEvent from "@testing-library/user-event"

export const openReview = async (user: ReturnType<typeof userEvent.setup>) => {
  if (screen.queryByRole("dialog", { name: "Finish your Review" }) === null) {
    await user.click(await screen.findByRole("button", { name: /^Finish Review/ }))
  }

  return screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Review summary" })
}
