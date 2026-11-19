const isMac = () => navigator.platform.startsWith("Mac")

export const shortcutLabel = (key: string) => (isMac() ? `⌘${key}` : `Ctrl+${key}`)
