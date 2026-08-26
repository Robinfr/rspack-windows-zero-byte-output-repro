import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function parsePositiveInteger(name, value, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${minimum}; received ${value}`,
    );
  }
  return parsed;
}

export function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

export function assetRelativePath(index, count) {
  const width = Math.max(6, String(count - 1).length);
  const group = String(index % 128).padStart(3, "0");
  return `group-${group}/asset-${String(index).padStart(width, "0")}.bin`;
}

export function assetBytes(index, size) {
  const content = Buffer.alloc(size, 1 + (index % 251));
  const marker = Buffer.from(`rspack-output-write-repro:${index}:${size}\n`);
  marker.copy(content, 0, 0, Math.min(marker.length, content.length));
  return content;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

export function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

export function listFiles(root, directory = root, files = []) {
  if (!fs.existsSync(directory)) return files;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      listFiles(root, absolutePath, files);
    } else {
      files.push(toPosixPath(path.relative(root, absolutePath)));
    }
  }

  return files.sort();
}

export function verifyTree(root, manifest) {
  const actualFiles = listFiles(root);
  const actualSet = new Set(actualFiles);
  const expectedSet = new Set(manifest.files.map((file) => file.path));
  const missing = [];
  const zeroByte = [];
  const wrongSize = [];
  const wrongHash = [];
  const readErrors = [];

  for (const expected of manifest.files) {
    if (!actualSet.has(expected.path)) {
      missing.push(expected.path);
      continue;
    }

    const filename = path.join(root, ...expected.path.split("/"));
    try {
      const stat = fs.statSync(filename);
      if (stat.size === 0) zeroByte.push(expected.path);
      if (stat.size !== expected.size) {
        wrongSize.push({
          path: expected.path,
          expected: expected.size,
          actual: stat.size,
        });
      }

      const actualHash = sha256(fs.readFileSync(filename));
      if (actualHash !== expected.sha256) {
        wrongHash.push({
          path: expected.path,
          expected: expected.sha256,
          actual: actualHash,
        });
      }
    } catch (error) {
      readErrors.push({
        path: expected.path,
        name: error.name,
        message: error.message,
        code: error.code,
      });
    }
  }

  const extra = actualFiles.filter((filename) => !expectedSet.has(filename));
  const ok =
    actualFiles.length === manifest.files.length &&
    missing.length === 0 &&
    extra.length === 0 &&
    zeroByte.length === 0 &&
    wrongSize.length === 0 &&
    wrongHash.length === 0 &&
    readErrors.length === 0;

  return {
    ok,
    expectedCount: manifest.files.length,
    actualCount: actualFiles.length,
    missing,
    extra,
    zeroByte,
    wrongSize,
    wrongHash,
    readErrors,
  };
}

export function createInputFixture({ fixtureRoot, count, size }) {
  const inputRoot = path.join(fixtureRoot, "input");
  const manifestPath = path.join(fixtureRoot, "manifest.json");

  if (fs.existsSync(manifestPath)) {
    const existing = readJson(manifestPath);
    if (existing.count === count && existing.size === size) {
      const verification = verifyTree(inputRoot, existing);
      if (verification.ok) {
        return { inputRoot, manifestPath, manifest: existing, verification };
      }
    }
  }

  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(inputRoot, { recursive: true });

  const files = [];
  for (let index = 0; index < count; index += 1) {
    const relativePath = assetRelativePath(index, count);
    const content = assetBytes(index, size);
    const filename = path.join(inputRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    files.push({
      path: relativePath,
      size: content.length,
      sha256: sha256(content),
    });
  }

  const manifest = {
    schemaVersion: 1,
    count,
    size,
    totalBytes: count * size,
    files,
  };
  writeJson(manifestPath, manifest);

  const verification = verifyTree(inputRoot, manifest);
  if (!verification.ok) {
    throw new Error(
      `Generated input fixture failed verification: ${manifestPath}`,
    );
  }

  return { inputRoot, manifestPath, manifest, verification };
}
