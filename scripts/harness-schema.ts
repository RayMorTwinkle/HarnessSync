import fs from "node:fs";
import { harnessJSONSchema } from "../src/shared/harness-manifest.ts";
fs.writeFileSync(
  new URL("../schema/harness.schema.json", import.meta.url),
  JSON.stringify(harnessJSONSchema(), null, 2) + "\n",
);
