import { fork } from "node:child_process";
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
const compilerPath = path.join(scriptDirectory, "compile.mjs");

function parseArguments(values) {
  const options = {
    attempts: 1,
    count: 13500,
    bytes: 8192,
    uvThreadpoolSize: Number(process.env.UV_THREADPOOL_SIZE || 4),
    handleHeadroom: 64,
    handleAllocationCap: 65536,
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
      case "--handle-headroom":
        options.handleHeadroom = parsePositiveInteger("handle-headroom", value);
        break;
      case "--handle-allocation-cap":
        options.handleAllocationCap = parsePositiveInteger(
          "handle-allocation-cap",
          value,
        );
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.handleHeadroom >= options.handleAllocationCap) {
    throw new Error(
      "handle-headroom must be smaller than handle-allocation-cap",
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
  if (!verification) return null;
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

function containsEmfile(value) {
  return /\b(?:EMFILE|ENFILE)\b/.test(JSON.stringify(value));
}

function errorInfo(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
  };
}

function runCompiler({ environment, verify }) {
  return new Promise((resolve) => {
    const child = fork(compilerPath, [], {
      cwd: projectRoot,
      env: environment,
      silent: true,
    });
    let stdout = "";
    let stderr = "";
    let build = null;
    let verification = null;
    let verificationError = null;
    let spawnError = null;
    let ipcError = null;
    let buildTimedOut = false;
    let shutdownTimedOut = false;
    let buildTimer;
    let shutdownTimer;
    let forceKillTimer;
    let settled = false;
    const lifecycle = {
      buildMessageReceivedAt: null,
      verificationCompletedAt: null,
      releaseRequestedAt: null,
      pressureReleasedAt: null,
      childClosedAt: null,
      verificationFinishedBeforeRelease: false,
    };
    let pressureReleaseCloseErrors = null;

    const captureVerification = (beforeRelease) => {
      try {
        verification = verify();
      } catch (error) {
        verificationError = errorInfo(error);
      } finally {
        lifecycle.verificationCompletedAt = new Date().toISOString();
        lifecycle.verificationFinishedBeforeRelease =
          beforeRelease && verification !== null;
      }
    };

    const terminate = () => {
      if (settled) return;
      child.kill();
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    buildTimer = setTimeout(() => {
      buildTimedOut = true;
      terminate();
    }, 180000);

    child.on("message", (message) => {
      if (message?.type === "pressure-released") {
        lifecycle.pressureReleasedAt = new Date().toISOString();
        pressureReleaseCloseErrors = message.closeErrors;
        return;
      }
      if (message?.type !== "build-complete" || build) return;
      clearTimeout(buildTimer);
      build = message;
      lifecycle.buildMessageReceivedAt = new Date().toISOString();
      captureVerification(true);
      lifecycle.releaseRequestedAt = new Date().toISOString();

      if (child.connected) {
        try {
          child.send({ type: "release" }, (error) => {
            if (!error) return;
            ipcError = errorInfo(error);
            terminate();
          });
        } catch (error) {
          ipcError = errorInfo(error);
          terminate();
        }
      } else {
        ipcError = {
          name: "Error",
          message: "Compiler IPC channel closed before pressure release",
          code: "ERR_IPC_CHANNEL_CLOSED",
        };
        terminate();
      }

      shutdownTimer = setTimeout(() => {
        shutdownTimedOut = true;
        terminate();
      }, 30000);
    });
    child.on("error", (error) => {
      spawnError = errorInfo(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(buildTimer);
      clearTimeout(shutdownTimer);
      clearTimeout(forceKillTimer);
      lifecycle.childClosedAt = new Date().toISOString();
      if (!verification && !verificationError) captureVerification(false);
      resolve({
        build,
        verification,
        verificationError,
        exitCode: code,
        signal,
        spawnError,
        ipcError,
        buildTimedOut,
        shutdownTimedOut,
        lifecycle,
        pressureReleaseCloseErrors,
        stdout,
        stderr,
      });
    });
  });
}

const options = parseArguments(process.argv.slice(2));
const fixtureRoot = path.join(projectRoot, ".fixture");
const runsRoot = path.join(projectRoot, "runs");
const sessionId = [
  new Date().toISOString().replace(/\D/g, "").slice(0, 14),
  process.pid,
  "native-emfile",
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
let emfileObserved = false;
let nativeExhaustionReached = false;
let allocationCapReached = false;

for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
  const attemptName = `attempt-${String(attempt).padStart(3, "0")}`;
  const attemptRoot = path.join(sessionRoot, attemptName);
  const outputRoot = path.join(attemptRoot, "dist");
  const reservePath = path.join(attemptRoot, "handle-reserve.bin");
  const telemetryPath = path.join(attemptRoot, "write-telemetry.json");
  fs.mkdirSync(attemptRoot, { recursive: true });

  const child = await runCompiler({
    environment: {
      ...process.env,
      NO_COLOR: "1",
      UV_THREADPOOL_SIZE: String(options.uvThreadpoolSize),
      RSPACK_REPRO_INPUT: fixture.inputRoot,
      RSPACK_REPRO_OUTPUT: outputRoot,
      RSPACK_REPRO_TELEMETRY: telemetryPath,
      RSPACK_REPRO_FS_MODE: "default",
      RSPACK_REPRO_HANDLE_PRESSURE: "true",
      RSPACK_REPRO_HANDLE_HEADROOM: String(options.handleHeadroom),
      RSPACK_REPRO_HANDLE_ALLOCATION_CAP: String(options.handleAllocationCap),
      RSPACK_REPRO_HANDLE_RESERVE_PATH: reservePath,
    },
    verify: () => verifyTree(outputRoot, fixture.manifest),
  });

  fs.writeFileSync(path.join(attemptRoot, "compiler.stdout.log"), child.stdout);
  fs.writeFileSync(path.join(attemptRoot, "compiler.stderr.log"), child.stderr);
  fs.rmSync(reservePath, { force: true });

  const compilerGreen =
    child.build !== null &&
    !child.build.failed &&
    child.exitCode === 0 &&
    !child.spawnError &&
    !child.ipcError &&
    !child.buildTimedOut &&
    !child.shutdownTimedOut &&
    child.lifecycle.pressureReleasedAt !== null;
  const attemptNativeExhaustionReached =
    child.build?.pressure?.exhausted === true;
  const attemptAllocationCapReached =
    child.build?.pressure?.enabled === true &&
    !attemptNativeExhaustionReached &&
    child.build.pressure.handlesOpened === options.handleAllocationCap;
  const attemptEmfileObserved = containsEmfile({
    buildError: child.build?.error,
    compilationErrors: child.build?.compilationErrors,
    verificationReadErrors: child.verification?.readErrors,
    verificationError: child.verificationError,
    spawnError: child.spawnError,
    ipcError: child.ipcError,
    stderr: child.stderr,
  });
  const pressureInconclusive = compilerGreen && !attemptNativeExhaustionReached;
  const greenCorruptOutput =
    compilerGreen &&
    attemptNativeExhaustionReached &&
    !attemptEmfileObserved &&
    !child.verificationError &&
    !child.verification.ok;
  const classification = attemptEmfileObserved
    ? "emfile-observed"
    : !compilerGreen
      ? "compiler-failed"
      : child.verificationError
        ? "verifier-failed"
        : pressureInconclusive
          ? "pressure-limit-not-reached"
          : greenCorruptOutput
            ? "green-corrupt-output"
            : "green-complete-output";

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
    compiler: {
      green: compilerGreen,
      exitCode: child.exitCode,
      signal: child.signal,
      spawnError: child.spawnError,
      ipcError: child.ipcError,
      buildTimedOut: child.buildTimedOut,
      shutdownTimedOut: child.shutdownTimedOut,
      lifecycle: child.lifecycle,
      pressureReleaseCloseErrors: child.pressureReleaseCloseErrors,
      callback: child.build,
    },
    output: child.verification,
    verificationError: child.verificationError,
    signatures: {
      greenCorruptOutput,
      emfileObserved: attemptEmfileObserved,
      nativeExhaustionReached: attemptNativeExhaustionReached,
      allocationCapReached: attemptAllocationCapReached,
      verificationFinishedBeforeRelease:
        child.lifecycle.verificationFinishedBeforeRelease,
      pressureReleaseAcknowledged: child.lifecycle.pressureReleasedAt !== null,
    },
  };
  writeJson(path.join(attemptRoot, "result.json"), result);

  const summary = {
    attempt,
    classification,
    compilerExitCode: child.exitCode,
    output: compactVerification(child.verification),
    pressure: child.build?.pressure ?? null,
    emfileObserved: attemptEmfileObserved,
    nativeExhaustionReached: attemptNativeExhaustionReached,
    allocationCapReached: attemptAllocationCapReached,
    verificationFinishedBeforeRelease:
      child.lifecycle.verificationFinishedBeforeRelease,
    pressureReleaseAcknowledged: child.lifecycle.pressureReleasedAt !== null,
  };
  attemptSummaries.push(summary);
  console.log(JSON.stringify(summary, null, 2));

  reproductionFound ||= greenCorruptOutput;
  emfileObserved ||= attemptEmfileObserved;
  nativeExhaustionReached ||= attemptNativeExhaustionReached;
  allocationCapReached ||= attemptAllocationCapReached;

  if (classification === "green-complete-output" && !options.keepSuccessful) {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
  if (classification !== "green-complete-output") break;
}

const summary = {
  schemaVersion: 1,
  sessionId,
  parameters: options,
  environment,
  inputVerified: fixture.verification.ok,
  reproductionFound,
  emfileObserved,
  nativeExhaustionReached,
  allocationCapReached,
  attemptsRun: attemptSummaries.length,
  attempts: attemptSummaries,
};
writeJson(path.join(sessionRoot, "summary.json"), summary);

console.log(
  JSON.stringify(
    {
      session: sessionRoot,
      reproductionFound,
      emfileObserved,
      nativeExhaustionReached,
      allocationCapReached,
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
