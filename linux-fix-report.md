# Linux fix report: benchmark subprocess timeout supervisor lifecycle

## Defect

`scripts/benchmark_refresh.py::run_child` built its timeout supervisor with
`deadline = _KillOnDeadline(proc.pid, timeout)` *outside* the cleanup `try`, and the
constructor called `threading.Timer.start()`.

- If `Timer.start()` raised (`RuntimeError: can't start new thread`), or
- if `Thread.start()` was interrupted (e.g. `KeyboardInterrupt`) while blocking on the new
  thread's started-event, i.e. after the timer thread was already running,

the exception left `run_child` before `deadline` was bound. Nothing killed or reaped the child
(a zombie until `Popen.__del__` reaped it behind the harness's back), and in the second case a
running Timer nobody could cancel would later SIGKILL `pid`; once the child had been reaped and
the pid recycled, that signal could reach an unrelated process.

## Fix (`scripts/benchmark_refresh.py`)

- `_KillOnDeadline()` construction starts no thread. New `arm(pid, timeout)` binds the Timer to
  `self._timer` under the lock *before* `Timer.start()`, so the supervisor reference is retained
  whatever `start()` does.
- `close()` sets `_closed` under the lock (forbidding any kill), cancels the timer and joins its
  thread if it ever started. After `close()` returns no signal can be sent, so the caller may
  reap the child and the kernel may recycle its pid.
- `run_child` now runs `Popen`, `arm` and `_await_exit` inside the exception-safe `try`. On any
  `BaseException` it calls `deadline.close()` first, then kills and reaps the child (skipped only
  when `Popen` itself raised and there is no child), then re-raises. The normal path is
  unchanged: `close()` then one blocking `wait4`.

## Tests (`tests/test_dashboard_refresh.py::BenchmarkHarnessTests`)

Two deterministic tests substitute a `threading.Timer` subclass whose `start()` raises:

- `test_run_child_reaps_the_child_and_disarms_when_timer_start_raises` — `start()` raises
  `RuntimeError` without starting the thread.
- `test_run_child_disarms_a_running_timer_when_start_is_interrupted` — `start()` starts the
  thread (real `Timer.start`) and then raises `KeyboardInterrupt`, with a 0.05s deadline against a
  10s child so an un-disarmed supervisor would fire during the test.

Both assert: the original exception propagates; `os.waitpid(pid, WNOHANG)` raises
`ChildProcessError` (no zombie, Popen informed of the reap); the timer thread is not alive and
`timer.finished` is set; exactly one `(pid, SIGKILL)` went through `os.kill` (the cleanup's own);
and a deliberately late `_expire()` after `close()` sends nothing and leaves `expired` False.

Against the pre-fix code both tests fail with `ChildProcessError not raised` plus an un-waited
`Popen` `ResourceWarning`.

## Verification

### macOS host (kqueue `NOTE_EXIT` path on 3.9; `waitid(WNOWAIT)` path on 3.14)

- `uv run --no-project --python 3.14 --with pytest python -B -m pytest tests -q`
  → Python 3.14.7: **371 passed, 104 subtests passed** (52.77s)
- `/usr/bin/python3 -B -m pytest tests -q`
  → Python 3.9.6: **371 passed** (52.89s)
- `python3.14 -B -W error::ResourceWarning -m unittest tests.test_dashboard_refresh.BenchmarkHarnessTests`
  → 15 tests OK (ResourceWarning escalated to error to catch any un-reaped `Popen`)

### Linux (targeted, `waitid(WNOWAIT)` path)

Cached image `6d43704baacd` (Python 3.12.13, `linux/amd64`, run under emulation on the arm64
host). Repository mounted read-only at `/repo`; working directory and temporary state on a tmpfs
`/tmp`; network disabled; no live state root mounted or accessed.

```sh
docker run --rm --network none -v "$PWD:/repo:ro" --tmpfs /tmp:rw \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/repo -w /tmp \
  --entrypoint python3 6d43704baacd -B -W error::ResourceWarning -m unittest -v \
  tests.test_dashboard_refresh.BenchmarkHarnessTests
```

Result: **15 tests OK** in 18.163s, including both new lifecycle tests.

This is a targeted Linux run, not a full Linux suite, and the image is Python 3.12 under
architecture emulation; it does not establish Python 3.9/3.14 Linux coverage.

## Scope

No live state was read or written. Change is confined to `scripts/benchmark_refresh.py`,
`tests/test_dashboard_refresh.py` and this report. No subagents were used.
