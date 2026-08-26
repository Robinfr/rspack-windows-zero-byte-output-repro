import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createInputFixture,
  parsePositiveInteger,
  readJson,
  verifyTree,
  writeJson,
} from "./fixture.mjs";

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

function parseArguments(values) {
  const options = {
    mode: "default",
    attempts: 1,
    count: 13500,
    bytes: 8192,
    uvThreadpoolSize: Number(process.env.UV_THREADPOOL_SIZE || 4),
    keepSuccessful: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--keep-successful") {
      options.keepSuccessful = true;
      continue;
    }

    const value = values[++index];
    if (value === undefined) throw new Error(`Missing value for ${argument}`);
    switch (argument) {
      case "--mode":
        options.mode = value;
        break;
      case "--attempts":
        options.attempts = parsePositiveInteger("attempts", value);
        break;
      case "--count":
        options.count = parsePositiveInteger("count", value);
        break;
      case "--bytes":
        options.bytes = parsePositiveInteger("bytes", value, 64);
        break;
      case "--uv-threadpool-size":
        options.uvThreadpoolSize = parsePositiveInteger(
          "uv-threadpool-size",
          value,
        );
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!new Set(["default", "instrumented", "sync"]).has(options.mode)) {
    throw new Error(
      `mode must be default, instrumented, or sync; received ${options.mode}`,
    );
  }
  if (options.attempts > 5) {
    throw new Error(`attempts must not exceed 5; received ${options.attempts}`);
  }
  return options;
}

function packageVersion(packageName) {
  try {
    return readJson(require.resolve(`${packageName}/package.json`)).version;
  } catch {
    return null;
  }
}

function compactVerification(verification) {
  return {
    ok: verification.ok,
    expectedCount: verification.expectedCount,
    actualCount: verification.actualCount,
    missing: verification.missing.length,
    extra: verification.extra.length,
    zeroByte: verification.zeroByte.length,
    wrongSize: verification.wrongSize.length,
    wrongHash: verification.wrongHash.length,
    readErrors: verification.readErrors.length,
  };
}

const options = parseArguments(process.argv.slice(2));
const fixtureRoot = path.join(projectRoot, ".fixture");
const runsRoot = path.join(projectRoot, "runs");
const sessionId = [
  new Date().toISOString().replace(/\D/g, "").slice(0, 14),
  process.pid,
  options.mode,
  `${options.count}x${options.bytes}`,
].join("-");
const sessionRoot = path.join(runsRoot, sessionId);
fs.mkdirSync(sessionRoot, { recursive: true });

const fixture = createInputFixture({
  fixtureRoot,
  count: options.count,
  size: options.bytes,
});
if (!fixture.verification.ok) throw new Error("Input fixture is not valid");

const cliPackagePath = require.resolve("@rspack/cli/package.json");
const cliPath = path.join(path.dirname(cliPackagePath), "bin", "rspack.js");
const configPath = path.join(projectRoot, "rspack.config.mjs");
const environment = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  osRelease: os.release(),
  osVersion: os.version(),
  processors: os.availableParallelism?.() ?? os.cpus().length,
  rspackCore: packageVersion("@rspack/core"),
  rspackCli: packageVersion("@rspack/cli"),
  rspackBinding: packageVersion("@rspack/binding"),
  nativeBinding:
    process.platform === "win32"
      ? packageVersion(`@rspack/binding-win32-${process.arch}-msvc`)
      : null,
};

const attemptSummaries = [];
let reproductionFound = false;
let unsuccessfulBuildFound = false;

for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
  const attemptName = `attempt-${String(attempt).padStart(3, "0")}`;
  const attemptRoot = path.join(sessionRoot, attemptName);
  const outputRoot = path.join(attemptRoot, "dist");
  const telemetryPath = path.join(attemptRoot, "telemetry.json");
  fs.mkdirSync(attemptRoot, { recursive: true });

  const child = spawnSync(
    process.execPath,
    [cliPath, "build", "--config", configPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NO_COLOR: "1",
        UV_THREADPOOL_SIZE: String(options.uvThreadpoolSize),
        RSPACK_REPRO_INPUT: fixture.inputRoot,
        RSPACK_REPRO_OUTPUT: outputRoot,
        RSPACK_REPRO_TELEMETRY: telemetryPath,
        RSPACK_REPRO_FS_MODE: options.mode,
      },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  fs.writeFileSync(
    path.join(attemptRoot, "cli.stdout.log"),
    child.stdout ?? "",
  );
  fs.writeFileSync(
    path.join(attemptRoot, "cli.stderr.log"),
    child.stderr ?? "",
  );

  const verification = verifyTree(outputRoot, fixture.manifest);
  const telemetry = fs.existsSync(telemetryPath)
    ? readJson(telemetryPath)
    : null;
  const cliGreen = child.status === 0 && !child.error;
  const greenCorruptOutput = cliGreen && !verification.ok;
  const classification = greenCorruptOutput
    ? "green-corrupt-output"
    : !cliGreen
      ? "compiler-failed"
      : verification.ok
        ? "green-complete-output"
        : "incomplete-output";

  const result = {
    schemaVersion: 1,
    sessionId,
    attempt,
    classification,
    parameters: options,
    environment,
    input: {
      manifest: fixture.manifestPath,
      count: fixture.manifest.count,
      bytesPerFile: fixture.manifest.size,
      totalBytes: fixture.manifest.totalBytes,
      verified: fixture.verification.ok,
    },
    cli: {
      green: cliGreen,
      exitCode: child.status,
      signal: child.signal,
      spawnError: child.error
        ? {
            name: child.error.name,
            message: child.error.message,
            code: child.error.code,
          }
        : null,
    },
    output: verification,
    telemetry,
    signatures: {
      greenCorruptOutput,
      greenZeroByteOutput:
        greenCorruptOutput &&
        verification.zeroByte.length > 0 &&
        (telemetry?.zeroLengthWriteRequests ?? 0) === 0,
      asyncFanoutObserved:
        options.mode === "instrumented" && (telemetry?.maxInFlight ?? 0) > 64,
      synchronousControl:
        options.mode === "sync" &&
        cliGreen &&
        verification.ok &&
        telemetry?.maxInFlight === 1,
    },
  };
  writeJson(path.join(attemptRoot, "result.json"), result);

  const summary = {
    attempt,
    classification,
    cliExitCode: child.status,
    output: compactVerification(verification),
    writeErrors: telemetry?.writeErrors ?? null,
    maxInFlight: telemetry?.maxInFlight ?? null,
  };
  attemptSummaries.push(summary);
  console.log(JSON.stringify(summary, null, 2));

  reproductionFound ||= greenCorruptOutput;
  unsuccessfulBuildFound ||= !cliGreen;

  if (classification === "green-complete-output" && !options.keepSuccessful) {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
  if (greenCorruptOutput || !cliGreen) break;
}

const summary = {
  schemaVersion: 1,
  sessionId,
  parameters: options,
  environment,
  inputVerified: fixture.verification.ok,
  reproductionFound,
  unsuccessfulBuildFound,
  attemptsRun: attemptSummaries.length,
  attempts: attemptSummaries,
};
writeJson(path.join(sessionRoot, "summary.json"), summary);

console.log(
  JSON.stringify(
    {
      session: sessionRoot,
      reproductionFound,
      unsuccessfulBuildFound,
      attemptsRun: attemptSummaries.length,
    },
    null,
    2,
  ),
);

process.exitCode = attemptSummaries.every(
  (attempt) => attempt.classification === "green-complete-output",
)
  ? 0
  : 1;
