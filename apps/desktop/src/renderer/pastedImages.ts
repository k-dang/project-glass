import { ImageMediaType, type Image, type ToDoImageUpload } from "@glass/contracts"
import { Predicate, Schema } from "effect"
import { Base64 } from "effect/encoding"

const isImageMediaType = Schema.is(ImageMediaType)

const thumbnailEdge = 320

export const imageFiles = (data: DataTransfer | null) =>
  Array.from(data?.files ?? []).filter((file) => isImageMediaType(file.type))

export const readImages = async (files: Iterable<File>) => {
  const read = await Promise.all(
    Array.from(files, async (file): Promise<Image | null> => {
      const mediaType = file.type

      return isImageMediaType(mediaType)
        ? { mediaType, data: Base64.encode(new Uint8Array(await file.arrayBuffer())) }
        : null
    }),
  )

  return read.filter(Predicate.isNotNull)
}

const thumbnailOf = async (
  file: File,
  bytes: Uint8Array,
  mediaType: ImageMediaType,
): Promise<{ mediaType: ImageMediaType; data: string }> => {
  const original = { mediaType, data: Base64.encode(bytes) }
  const createBitmap = globalThis.createImageBitmap

  if (createBitmap === undefined) return original

  try {
    const bitmap = await createBitmap(file)
    const scale = Math.min(1, thumbnailEdge / Math.max(bitmap.width, bitmap.height, 1))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")

    if (context === null) {
      bitmap.close()

      return original
    }

    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const url = canvas.toDataURL("image/png")
    const data = url.slice(url.indexOf(",") + 1)

    return data === "" ? original : { mediaType: "image/png", data }
  } catch {
    return original
  }
}

export const readToDoImages = async (files: Iterable<File>): Promise<Array<ToDoImageUpload>> => {
  const accepted = Array.from(files).flatMap((file) => {
    const mediaType = file.type

    return isImageMediaType(mediaType) ? [{ file, mediaType }] : []
  })

  return Promise.all(
    accepted.map(async ({ file, mediaType }) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const thumbnail = await thumbnailOf(file, bytes, mediaType)

      return {
        mediaType,
        data: Base64.encode(bytes),
        thumbnail: thumbnail.data,
        thumbnailMediaType: thumbnail.mediaType,
      }
    }),
  )
}

export const imageSrc = (mediaType: string, data: string) => `data:${mediaType};base64,${data}`
