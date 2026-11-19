import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function packageDirectory(directory: string) {
  let current = directory;

  while (!existsSync(join(current, "package.json"))) {
    const parent = dirname(current);

    if (parent === current) {
      return current;
    }

    current = parent;
  }

  return current;
}
