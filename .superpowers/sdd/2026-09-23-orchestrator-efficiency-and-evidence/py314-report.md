# Python 3.14 floating-point dashboard test correction

## Change

`tests/test_dashboard_refresh.py` now compares only the interactive-session monetary totals with an absolute tolerance of `$1e-9`. This covers `interactive_sessions.cost` and each `interactive_sessions.by_runtime[*].cost`, where Python 3.14's differing float accumulation order produced a sub-cent/sub-nanodollar representation drift. The threshold remains far below a cent; larger monetary divergences still fail.

All other top-level dashboard fields remain exact-equality comparisons. The interactive-session object and per-runtime objects must still have identical keys, and all non-cost values (calls, tokens, sessions, runtime names and other fields) remain exact.

## RED → GREEN

- **RED, Python 3.14.7:**
  `python3.14 -m unittest tests.test_dashboard_refresh.DashboardAggregateTests.test_streaming_build_matches_the_whole_file_reference_on_a_large_history`
  failed as expected: `interactive_sessions.cost` was `932.2534190000005` for the streaming build and `932.253419` for the whole-file reference. The test failed solely at the exact top-level field equality assertion.
- **GREEN, Python 3.14.7:** the same focused unittest passed after the scoped tolerance was added.

## Full-suite verification

| Interpreter | Command | Result |
|---|---|---|
| Python 3.14.7 | `uv run --python 3.14 --with pytest --no-project -- python -B -m pytest -p no:cacheprovider -q` | **364 passed, 104 subtests passed** in 53.57s |
| Python 3.9.6 | `uv run --python 3.9 --no-project -- python -B -m pytest -p no:cacheprovider -q` | **364 passed** in 52.68s |

The direct `python3.14 -B -m pytest ...` invocation initially could not start because pytest is not installed in the system 3.14 interpreter. The successful 3.14 run supplies pytest through uv's isolated run environment; no project dependency or repository environment was changed.

`git diff --check` passed. No live state was accessed, and no subagents were used.
