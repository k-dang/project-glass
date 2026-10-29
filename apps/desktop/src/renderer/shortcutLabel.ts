const isMac = () => navigator.platform.startsWith("Mac")

export const shortcutLabel = (key: string) => (isMac() ? `⌘${key}` : `Ctrl+${key}`)

export const optionLabel = (key: string) => (isMac() ? `⌥${key}` : `Alt+${key}`)
