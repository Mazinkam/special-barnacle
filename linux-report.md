# Linux targeted verification report

## Environment and isolation

- Linux container image: local cached image `6d43704baacd` (Python 3.12.13, `linux/amd64`); Docker ran it on the current `linux/arm64` host using emulation.
- Repository mounted at `/repo:ro`; test working directory and temporary test state were under the container's `/tmp` tmpfs. Network disabled. No live state root was mounted or accessed.
- The image did not include pytest, so the targeted unittest-compatible tests were invoked with the standard-library unittest runner.

## Result

Command:

```sh
docker run --rm --network none -v "$PWD:/repo:ro" --tmpfs /tmp:rw \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/repo -w /tmp \
  --entrypoint python3 6d43704baacd -B -m unittest \
  tests.test_archive.CliTests.test_cli_execute_preserves_raw_and_corrupt_gzip_collision_and_returns_failure \
  tests.test_dashboard_refresh.BenchmarkHarnessTests
```

Result: **12 tests passed** in 19.730s.

This targeted run covers the corrupt-gzip collision preservation regression and the benchmark harness timeout behavior. It is not a full Linux suite, and because the available image is Python 3.12 under architecture emulation, it does not establish native Linux performance or Python 3.9/3.14 Linux coverage.
