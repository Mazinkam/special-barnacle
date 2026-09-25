"""Before/after benchmark for the orchestrator refresh path on synthetic 1x/2x/4x fixtures.

    PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/benchmark_refresh.py [--runs 500] [--repeat 5] [--scales 1,2,4] [--json]

Never reads live state: every fixture is written into a fresh temporary directory by
`tests.test_dashboard_refresh.write_synthetic_history` (`--source ROOT` copies the three JSONL
streams of an existing root into the temp directory instead and replicates them for 2x/4x with
re-suffixed identifiers). For each scale the script:

1. warms the fixture with one CLI `batch` call (cold record-index derivation + full ledger
   replay; reported as `cold_first_batch`, not included in the medians);
2. measures `--repeat` CLI `batch` invocations of a `--batch-size`-record batch (durable append +
   incremental ledger + dashboard) and `--repeat` CLI `dashboard` invocations;
3. for comparison, measures writing the same records through the legacy one-record commands
   (`event`/`metric`/`outcome`), i.e. one subprocess per record;
4. measures an engine completion followed by a model-call append/refresh, including any cache
   re-derivation that the completion imposed on the next writer.

Use this SAME driver with `--checkout BEFORE` and `--checkout AFTER` against the same `--source`
copy for a revision comparison. The target checkout supplies child code; the driver supplies the
same instrumentation and input-evidence classifier for both. Input sizes, SHA-256 digests and
billing/duration/verification coverage are captured BEFORE benchmark appends. No measured saving
here is evidence of real model-cost or quality savings. `--source` should name a frozen COPY, not
live state. All target mutations are confined to disposable fixtures; state/code-root
encodings override inherited environment values.

Per measured operation it prints the subprocess count, median elapsed seconds (spawn to exit),
peak child RSS, throughput, and the bytes the child actually read and wrote:

* **logical** bytes are counted inside the child by `instrumented_argv`: every file object the
  program opens (`io.open`/`open`/`Path.open`/`os.fdopen`) gets a counting raw layer, and
  `os.read`/`os.write`/`os.pread`/`os.pwrite` are wrapped. That is the program's own data I/O —
  streams, ledger, checkpoint, dashboard — and excludes interpreter start-up (module loading goes
  through `_io.open_code`), the child's stdout/stderr, and sqlite3's own file I/O (C library).
* **physical** bytes are what the OS says reached the disk for the process: Linux `/proc/self/io`
  `read_bytes`/`write_bytes` (which also yields kernel-counted logical `rchar`/`wchar` over *all*
  descriptors, reported as `kernel_logical`), macOS `proc_pid_rusage` `ri_diskio_bytesread/
  byteswritten`. Page-cache hits make physical reads much smaller than logical reads; that gap is
  the point of reporting both. `null` means the platform offers no per-process source.

Each child is reaped with `os.wait4`, so `peak_rss_mib` is that child's own `ru_maxrss` (MiB on
macOS bytes / Linux KiB), and its stdout/stderr go to temporary files, never pipes: a chatty child
cannot block on a full pipe while the parent waits. Run before and after a change with the same
arguments; fixture sizes are reported separately (`fixture_bytes`) and are not a measurement.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import select
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from functools import partial
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

STREAMS = ('events.jsonl', 'metrics.jsonl', 'outcomes.jsonl')
ID_FIELDS = ('record_id', 'run_id', 'task_id', 'session_id', 'decision_id')
IO_REPORT_ENV = 'ORCHESTRATOR_BENCH_IO_REPORT'
LOGICAL_SOURCE = 'python file objects + os.read/os.write in the child (excludes interpreter start-up, stdio and sqlite3)'
LEGACY_TIMEOUT_FLOOR_S = 60
LEGACY_TIMEOUT_CAP_S = 240


def legacy_process_timeout(planned_process_count: int, seconds_per_process: float = 1) -> int:
    """Budget `seconds_per_process` per planned child (default one second), bounded to a practical 60–240s.

    The driver uses the default for each legacy child; the outer regression test budgets its whole
    compare-legacy run per child at a higher rate so emulated Linux stays inside the same bounds.
    """
    return int(min(LEGACY_TIMEOUT_CAP_S, max(LEGACY_TIMEOUT_FLOOR_S, planned_process_count * seconds_per_process)))


def compare_legacy_process_count(*, scales: int, repeat: int, batch_size: int) -> int:
    """Children `compare_legacy` spawns: per scale, repeat+1 trials of batch_size legacy children plus one batch child."""
    return scales * (repeat + 1) * (batch_size + 1)

# Prepended to every instrumented child's `-c` program. Pure standard library, runs before the
# program under test, writes its report at exit to the path in $ORCHESTRATOR_BENCH_IO_REPORT.
_INSTRUMENT = r'''
import atexit, builtins, io, json, os, sys
_counts = {'read': 0, 'write': 0}
_real_open = io.open

class _CountingFileIO(io.FileIO):
    """The raw layer io.open would have built, counting bytes as the buffered layers pull/push them."""
    def readinto(self, b):
        n = super().readinto(b)
        if n: _counts['read'] += n
        return n
    def read(self, size=-1):
        data = super().read(size)
        if data: _counts['read'] += len(data)
        return data
    def readall(self):
        data = super().readall()
        if data: _counts['read'] += len(data)
        return data
    def write(self, b):
        n = super().write(b)
        if n: _counts['write'] += n
        return n

def _open(file, mode='r', buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
    # io.open's raw -> buffered -> text layering, with the counting raw layer underneath.
    modes = set(mode)
    binary = 'b' in modes
    if binary and 't' in modes: raise ValueError("can't have text and binary mode at once")
    creating, reading, writing, appending, updating = ('x' in modes), ('r' in modes), ('w' in modes), ('a' in modes), ('+' in modes)
    raw_mode = ('x' if creating else '') + ('r' if reading else '') + ('w' if writing else '') + ('a' if appending else '') + ('+' if updating else '')
    raw = _CountingFileIO(file, raw_mode, closefd, opener=opener)
    try:
        line_buffering = False
        if buffering == 1 or (buffering < 0 and raw.isatty()): buffering = -1; line_buffering = True
        if buffering < 0:
            buffering = io.DEFAULT_BUFFER_SIZE
            try: block = os.fstat(raw.fileno()).st_blksize
            except (OSError, AttributeError): pass
            else:
                if block > 1: buffering = block
        if buffering == 0:
            if binary: return raw
            raise ValueError("can't have unbuffered text I/O")
        if updating: buffer = io.BufferedRandom(raw, buffering)
        elif creating or writing or appending: buffer = io.BufferedWriter(raw, buffering)
        else: buffer = io.BufferedReader(raw, buffering)
        if binary: return buffer
        text = io.TextIOWrapper(buffer, encoding, errors, newline, line_buffering); text.mode = mode
        return text
    except Exception:
        raw.close(); raise

def _counted(fn, key):
    def wrapper(*args, **kwargs):
        result = fn(*args, **kwargs)
        n = result if isinstance(result, int) else len(result)
        if n > 0: _counts[key] += n
        return result
    return wrapper

io.open = builtins.open = _open
for _name, _key in (('read', 'read'), ('pread', 'read'), ('readv', 'read'), ('write', 'write'), ('pwrite', 'write'), ('writev', 'write')):
    if hasattr(os, _name): setattr(os, _name, _counted(getattr(os, _name), _key))

def _kernel_view():
    """The OS's own per-process counters: physical bytes everywhere it exists, kernel logical bytes on Linux."""
    if sys.platform.startswith('linux'):
        try:
            with _real_open('/proc/self/io') as f:
                fields = {k.strip(): int(v) for k, v in (line.split(':', 1) for line in f if ':' in line)}
            return {'physical': {'read_bytes': fields['read_bytes'], 'write_bytes': fields['write_bytes'], 'source': '/proc/self/io read_bytes/write_bytes'},
                    'kernel_logical': {'read_bytes': fields['rchar'], 'write_bytes': fields['wchar'], 'source': '/proc/self/io rchar/wchar (all descriptors, incl. stdio and start-up)'}}
        except (OSError, KeyError, ValueError): return {}
    if sys.platform == 'darwin':
        try:
            import ctypes
            class RusageInfoV2(ctypes.Structure):
                _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
                    'ri_user_time', 'ri_system_time', 'ri_pkg_idle_wkups', 'ri_interrupt_wkups', 'ri_pageins', 'ri_wired_size',
                    'ri_resident_size', 'ri_phys_footprint', 'ri_proc_start_abstime', 'ri_proc_exit_abstime', 'ri_child_user_time',
                    'ri_child_system_time', 'ri_child_pkg_idle_wkups', 'ri_child_interrupt_wkups', 'ri_child_pageins',
                    'ri_child_elapsed_abstime', 'ri_diskio_bytesread', 'ri_diskio_byteswritten')]
            info = RusageInfoV2()
            if ctypes.CDLL('/usr/lib/libproc.dylib').proc_pid_rusage(os.getpid(), 2, ctypes.byref(info)) != 0: return {}
            return {'physical': {'read_bytes': int(info.ri_diskio_bytesread), 'write_bytes': int(info.ri_diskio_byteswritten),
                                 'source': 'proc_pid_rusage(RUSAGE_INFO_V2) ri_diskio_bytesread/byteswritten'}}
        except (OSError, AttributeError): return {}
    return {}

