import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Exclusive publication only; no lifecycle, provider, or record readers.
export function writeRuntimeInvocationArtifactExclusive(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.linkSync(temporary, file);
    fs.unlinkSync(temporary);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
