// Vendored from shadcn-ui/ui packages/react/src/message-scroller (MIT) at
// 968d8cb9dc42ae5d52e8fd356cf84596ec832a26, so Glass can change how the
// transcript scrolls. Glass's change: useHoldScrollPosition, which keeps the
// viewport still while a disclosure in the transcript opens or closes. The rest
// only adapts it to Glass's toolchain: Base UI's mergeProps/useRender in place of
// upstream's copy, assignRef in place of composeRefs, `| undefined` on optional
// props for exactOptionalPropertyTypes, happy-dom tests, and the formatter's
// blank lines.
import {
  MessageScrollerButton as Button,
  MessageScrollerContent as Content,
  MessageScrollerItem as Item,
  MessageScrollerProvider as Provider,
  MessageScroller as Root,
  MessageScrollerViewport as Viewport,
} from "./components"

export const MessageScroller = {
  Provider,
  Root,
  Viewport,
  Content,
  Item,
  Button,
}

export {
  useHoldScrollPosition,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "./components"

export type {
  MessageScrollerDefaultScrollPosition,
  MessageScrollerScrollAlign,
  MessageScrollerScrollOptions,
  MessageScrollerScrollable,
  MessageScrollerVisibilityState,
} from "./types"