def _report():
    path = os.environ.get('ORCHESTRATOR_BENCH_IO_REPORT')
    if not path: return
    report = {'python_file_io': {'read_bytes': _counts['read'], 'write_bytes': _counts['write']}, **_kernel_view()}
    try:
        with _real_open(path, 'w') as f: json.dump(report, f)
    except OSError: pass
atexit.register(_report)
'''

_RUN_CLI = r'''
import sys
sys.argv = ['orchestrator', *sys.argv[1:]]
from orchestrator import cli
cli.main()
'''


@dataclass
class ChildRun:
    argv: list
    returncode: int
    elapsed_s: float          # spawn to the kernel's exit notification, i.e. what one more subprocess costs the caller
    ru_maxrss: int            # the child's own high-water mark (os.wait4)
    ru_inblock: int           # rusage block counts: populated on Linux, always 0 on macOS
    ru_oublock: int
    stdout: str
    stderr: str
    io: dict | None           # the child's I/O report; None when the child was not instrumented or died before completing it


def rss_mib(ru_maxrss: int) -> float:
    return ru_maxrss / (1024 ** 2 if sys.platform == 'darwin' else 1024)


def cli_env(root: Path, checkout: Path = REPO) -> dict[str, str]:
    return {**os.environ, 'CODING_AGENT_ORCHESTRATOR_HOME': str(root), 'CODING_AGENT_RUNTIME': 'benchmark',
            'HUMAIN_ORCHESTRATOR_STATE_ROOT': str(root), 'HUMAIN_ORCHESTRATOR_SKILL_ROOT': str(checkout),
            'CODING_AGENT_REPOSITORY': '/work/forge', 'PYTHONPATH': str(checkout), 'PYTHONDONTWRITEBYTECODE': '1'}


def instrumented_argv(program: str, *args: str) -> list[str]:
    """argv for a child that runs `program` (Python source) with I/O counting installed first."""
    return [sys.executable, '-B', '-c', _INSTRUMENT + program, *args]


def cli_argv(*args: str) -> list[str]:
    return instrumented_argv(_RUN_CLI, *args)


def _await_exit(pid: int) -> None:
    """Block until child `pid` has exited WITHOUT reaping it, so wait4 still collects its rusage.

    No sampling: the kernel wakes this thread on exit. Linux (and CPython 3.14+ on macOS) expose
    waitid(WNOWAIT); older CPython omits waitid on macOS, where kqueue's EVFILT_PROC/NOTE_EXIT is
    the equivalent. A child that already exited (zombie) returns immediately on both.
    """
    if hasattr(os, 'waitid'):
        os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT); return
    kq = select.kqueue()
    try:
        exit_event = select.kevent(pid, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT, select.KQ_NOTE_EXIT)
        try: kq.control([exit_event], 1)
        except ProcessLookupError: pass  # exited before the filter attached; wait4 reaps it at once
    finally: kq.close()


class _KillOnDeadline:
    """Timer supervisor that SIGKILLs an unreaped child at `timeout`, adding nothing to the measured child.

    The reaping thread blocks in `_await_exit`; the timer thread only ever signals. Killing and
    reaping are serialized by `_lock`: the kill is sent only while `closed` is False, and the reaper
    sets `closed` before its wait4, so a SIGKILL can never reach a reaped (potentially recycled) pid.

    Construction starts no thread. `arm` binds the Timer to `self._timer` *before* `Timer.start()`,
    so the supervisor is disarmable even when `start()` raises (thread limit) or is interrupted
    after the thread is already running: the caller's exception path reaches `close()`, which
    forbids the kill under the lock, cancels the timer and joins its thread before the child is
    reaped. Nothing armed can outlive `close()`.
    """

    def __init__(self):
        self.pid = None; self.expired = False; self._closed = False; self._lock = threading.Lock()
        self._timer = None

    def arm(self, pid: int, timeout: float | None) -> None:
        """Supervise `pid`; SIGKILL it after `timeout` seconds (None: never). Call inside the caller's cleanup try."""
        with self._lock:
            if self._closed: return
            self.pid = pid
            if timeout is None: return
            self._timer = threading.Timer(timeout, self._expire); self._timer.daemon = True
        self._timer.start()  # may raise or be interrupted: `_timer` is already bound, so `close()` still disarms it

    def _expire(self) -> None:
        with self._lock:
            if self._closed: return
            self.expired = True
            try: os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError: pass

    def close(self) -> None:
        """Forbid any further kill; call before reaping. Blocks while an in-flight kill finishes.

        After this returns the timer thread, if it ever started, has exited: the deadline can no
        longer fire, so the caller may reap the child and the kernel may recycle its pid.
        """
        with self._lock:
            self._closed = True; timer = self._timer
        if timer is None: return
        timer.cancel()
        if timer.is_alive(): timer.join()  # not alive: start() never got the thread running, nothing to wait for


def run_child(argv: list[str], *, env: dict[str, str], cwd: str | None = None, stdin: str | None = None,
              timeout: float | None = None) -> ChildRun:
    """Spawn `argv`, reap it with os.wait4 and collect its output and I/O report.

    stdin/stdout/stderr are temporary files rather than pipes, so the child can never block on a
    full pipe while this process is blocked waiting (and the parent never has to read while
    waiting). The I/O report path is handed to the child through $ORCHESTRATOR_BENCH_IO_REPORT and
    lives in the same private temporary directory, never in the state root under test.

    Every child, timed or not, is waited for the same way: block until the kernel reports the exit
    (`_await_exit`), stamp `elapsed_s`, then one blocking wait4 for status and rusage. `timeout`
    arms `_KillOnDeadline`; a fixed WNOHANG/sleep poll would add up to one sampling interval to
    only the timed (legacy) children and bias the before/after comparison. Raises
    `subprocess.TimeoutExpired` after the killed child is reaped.
    """
    with tempfile.TemporaryDirectory(prefix='orchestrator-bench-child-') as tmp:
        report = Path(tmp, 'io.json')
        with open(Path(tmp, 'stdin'), 'w+b') as inp, open(Path(tmp, 'stdout'), 'w+b') as out, open(Path(tmp, 'stderr'), 'w+b') as err:
            if stdin is not None: inp.write(stdin.encode('utf-8')); inp.flush(); inp.seek(0)
            deadline = _KillOnDeadline(); proc = None
            start = time.perf_counter()
            try:
                proc = subprocess.Popen(argv, stdin=inp if stdin is not None else subprocess.DEVNULL, stdout=out, stderr=err,
                                        env={**env, IO_REPORT_ENV: str(report)}, cwd=cwd)
                deadline.arm(proc.pid, timeout)
                _await_exit(proc.pid)
                elapsed = time.perf_counter() - start
            except BaseException:
                deadline.close()  # disarmed and its thread gone before anything below can free the pid
                if proc is not None:  # Popen itself failing leaves no child to reap
                    # The child is unreaped here (zombie or alive), so this kill is safe.
                    try: os.kill(proc.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    _, status, _ = os.wait4(proc.pid, 0)
                    proc.returncode = os.waitstatus_to_exitcode(status)
                raise
            deadline.close()
            _, status, usage = os.wait4(proc.pid, 0)  # immediate: the child is a zombie
            proc.returncode = code = os.waitstatus_to_exitcode(status)  # tell Popen it is reaped; no second waitpid
            if deadline.expired:
                raise subprocess.TimeoutExpired(argv, timeout)
            out.seek(0); err.seek(0)
            stdout = out.read().decode('utf-8', 'replace'); stderr = err.read().decode('utf-8', 'replace')
        io_report = _load_io_report(report)
    return ChildRun(list(argv), code, elapsed, usage.ru_maxrss, usage.ru_inblock, usage.ru_oublock, stdout, stderr, io_report)


def _load_io_report(path: Path) -> dict | None:
    """The child's report, or None when it is missing, truncated (child died mid-write) or not an object.

    A child that crashes while `_report` is writing leaves an unparseable file; that must not turn
    into a decode error in the parent, which would hide the child's non-zero exit code.
    """
    try:
        loaded = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    return loaded if isinstance(loaded, dict) else None


def run_cli(root: Path, *args: str, stdin: str | None = None, checkout: Path = REPO,
            timeout: float | None = None) -> ChildRun:
    """Run one instrumented CLI subprocess against `root`; a non-zero exit aborts the benchmark."""
    run = run_child(cli_argv(*args), env=cli_env(root, checkout), cwd=str(checkout), stdin=stdin, timeout=timeout)
    if run.returncode != 0:
        raise SystemExit(f'CLI {args[0]} failed ({run.returncode}):\n{run.stdout}\n{run.stderr}')
    return run


def io_summary(groups: list[list[ChildRun]]) -> dict:
    """Median over `groups` of the bytes each group of children moved (a group is one operation).

    Logical and physical are reported side by side and never substituted for one another; each
    carries the name of its source. A group's total for a section exists only when *every* child in
    the group reported that section: a group with a silent child (no report, truncated report, or a
    platform without that source) is incomplete and contributes nothing, so a two-child operation is
    never presented as the bytes of its one reporting child. The median is over the complete groups;
    `groups`/`complete_groups` give the count and `partial` is True when any group was dropped. A
    section is None when no group reported it completely.
    """
    def total(group: list[ChildRun], section: str) -> tuple[int, int] | None:
        if not group or any(not run.io or not isinstance(run.io.get(section), dict) for run in group): return None
        return sum(run.io[section]['read_bytes'] for run in group), sum(run.io[section]['write_bytes'] for run in group)

    def section(name: str, default_source: str | None = None) -> dict | None:
        totals = [t for t in (total(g, name) for g in groups) if t is not None]
        if not totals: return None
        source = default_source or next((run.io[name].get('source') for g in groups for run in g if run.io and isinstance(run.io.get(name), dict)), None)
        return {'read_bytes': int(statistics.median(r for r, _ in totals)), 'write_bytes': int(statistics.median(w for _, w in totals)),
                'source': source, 'groups': len(groups), 'complete_groups': len(totals), 'partial': len(totals) < len(groups)}

    return {'logical': section('python_file_io', LOGICAL_SOURCE), 'kernel_logical': section('kernel_logical'), 'physical': section('physical'),
            'rusage_blocks': {'in': max((run.ru_inblock for g in groups for run in g), default=0),
                              'out': max((run.ru_oublock for g in groups for run in g), default=0), 'source': 'os.wait4 ru_inblock/ru_oublock (0 on macOS)'}}


def batch_records(tag: str, size: int) -> list[dict]:
    """`size` fresh records that touch all three streams (one run boundary)."""
    rid = f'bench-{tag}'
    records = [{'stream': 'event', 'record_id': f'{rid}-start', 'event': 'run_started', 'run_id': rid}]
    for k in range(max(0, size - 2)):
        records.append({'stream': 'metric', 'record_id': f'{rid}-m{k}', 'event': 'model_call', 'run_id': rid, 'task_id': f'{rid}-T{k}',
                        'role': 'worker', 'capability_class': 'implementation_fast', 'model': 'anthropic/claude-sonnet-4-5',
                        'input_tokens': 1200, 'output_tokens': 300, 'cost_usd': .012, 'cost_source': 'reported', 'task_class': 'crud',
                        'complexity': 3, 'risk': 'low'})
    records.append({'stream': 'outcome', 'record_id': f'{rid}-o', 'run_id': rid, 'task_id': 'run-complete', 'note': '{"retries":0}'})
    return records[:size] if size >= 2 else records[:1]


def copy_fixture(source: Path, root: Path, scale: int) -> dict[str, int]:
    """Copy the three streams of `source` into `root`, replicated `scale` times with re-suffixed ids."""
    root.mkdir(parents=True, exist_ok=True); counts = {}
    for name in STREAMS:
        src = source / name; n = 0
        with (root / name).open('wb') as out:
            if not src.exists(): counts[name] = 0; continue
            for copy in range(scale):
                with src.open('rb') as f:
                    for line in f:
                        if not line.endswith(b'\n'): break
                        if copy == 0: out.write(line); n += 1; continue
                        try: row = json.loads(line)
                        except ValueError: continue
                        if not isinstance(row, dict): continue
                        for field in ID_FIELDS:
                            if isinstance(row.get(field), str): row[field] = f'{row[field]}#{copy}'
                        out.write((json.dumps(row, sort_keys=True) + '\n').encode('utf-8')); n += 1
        counts[name] = n
    return counts


def measure(root: Path, scale: int, args: argparse.Namespace, tag: str) -> dict:
    from orchestrator.economics import cost_attribution
    from orchestrator.run_evidence import evidence_coverage, summarize_runs
    from orchestrator.runtime import iter_jsonl

    size = args.batch_size
    checkout = args.checkout
    cli = partial(run_cli, checkout=checkout)
    legacy_timeout = legacy_process_timeout(size * args.repeat)
    # Freeze input accounting before any workload contaminates it with synthetic billing rows.
    rows = {}; fixture_bytes = {}; digests = {}
    for name in STREAMS:
        digest = hashlib.sha256(); count = 0
        with (root / name).open('rb') as stream:
            for line in stream:
                digest.update(line); count += 1
        rows[name] = count; digests[name] = digest.hexdigest()
        fixture_bytes[name] = (root / name).stat().st_size
    evidence = evidence_coverage(summarize_runs(iter_jsonl(root / 'metrics.jsonl'),
                                               iter_jsonl(root / 'events.jsonl'), iter_jsonl(root / 'outcomes.jsonl')))
    evidence['priced_call_coverage'] = ((evidence['call_rows'] - evidence['unmetered_calls']) / evidence['call_rows']
                                        if evidence['call_rows'] else None)
    billing = cost_attribution(iter_jsonl(root / 'metrics.jsonl'))
    cold = cli(root, 'batch', json.dumps(batch_records(f'{tag}-warm', size)))
    batch = [cli(root, 'batch', json.dumps(batch_records(f'{tag}-{i}', size))) for i in range(args.repeat)]
    dash = [cli(root, 'dashboard') for _ in range(args.repeat)]
    single: list[list[ChildRun]] = []
    for i in range(args.repeat):
        group = []
        for record in batch_records(f'{tag}-single-{i}', size):
            stream = record.pop('stream')
            if stream == 'event': group.append(cli(root, 'event', record.pop('event'), json.dumps(record), timeout=legacy_timeout))
            else: group.append(cli(root, stream, json.dumps(record), timeout=legacy_timeout))
        single.append(group)
    engine = []
    program = '''
