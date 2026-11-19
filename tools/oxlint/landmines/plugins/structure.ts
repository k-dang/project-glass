import { definePlugin } from "@oxlint/plugins";

import { packageExports } from "../rules/package-exports.ts";
import { testFileNames } from "../rules/test-file-names.ts";

const plugin = definePlugin({
  meta: { name: "landmines-structure" },
  rules: {
    "package-exports": packageExports,
    "test-file-names": testFileNames,
  },
});

// oxlint-disable-next-line import/no-default-export
export default plugin;
