import { afterEach, expect, it, vi } from "vite-plus/test"
import { readToDoImages } from "./pastedImages"

afterEach(() => {
  vi.unstubAllGlobals()
})

it("starts a to-do image's thumbnail while its bytes are still being read", async () => {
  const thumbnailStarted = Promise.withResolvers<void>()

  vi.stubGlobal("createImageBitmap", () => {
    thumbnailStarted.resolve()

    return Promise.reject(new Error("No decoder"))
  })

  const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })
  file.arrayBuffer = () => thumbnailStarted.promise.then(() => new Uint8Array([1, 2, 3]).buffer)

  const { images, rejected } = await readToDoImages([file])

  expect(rejected).toEqual([])
  expect(images).toEqual([
    {
      mediaType: "image/png",
      data: "AQID",
      thumbnail: expect.any(String),
      thumbnailMediaType: "image/png",
    },
  ])
})