import sys
from orchestrator.dashboard import generate_dashboard
from orchestrator.engine import OrchestrationEngine
def on_change():
    generate_dashboard(engine.state_root, config=engine.config)
engine = OrchestrationEngine(on_change=on_change)
engine.complete_run(sys.argv[1])
engine.record_model_call(run_id=sys.argv[1], model='benchmark-unpriced', input_tokens=5)
'''
    for i in range(args.repeat):
        run = run_child(instrumented_argv(program, f'{tag}-engine-{i}'),
                        env=cli_env(root, checkout), cwd=str(checkout))
        if run.returncode != 0:
            raise SystemExit(f'Engine boundary failed ({run.returncode}):\n{run.stdout}\n{run.stderr}')
        engine.append(run)
    med_batch = statistics.median(r.elapsed_s for r in batch); med_dash = statistics.median(r.elapsed_s for r in dash)
    med_single = statistics.median(sum(r.elapsed_s for r in group) for group in single)
    peak = lambda runs: round(rss_mib(max(r.ru_maxrss for r in runs)), 1)  # noqa: E731
    median_peak = lambda groups: round(statistics.median(rss_mib(max(r.ru_maxrss for r in g)) for g in groups), 1)  # noqa: E731
    return {
        'scale': f'{scale}x', 'rows': rows, 'fixture_bytes': fixture_bytes, 'fixture_sha256': digests,
        'input_evidence': evidence, 'input_billing_including_sessions': billing,
        'cold_first_batch': {'elapsed_s': round(cold.elapsed_s, 3), 'peak_rss_mib': peak([cold]), 'io': io_summary([[cold]])},
        'batch': {'subprocesses': 1, 'records': size, 'median_s': round(med_batch, 4), 'peak_rss_mib': peak(batch),
                  'median_peak_rss_mib': median_peak([[r] for r in batch]),
                  'records_per_s': round(size / med_batch, 2), 'io': io_summary([[r] for r in batch])},
        'dashboard': {'subprocesses': 1, 'median_s': round(med_dash, 4), 'peak_rss_mib': peak(dash),
                      'median_peak_rss_mib': median_peak([[r] for r in dash]),
                      'refreshes_per_s': round(1 / med_dash, 2), 'io': io_summary([[r] for r in dash])},
        'per_record_legacy': {'subprocesses': size, 'records': size, 'median_s': round(med_single, 4),
                              'peak_rss_mib': peak([r for group in single for r in group]), 'records_per_s': round(size / med_single, 2),
                              'median_peak_rss_mib': median_peak(single), 'io': io_summary(single)},
        'engine_boundary': {'subprocesses': 1, 'records': 2,
                            'median_s': round(statistics.median(r.elapsed_s for r in engine), 4),
                            'peak_rss_mib': peak(engine), 'median_peak_rss_mib': median_peak([[r] for r in engine]),
                            'io': io_summary([[r] for r in engine])},
        'total_subprocesses': 1 + 3 * args.repeat + sum(len(group) for group in single),
    }


def assert_equivalent_roots(before: Path, after: Path) -> dict:
    """Abort measurement on lost/changed records or changed common derived accounting.

    New evidence/route fields intentionally differ from the pre-program implementation;
    this gate checks common accounting, not equality of corrected semantic diagnostics.
    """
    from orchestrator.runtime import read_json
    for name in STREAMS:
        if (before/name).read_bytes() != (after/name).read_bytes():
            raise ValueError(f'canonical bytes differ: {name}')
    ledgers=[read_json(root/'ledger.json',{}) for root in (before,after)]
    for key in ('runs','tasks','decisions','workstreams','locks','artifacts','verification','repo_revision','adaptive'):
        if ledgers[0].get(key) != ledgers[1].get(key): raise ValueError(f'ledger differs: {key}')
    pages=[json.JSONDecoder().raw_decode((root/'dashboard.html').read_text().split('const D=',1)[1])[0] for root in (before,after)]
    for key in ('event_count','metric_count'):
        if pages[0][key] != pages[1][key]: raise ValueError(f'dashboard differs: {key}')
    for key in ('total_cost','waste_cost','conflicts'):
        if pages[0]['summary'][key] != pages[1]['summary'][key]: raise ValueError(f'dashboard accounting differs: {key}')
    for key in ('by_role','by_runtime','interactive_sessions'):
        if pages[0][key] != pages[1][key]: raise ValueError(f'dashboard accounting differs: {key}')
    return {'canonical_bytes':True,'ledger':True,'dashboard_accounting':True,
            'scope':'all canonical bytes; ledger entities; dashboard counts, total/waste cost, conflicts, role/runtime/session aggregates; corrected evidence/routes excluded'}


def compare_legacy(source: Path, scale: int, args: argparse.Namespace) -> dict:
    """Same input and records, old per-record CLI versus final batch; alternating trial order."""
    from orchestrator.economics import cost_attribution
    from orchestrator.run_evidence import evidence_coverage, summarize_runs
    from orchestrator.runtime import iter_jsonl
    groups={'before':[], 'after':[]}
    with tempfile.TemporaryDirectory(prefix='orchestrator-legacy-compare-') as tmp:
        roots={side:Path(tmp,side) for side in groups}
        for root in roots.values(): copy_fixture(source,root,scale)
        hashes={name:hashlib.sha256((roots['before']/name).read_bytes()).hexdigest() for name in STREAMS}
        sizes={name:(roots['before']/name).stat().st_size for name in STREAMS}
        legacy_timeout = legacy_process_timeout(compare_legacy_process_count(scales=1, repeat=args.repeat, batch_size=args.batch_size))
        root=roots['before']
        evidence=evidence_coverage(summarize_runs(iter_jsonl(root/'metrics.jsonl'),iter_jsonl(root/'events.jsonl'),iter_jsonl(root/'outcomes.jsonl')))
        billing=cost_attribution(iter_jsonl(root/'metrics.jsonl'))
        cold={}
        # First trial is cold; both roots then have identical warm history for each trial.
        for trial in range(args.repeat+1):
            records=batch_records(f'paired-{trial}',args.batch_size)
            for record in records: record['ts']='2026-09-23T00:00:00+00:00'
            for side in (('before','after') if trial%2==0 else ('after','before')):
                root=roots[side]; runs=[]
                if side=='after':
                    runs.append(run_cli(root,'batch','-',stdin=json.dumps(records),checkout=args.checkout))
                else:
                    for record in records:
                        payload=dict(record); stream=payload.pop('stream')
                        command=[stream]
                        if stream=='event': command.append(payload.pop('event'))
                        runs.append(run_cli(root,*command,json.dumps(payload),checkout=args.compare_legacy,timeout=legacy_timeout))
                if trial==0: cold[side]=runs
                else: groups[side].append(runs)
            equivalence=assert_equivalent_roots(roots['before'],roots['after'])
        def summary(trials):
            seconds=statistics.median(sum(r.elapsed_s for r in group) for group in trials)
            return {'subprocesses':len(trials[0]),'median_s':round(seconds,4),
                    'median_peak_rss_mib':round(statistics.median(max(rss_mib(r.ru_maxrss) for r in group) for group in trials),1),
                    'records_per_s':round(args.batch_size/seconds,2),'io':io_summary(trials)}
        return {'scale':f'{scale}x','fixture_sha256':hashes,'fixture_bytes':sizes,'input_evidence':evidence,
                'input_billing_including_sessions':billing,'equivalence':equivalence,
                'before':summary(groups['before']),'after':summary(groups['after']),
                'cold':{side:summary([runs]) for side,runs in cold.items()}}


def _mib(n: int | None) -> str:
    return '—' if n is None else f'{n / 2 ** 20:.2f}'


def _io_cells(io: dict) -> str:
    def cell(section: dict | None, key: str) -> str:
        if section is None: return '—'
        return _mib(section[key]) + ('*' if section.get('partial') else '')

    logical, physical = io['logical'], io['physical']
    return (f"{cell(logical, 'read_bytes')} / {cell(logical, 'write_bytes')} | "
            f"{cell(physical, 'read_bytes')} / {cell(physical, 'write_bytes')}")


def main() -> None:
    from tests.test_dashboard_refresh import write_synthetic_history  # lazy: children and tests must not pay for it
    from orchestrator.records import json_default  # `records.NO_DATA` (e.g. billing coverage of an empty fixture) -> null, never 0

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--runs', type=int, default=500, help='synthetic runs at 1x (~12 events, ~12 metrics, ~5 outcomes each)')
    ap.add_argument('--scales', default='1,2,4'); ap.add_argument('--repeat', type=int, default=5)
    ap.add_argument('--batch-size', type=int, default=5); ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--source', type=Path, default=None, help='copy this root\'s JSONL streams into the temp fixture instead of synthesizing')
    ap.add_argument('--checkout', type=Path, default=REPO, help='Python code checkout to measure (same driver for before/after)')
    ap.add_argument('--compare-legacy', type=Path, help='old checkout without batch: compare its per-record CLI to --checkout batch on identical copied inputs (requires --source --json)')
    ap.add_argument('--json', action='store_true', help='print one JSON document instead of a table')
    args = ap.parse_args()
    try: scales = [int(s) for s in args.scales.split(',') if s.strip()]
    except ValueError: ap.error('--scales must be comma-separated positive integers')
    from orchestrator.record_batch import MAX_BATCH_RECORDS
    if not scales or any(s < 1 for s in scales): ap.error('--scales must be positive')
    if args.runs < 1 or args.repeat < 1: ap.error('--runs and --repeat must be positive')
    if not 1 <= args.batch_size <= MAX_BATCH_RECORDS: ap.error(f'--batch-size must be 1..{MAX_BATCH_RECORDS}')
    args.checkout = args.checkout.expanduser().resolve()
    for module in ('cli', 'engine'):  # both workloads' child entry points; fail before any workload runs
        if not (args.checkout / f'orchestrator/{module}.py').is_file(): ap.error(f'--checkout must contain orchestrator/{module}.py')
    if args.source is not None:
        args.source = args.source.expanduser().resolve()
        if not args.source.is_dir() or not any((args.source / n).is_file() for n in STREAMS):
            ap.error('--source must be a copied root containing JSONL streams')
    if args.compare_legacy is not None:
        args.compare_legacy=args.compare_legacy.expanduser().resolve()
        if not (args.compare_legacy/'orchestrator/cli.py').is_file(): ap.error('--compare-legacy must contain orchestrator/cli.py')
        if args.source is None or not args.json: ap.error('--compare-legacy requires --source and --json')
        results=[compare_legacy(args.source,scale,args) for scale in scales]
        print(json.dumps({'meta':{'before':str(args.compare_legacy),'after':str(args.checkout),'repeat':args.repeat,
                                 'python':sys.version.split()[0],'platform':sys.platform,'order':'alternating; cold excluded',
                                 'scope':'copied fixture; old per-record vs final batch; no model spend or causal savings claim'},
                          'results':results},indent=2,default=json_default))
        return
    results = []
    with tempfile.TemporaryDirectory(prefix='orchestrator-bench-') as tmp:
        for scale in scales:
            root = Path(tmp, f'{scale}x')
            if args.source is not None: copy_fixture(args.source.expanduser(), root, scale)
            else: write_synthetic_history(root, runs=args.runs * scale, seed=args.seed)
            results.append(measure(root, scale, args, tag=f'{scale}x'))
            shutil.rmtree(root, ignore_errors=True)
    meta = {'python': sys.version.split()[0], 'platform': sys.platform, 'repeat': args.repeat, 'batch_size': args.batch_size,
            'checkout': str(args.checkout), 'driver': str(REPO),
            'coverage_scope': 'input only; run evidence excludes interactive sessions; billing includes them',
            'fixture': 'copy of ' + str(args.source) if args.source else f'synthetic runs={args.runs} seed={args.seed}',
            'io': {'logical': LOGICAL_SOURCE, 'physical': next((r['batch']['io']['physical']['source'] for r in results if r['batch']['io']['physical']), None)}}
    if args.json:
        print(json.dumps({'meta': meta, 'results': results}, indent=2, default=json_default)); return
    print(f"# refresh benchmark — {meta['fixture']} — python {meta['python']} {meta['platform']} — repeat={args.repeat} batch={args.batch_size}")
    print(f"# checkout: {meta['checkout']}; use --json for input hashes and billing/duration/verification coverage")
    print(f"# logical bytes: {meta['io']['logical']}; physical bytes: {meta['io']['physical'] or 'unavailable on this platform'}")
    print('# * = partial: some repetitions had a child without a complete I/O report and were excluded from that median')
    print('| scale | metrics rows / fixture MB | op | subprocesses | median s | peak child RSS MiB | throughput | logical MiB read / written | physical MiB read / written |')
    print('|---|---:|---|---:|---:|---:|---:|---:|---:|')
    for r in results:
        rows = f"{r['rows']['metrics.jsonl']} / {r['fixture_bytes']['metrics.jsonl'] / 1e6:.1f}"
        b, d, s, c = r['batch'], r['dashboard'], r['per_record_legacy'], r['cold_first_batch']
        print(f"| {r['scale']} | {rows} | batch ({b['records']} rec) | {b['subprocesses']} | {b['median_s']:.3f} | {b['peak_rss_mib']:.1f} | {b['records_per_s']:.1f} rec/s | {_io_cells(b['io'])} |")
        print(f"| {r['scale']} | {rows} | dashboard | {d['subprocesses']} | {d['median_s']:.3f} | {d['peak_rss_mib']:.1f} | {d['refreshes_per_s']:.2f} refresh/s | {_io_cells(d['io'])} |")
        print(f"| {r['scale']} | {rows} | per-record legacy ({s['records']} rec) | {s['subprocesses']} | {s['median_s']:.3f} | {s['peak_rss_mib']:.1f} | {s['records_per_s']:.1f} rec/s | {_io_cells(s['io'])} |")
        e = r['engine_boundary']
        print(f"| {r['scale']} | {rows} | engine boundary + next call | 1 | {e['median_s']:.3f} | {e['peak_rss_mib']:.1f} | — | {_io_cells(e['io'])} |")
        print(f"| {r['scale']} | {rows} | cold first batch | 1 | {c['elapsed_s']:.3f} | {c['peak_rss_mib']:.1f} | — | {_io_cells(c['io'])} |")


if __name__ == '__main__':
    main()
