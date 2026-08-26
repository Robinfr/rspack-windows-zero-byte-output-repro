# Rspack Windows zero-byte output reproducer

This project stress-tests Rspack's output asset writes with the real
`CopyRspackPlugin`. It creates a deterministic non-empty input tree, asks Rspack
to copy every file, and independently verifies every output's path, size, and
SHA-256 hash after the Rspack process exits.

The primary failure signature is:

1. Rspack exits with code `0`.
2. One or more outputs are missing, zero bytes, truncated, or have the wrong
   content.

This project contains no files or paths from the deployment where the problem
was first observed.

## Requirements

- Node.js 20.19 or newer
- npm
- Native Windows is preferred for reproducing the reported behavior

Install the pinned baseline:

```sh
npm ci
```

## Quick validation

Run a small portable correctness check before starting the stress loop:

```sh
npm run reproduce:quick
```

This creates 256 input files and should report
`green-complete-output` on every platform.

## Stress modes

Run the untouched Rspack output filesystem first:

```sh
npm run reproduce
```

Run the same workload with an async `writeFile` wrapper that records requested
lengths, callback errors, completion order, and maximum in-flight writes:

```sh
npm run reproduce:instrumented
```

Use synchronous writes only as a diagnostic control:

```sh
npm run control:sync
```

`default` is the actual reproducer. `instrumented` changes the filesystem
object by wrapping async writes, and `sync` intentionally serializes writes;
neither control should replace the default result.

The standard workload copies 13,500 files of 8 KiB each, for 110,592,000 bytes
per attempt. Override the workload directly when tuning stress:

```sh
node ./scripts/run.mjs --mode default --attempts 50 --count 20000 --bytes 8192 --uv-threadpool-size 4
```

Add `--keep-successful` to preserve complete output directories. Corrupt and
failed outputs are always retained.

## Result interpretation

Each run creates `runs/<session>/summary.json`. Every attempt also contains:

- `result.json`: process status, full verifier result, environment, and signatures
- `cli.stdout.log` and `cli.stderr.log`: Rspack CLI output
- `telemetry.json`: present only in `instrumented` and `sync` modes
- `dist/`: retained for corrupt or failed attempts

Classifications:

| Classification          | Meaning                                              |
| ----------------------- | ---------------------------------------------------- |
| `green-complete-output` | Rspack exited `0`; every output matches the manifest |
| `green-corrupt-output`  | Rspack exited `0`; output verification failed        |
| `compiler-failed`       | Rspack exited nonzero or could not be spawned        |

The runner exits nonzero for any classification other than
`green-complete-output`. A nonzero result therefore marks a GitHub Actions job
red while still uploading the complete evidence directory.

For an instrumented run, a zero-byte output is especially useful evidence when
`telemetry.json` reports `zeroLengthWriteRequests: 0`: JavaScript requested a
non-empty write, but the final file is empty.

## Version comparison

Install exact matching CLI and core versions without changing the committed
manifest or lockfile:

```sh
npm install --no-save --package-lock=false @rspack/core@2.1.6 @rspack/cli@2.1.6
npm run reproduce
```

The affected deployment used `1.7.11`. Later versions of interest are `2.1.5`,
`2.1.6`, and `2.1.10`. Run `npm ci` to return to the pinned `1.7.11` baseline.

## GitHub Actions

`.github/workflows/windows-zero-byte-output-repro.yml` is a manually triggered
workflow. It runs a matrix of:

- Windows Server 2022 and Windows Server 2025
- Node.js 20 and Node.js 22
- A selected exact Rspack version and filesystem mode

Start with Rspack `1.7.11` in `default` mode. If it reproduces, rerun the same
matrix in `instrumented` mode, then `sync` mode. Compare `2.1.6` and `2.1.10`
only after capturing the baseline evidence.

## Why this workload

The original deployment emitted 13,424 files and completed successfully, but
3,301 output files were zero bytes even though their intended content was
non-empty. The affected output names did not collide under Windows path
canonicalization. This synthetic workload approximates that fan-out and byte
volume without depending on proprietary inputs.

This reproducer is intended to determine whether high output-write fan-out on
Windows can independently produce that signature. It does not assume a root
cause when the signature has not been observed.
