# [Bug]: Rspack can exit 0 with zero-byte output assets on Windows

## System Info

```text
System:
  OS: Windows Server 2022 Datacenter 10.0.20348
      Windows Server 2025 Datacenter 10.0.26100
Binaries:
  Node: 22.17.0
  npm: 10.9.2
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

Synthetic reproduction result:

- Rspack exit code: `0`
- compiler callback error: none
- compilation errors: none
- expected and actual outputs: `13,500`
- missing outputs: `0`
- zero-byte outputs: `12,796`
- wrong-size outputs: `12,796`
- wrong-hash outputs: `12,796`
- native handles opened before `EMFILE`: `8,188`
- reserve handles held through verification: `8,124`
- reserve-handle close errors: `0`
- Windows runners: Server 2022 and Server 2025
- Node version: `22.17.0`
- failing Actions run: [32953337920](https://github.com/Robinfr/rspack-windows-zero-byte-output-repro/actions/runs/32953337920)

The result was identical on both Windows runners. Verification completed before
the child released its reserve handles and closed the compiler.

Under the same workload and handle pressure, Rspack `2.1.6` produced the same
count of 12,796 zero-byte files but returned a compiler error and exited `1`:

```text
Rspack FS Error: IO error: Error: EMFILE: too many open files, open '...\dist\group-097\asset-006369.bin'
```

Comparison Actions run:
[32953791982](https://github.com/Robinfr/rspack-windows-zero-byte-output-repro/actions/runs/32953791982)

The version comparison is consistent with this implementation history:

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
3. Run `npm run reproduce:native-emfile` to create native handle pressure while
   retaining the untouched asynchronous output filesystem.
4. Inspect `runs/<session>/summary.json` and each `result.json`.
5. A reproduction is conclusive when Rspack exits `0` and the result is
   classified as `green-corrupt-output`.
6. Install Rspack `2.1.6` without changing the lockfile and repeat the same
   pressure run to compare silent output loss with surfaced `EMFILE`.

Expected: Rspack either writes all 13,500 outputs exactly or exits nonzero with
the underlying write error.

Actual: Rspack exits `0`, but external verification finds zero-byte or otherwise
corrupt outputs.
