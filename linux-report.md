# Linux smoke verification report

## Environment and isolation

- Linux ran in a Docker container with Python 3.12 on `linux/amd64`, emulated on a `linux/arm64` host.
- The repository was mounted read-only (`/repo:ro`), network access was disabled, and temporary test state was kept in the container's `/tmp` tmpfs. No live state root was mounted or accessed.

## Linux coverage and results

- An earlier Docker pytest run passed **15 tests**, including the archive-collision coverage, `BenchmarkHarnessTests`, and the full legacy comparison test.
- The latest targeted Docker run used the standard-library unittest runner and passed **15 tests in 18.2s**. It covered the targeted archive collision and `BenchmarkHarnessTests`, including the timeout supervisor.
- There has been no full Linux suite run after the latest fixes.

## Supported-platform verification and limits

The supported macOS Python 3.14 full suite passed **371 tests**. These Linux smoke results do not establish a native Linux full-suite result or Linux performance; neither is claimed here.
