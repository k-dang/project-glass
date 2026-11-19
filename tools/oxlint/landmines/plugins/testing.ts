import { definePlugin } from "@oxlint/plugins";

import { noFlakeMasking } from "../rules/no-flake-masking.ts";

const plugin = definePlugin({
  meta: { name: "landmines-testing" },
  rules: {
    "no-flake-masking": noFlakeMasking,
  },
});

// oxlint-disable-next-line import/no-default-export
export default plugin;
