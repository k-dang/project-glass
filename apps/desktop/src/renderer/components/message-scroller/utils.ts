import * as React from "react"

function useLatest<T>(value: T) {
  const ref = React.useRef(value)

  ref.current = value

  return ref
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T) {
  if (typeof ref === "function") {
    ref(value)
  } else if (ref) {
    ref.current = value
  }
}

export { assignRef, useLatest }
