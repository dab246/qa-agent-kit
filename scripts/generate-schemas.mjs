// Regenerates schemas/*.json from the zod contracts (run `npm run schemas`).
import { mkdir, writeFile } from "node:fs/promises";
import { jsonSchemas } from "../dist/core/json-schemas.js";

const dir = new URL("../schemas/", import.meta.url);
await mkdir(dir, { recursive: true });
for (const [file, schema] of Object.entries(jsonSchemas())) {
  await writeFile(new URL(file, dir), `${JSON.stringify(schema, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(jsonSchemas()).length} schemas to schemas/`);
