import { definePlugin } from "@oxlint/plugins";

import { noFlakeMasking } from "../rules/no-flake-masking.ts";
import { noUnsignaledPoll } from "../rules/no-unsignaled-poll.ts";
import { strictMsw } from "../rules/strict-msw.ts";

const plugin = definePlugin({
  meta: { name: "landmines-testing" },
  rules: {
    "no-flake-masking": noFlakeMasking,
    "no-unsignaled-poll": noUnsignaledPoll,
    "strict-msw": strictMsw,
  },
});

// oxlint-disable-next-line import/no-default-export
export default plugin;
