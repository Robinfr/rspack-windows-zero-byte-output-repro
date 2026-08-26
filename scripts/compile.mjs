import fs from "node:fs";
import path from "node:path";

import { rspack } from "@rspack/core";

import config from "../rspack.config.mjs";

function parsePositiveInteger(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}`);
  }
  return value;
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

function statsErrors(stats) {
  if (!stats?.hasErrors()) return [];
  const json = stats.toJson({ all: false, errors: true });
  return json.errors.slice(0, 100).map((error) =>
    typeof error === "string"
      ? error
      : {
          message: error.message,
          stack: error.stack,
          moduleName: error.moduleName,
        },
  );
}

function closeDescriptors(descriptors) {
  const closeErrors = [];
  while (descriptors.length > 0) {
    const descriptor = descriptors.pop();
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (closeErrors.length < 100) closeErrors.push(errorInfo(error));
    }
  }
  return closeErrors;
}

function createHandlePressure() {
  if (process.env.RSPACK_REPRO_HANDLE_PRESSURE !== "true") {
    throw new Error("RSPACK_REPRO_HANDLE_PRESSURE must be true");
  }

  const allocationCap = parsePositiveInteger(
    "RSPACK_REPRO_HANDLE_ALLOCATION_CAP",
  );
  const requestedHeadroom = parsePositiveInteger(
    "RSPACK_REPRO_HANDLE_HEADROOM",
  );
  const reservePath = process.env.RSPACK_REPRO_HANDLE_RESERVE_PATH;
  if (!reservePath || !path.isAbsolute(reservePath)) {
    throw new Error(
      "RSPACK_REPRO_HANDLE_RESERVE_PATH must be an absolute path",
    );
  }
  if (requestedHeadroom >= allocationCap) {
    throw new Error("Handle headroom must be smaller than the allocation cap");
  }

  fs.mkdirSync(path.dirname(reservePath), { recursive: true });
  fs.writeFileSync(reservePath, "rspack handle pressure reserve\n");

  const descriptors = [];
  let exhaustionError = null;
  const startedAt = Date.now();

  try {
    for (let index = 0; index < allocationCap; index += 1) {
      descriptors.push(fs.openSync(reservePath, "r"));
    }
  } catch (error) {
    if (error.code === "EMFILE" || error.code === "ENFILE") {
      exhaustionError = errorInfo(error);
    } else {
      const closeErrors = closeDescriptors(descriptors);
      if (closeErrors.length > 0) {
        console.error(
          JSON.stringify({ pressureCloseErrors: closeErrors }, null, 2),
        );
      }
      throw error;
    }
  }

  let headroomReleased = 0;
  if (exhaustionError) {
    const headroomToRelease = Math.min(requestedHeadroom, descriptors.length);
    try {
      for (let index = 0; index < headroomToRelease; index += 1) {
        fs.closeSync(descriptors.at(-1));
        descriptors.pop();
        headroomReleased += 1;
      }
    } catch (error) {
      const closeErrors = closeDescriptors(descriptors);
      if (closeErrors.length > 0) {
        console.error(
          JSON.stringify({ pressureCloseErrors: closeErrors }, null, 2),
        );
      }
      throw error;
    }
  }

  const telemetry = {
    enabled: true,
    platform: process.platform,
    allocationCap,
    requestedHeadroom,
    handlesOpened: descriptors.length + headroomReleased,
    handlesHeldDuringBuild: descriptors.length,
    headroomReleased,
    exhausted: Boolean(exhaustionError),
    exhaustionError,
    allocationDurationMs: Date.now() - startedAt,
  };

  return {
    telemetry,
    release: () => closeDescriptors(descriptors),
  };
}

let compiler;
let pressure;
let buildFailed = true;
let runStarted = false;
let runCompleted = false;
let finishRequested = false;
let released = false;
let disconnectTimer;

function sendBuildResult(result) {
  if (!process.connected) {
    requestFinish();
    return;
  }

  try {
    process.send({ type: "build-complete", ...result }, (error) => {
      if (error) requestFinish();
    });
  } catch {
    requestFinish();
  }
}

function finish() {
  if (released) return;
  released = true;
  clearTimeout(disconnectTimer);

  const pressureCloseErrors = pressure?.release() ?? [];
  const closeCompiler = (releaseAckError = null) => {
    const close = (closeError) => {
      if (releaseAckError) console.error(releaseAckError);
      if (closeError) console.error(closeError);
      if (pressureCloseErrors.length > 0) {
        console.error(JSON.stringify({ pressureCloseErrors }, null, 2));
      }
      if (process.connected) process.disconnect();
      process.exitCode =
        buildFailed ||
        releaseAckError ||
        closeError ||
        pressureCloseErrors.length > 0
          ? 1
          : 0;
    };

    if (compiler) {
      compiler.close(close);
    } else {
      close(null);
    }
  };

  if (!process.connected) {
    closeCompiler();
    return;
  }

  try {
    process.send(
      { type: "pressure-released", closeErrors: pressureCloseErrors },
      (error) => closeCompiler(error),
    );
  } catch (error) {
    closeCompiler(error);
  }
}

function requestFinish(fromDisconnect = false) {
  finishRequested = true;
  if (runStarted && !runCompleted) {
    if (fromDisconnect && !disconnectTimer) {
      disconnectTimer = setTimeout(() => process.exit(1), 30000);
    }
    return;
  }
  finish();
}

process.on("message", (message) => {
  if (message?.type === "release") requestFinish();
});
process.on("disconnect", () => requestFinish(true));

try {
  compiler = rspack(config);
  pressure = createHandlePressure();

  runStarted = true;
  compiler.run((error, stats) => {
    runCompleted = true;
    const compilationErrors = statsErrors(stats);
    buildFailed = Boolean(error) || compilationErrors.length > 0;
    sendBuildResult({
      failed: buildFailed,
      error: errorInfo(error),
      compilationErrors,
      pressure: pressure.telemetry,
      startTime: stats?.startTime,
      endTime: stats?.endTime,
    });
    if (finishRequested) finish();
  });
} catch (error) {
  buildFailed = true;
  sendBuildResult({
    failed: true,
    error: errorInfo(error),
    compilationErrors: [],
    pressure: pressure?.telemetry ?? null,
  });
}
