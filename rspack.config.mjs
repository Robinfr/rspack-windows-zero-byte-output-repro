import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CopyRspackPlugin } from "@rspack/core";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginName = "OutputWriteTelemetryPlugin";

function requiredPath(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function errorInfo(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
    dest: error.dest,
  };
}

class OutputWriteTelemetryPlugin {
  constructor({ mode, telemetryPath }) {
    this.mode = mode;
    this.telemetryPath = telemetryPath;
  }

  apply(compiler) {
    const telemetry = {
      schemaVersion: 1,
      mode: this.mode,
      startedAt: new Date().toISOString(),
      writeCalls: 0,
      completedWrites: 0,
      writeErrors: 0,
      zeroLengthWriteRequests: 0,
      requestedBytes: 0,
      minRequestedBytes: null,
      maxRequestedBytes: null,
      inFlight: 0,
      maxInFlight: 0,
      writeErrorSamples: [],
      writes: [],
      finalHook: null,
      compilerError: null,
    };

    const persist = (finalHook) => {
      telemetry.finalHook = finalHook;
      telemetry.finishedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(this.telemetryPath), { recursive: true });
      fs.writeFileSync(
        this.telemetryPath,
        `${JSON.stringify(telemetry, null, 2)}\n`,
      );
    };

    compiler.hooks.beforeRun.tap(pluginName, () => {
      const base = compiler.outputFileSystem;
      if (!base) throw new Error("Rspack has no outputFileSystem");

      const outputFileSystem = Object.create(base);
      outputFileSystem.writeFile = (filename, content, callback) => {
        const requestedLength = Buffer.isBuffer(content)
          ? content.length
          : Buffer.byteLength(content);

        telemetry.writeCalls += 1;
        telemetry.requestedBytes += requestedLength;
        telemetry.minRequestedBytes =
          telemetry.minRequestedBytes === null
            ? requestedLength
            : Math.min(telemetry.minRequestedBytes, requestedLength);
        telemetry.maxRequestedBytes =
          telemetry.maxRequestedBytes === null
            ? requestedLength
            : Math.max(telemetry.maxRequestedBytes, requestedLength);
        if (requestedLength === 0) telemetry.zeroLengthWriteRequests += 1;

        telemetry.inFlight += 1;
        telemetry.maxInFlight = Math.max(
          telemetry.maxInFlight,
          telemetry.inFlight,
        );

        const write = {
          id: telemetry.writeCalls,
          filename: String(filename),
          requestedLength,
          completionOrder: null,
          error: null,
        };
        telemetry.writes.push(write);

        const finish = (error) => {
          telemetry.completedWrites += 1;
          telemetry.inFlight -= 1;
          write.completionOrder = telemetry.completedWrites;
          write.error = errorInfo(error);
          if (error) {
            telemetry.writeErrors += 1;
            if (telemetry.writeErrorSamples.length < 100) {
              telemetry.writeErrorSamples.push({
                filename: String(filename),
                error: errorInfo(error),
              });
            }
          }
          callback(error ?? null);
        };

        if (this.mode === "sync") {
          try {
            fs.writeFileSync(filename, content);
            finish(null);
          } catch (error) {
            finish(error);
          }
          return;
        }

        try {
          base.writeFile.call(base, filename, content, finish);
        } catch (error) {
          finish(error);
        }
      };

      compiler.outputFileSystem = outputFileSystem;
    });

    compiler.hooks.done.tap(pluginName, () => persist("done"));
    compiler.hooks.failed.tap(pluginName, (error) => {
      telemetry.compilerError = errorInfo(error);
      persist("failed");
    });
  }
}

const inputPath = requiredPath("RSPACK_REPRO_INPUT");
const outputPath = requiredPath("RSPACK_REPRO_OUTPUT");
const telemetryPath = requiredPath("RSPACK_REPRO_TELEMETRY");
const filesystemMode = process.env.RSPACK_REPRO_FS_MODE ?? "default";

if (!new Set(["default", "instrumented", "sync"]).has(filesystemMode)) {
  throw new Error(`Unknown RSPACK_REPRO_FS_MODE: ${filesystemMode}`);
}

const plugins = [
  new CopyRspackPlugin({
    patterns: [{ from: inputPath, to: "" }],
  }),
];

if (filesystemMode !== "default") {
  plugins.unshift(
    new OutputWriteTelemetryPlugin({ mode: filesystemMode, telemetryPath }),
  );
}

export default {
  context: projectRoot,
  mode: "none",
  entry: {},
  cache: false,
  devtool: false,
  performance: false,
  output: {
    path: outputPath,
    clean: true,
    compareBeforeEmit: true,
  },
  optimization: {
    minimize: false,
  },
  stats: {
    preset: "errors-warnings",
    timings: true,
  },
  plugins,
};
