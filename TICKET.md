# [Bug]: Rspack can exit 0 with zero-byte output assets on Windows

## System Info

<!-- Replace with environment.txt from the failing Actions artifact. -->

```text
System:
  OS: Microsoft Windows Server 2022 or 2025
Binaries:
  Node: 22.17.0
  npm: <from artifact>
npmPackages:
  @rspack/cli: 1.7.11
  @rspack/core: 1.7.11
```

## Details

On Windows, a successful Rspack build can leave a subset of emitted assets as
zero-byte files even though every source asset is non-empty. The CLI exits with
code `0`, so deployment proceeds with silently corrupt output.

Observed deployment evidence:

- 13,424 files in the output tree
- 3,301 zero-byte files
- all intended/source content for those files was non-empty
- no output-name collisions after Windows case folding and separator
  normalization
- the zero-byte files formed one timestamp cohort
- the Rspack build reported success

The linked synthetic reproducer generates 13,500 deterministic non-empty files,
copies them with `CopyRspackPlugin`, and verifies every output's path, size, and
SHA-256 after the Rspack process exits. It uses Rspack's untouched Node output
filesystem in its primary mode. Optional controls can record async write
fan-out or serialize writes with `writeFileSync`.

<!-- Add only after a synthetic failing run has been captured. -->

Synthetic reproduction result:

- Rspack exit code: `<0>`
- missing outputs: `<count>`
- zero-byte outputs: `<count>`
- wrong-size outputs: `<count>`
- wrong-hash outputs: `<count>`
- instrumented zero-length write requests: `<count>`
- instrumented maximum in-flight writes: `<count>`
- Windows runner / Node version: `<from summary.json>`
- failing Actions run: `<URL>`

Possibly related implementation history, without asserting the same root cause:

- [#14889](https://github.com/web-infra-dev/rspack/issues/14889) reported
  silent asset loss when output emission hit `EMFILE`.
- [#14891](https://github.com/web-infra-dev/rspack/pull/14891), released in
  `2.1.6`, propagated asset-emission task errors that were previously discarded.

The failure here is specifically the green-process case: the build must not
report success when an output write fails or produces incomplete content.

## Reproduce link

https://github.com/Robinfr/rspack-windows-zero-byte-output-repro

## Reproduce Steps

1. Use native Windows or run the linked GitHub Actions workflow.
2. Install dependencies with `npm ci`.
3. Run `npm run reproduce` for the untouched asynchronous output filesystem.
4. Inspect `runs/<session>/summary.json` and each `result.json`.
5. A reproduction is conclusive when Rspack exits `0` and the result is
   classified as `green-corrupt-output`.
6. If default mode reproduces, run `npm run reproduce:instrumented` to capture
   write lengths, callback errors, and maximum concurrency.
7. Run `npm run control:sync` only as a diagnostic comparison.

Expected: Rspack either writes all 13,500 outputs exactly or exits nonzero with
the underlying write error.

Actual: Rspack exits `0`, but external verification finds zero-byte or otherwise
corrupt outputs.
