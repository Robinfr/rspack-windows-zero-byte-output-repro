import path from "node:path";
import { fileURLToPath } from "node:url";

import { createInputFixture, parsePositiveInteger } from "./fixture.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const count = parsePositiveInteger("count", process.argv[2] ?? "13500");
const size = parsePositiveInteger("size", process.argv[3] ?? "8192", 64);
const fixtureRoot = path.join(projectRoot, ".fixture");

const { manifestPath, manifest } = createInputFixture({
  fixtureRoot,
  count,
  size,
});
console.log(
  JSON.stringify(
    {
      manifest: manifestPath,
      files: manifest.count,
      bytesPerFile: manifest.size,
      totalBytes: manifest.totalBytes,
    },
    null,
    2,
  ),
);
