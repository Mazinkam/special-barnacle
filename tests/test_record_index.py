"""Round-4 regressions: cache tampering never changes canonical membership."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

from orchestrator import record_batch
from orchestrator.record_index import DATABASE_FILE, RecordIndex, encode_key
from orchestrator.runtime import EventStore, read_json
from orchestrator.state import rebuild
from tests import record_io_probe
from tests.record_io_probe import IoMeterUnsupported, measure_io
from tests.test_record_batch import (TemporaryRootTestCase, _checkpoint_snapshot, _completed_run, _fill_streams,
    _forge_index_with_stream_access, _fsync_by_inode, run_batch, sample_batch, cli_env, stream_ids, strip_volatile)


def _require_io_meter(case):
    """Skip only when the native SQLite VFS hook is genuinely unsupported here; never measure partially."""
    reason = record_io_probe.unsupported_reason()
    if reason:
        case.skipTest(f'record_io_probe unsupported on this interpreter: {reason}')


_REFRESHLESS_CHILD = '''
import json, sys
from orchestrator import record_batch
result = record_batch.write_batch(sys.argv[1], json.loads(sys.stdin.read()), refresh=False)
print(json.dumps({k: v for k, v in result.items() if k != 'records'}))
'''


def _write_in_child(root: Path, records: list) -> dict:
    """A fresh process (fresh cache load) running only the durable writer, not the dashboard."""
    child = subprocess.run([sys.executable, '-B', '-c', _REFRESHLESS_CHILD, str(root)], input=json.dumps(records),
        text=True, capture_output=True, env=cli_env(root), timeout=60)
    assert child.returncode == 0, child.stderr
    return json.loads(child.stdout)


_CRASH_SWEEP_CHILD = '''
import json, os, sys
from orchestrator import record_batch
from orchestrator.record_index import RecordIndex
step = int(sys.argv[2]); ticks = [0]
def tick():
    ticks[0] += 1
    if ticks[0] == step:
        os._exit(9)
def hook(fn, *, after=False):
    def wrapped(*args, **kwargs):
        if not after: tick()
        result = fn(*args, **kwargs)
        if after: tick()
        return result
    return wrapped
os.write = hook(os.write); os.fsync = hook(os.fsync)
RecordIndex.add = hook(RecordIndex.add)
RecordIndex.commit = hook(hook(RecordIndex.commit), after=True)
record_batch._write_checkpoint = hook(record_batch._write_checkpoint, after=True)
record_batch.replay_ledger = hook(hook(record_batch.replay_ledger), after=True)
result = record_batch.write_batch(sys.argv[1], json.loads(sys.stdin.read()))
assert result['ok'], result
print(ticks[0])
'''


def _crash_write_at_step(root: Path, records: list, step: int) -> tuple[int, int]:
    """Run write_batch in a real child that hard-exits (no rollback, no cleanup) at the `step`-th durable I/O step.

    Steps are every stream/receipt/directory write and fsync, every cache insert, and the cache
    commit, receipt publication and ledger publication boundaries. Returns ``(exit_status, total_steps)``:
    exit 9 = crashed at `step`; exit 0 = completed, with `total_steps` the number of steps the write has.
    """
    child = subprocess.run([sys.executable, '-B', '-c', _CRASH_SWEEP_CHILD, str(root), str(step)],
        input=json.dumps(records), text=True, capture_output=True, env=cli_env(root), timeout=60)
    total = int(child.stdout.strip()) if child.returncode == 0 else 0
    return child.returncode, total


class ExactIndexTests(TemporaryRootTestCase):
    def test_io_meter_counts_fdopen_writes_once(self):
        _require_io_meter(self)
        self.root.mkdir()
        with measure_io() as counts:
            (self.root / 'path').write_bytes(b'a' * 128)
            fd = os.open(self.root / 'descriptor', os.O_CREAT | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(b'b' * 128)
        self.assertEqual(counts['write'], 256)

    def test_missing_truncated_and_replaced_cache_never_changes_rows(self):
        _completed_run(self)
        cache = self.root / DATABASE_FILE
        original = cache.read_bytes()
        before = {s: (self.root / name).read_bytes() for s, name in record_batch.STREAMS.items()}
        for fault in ('empty', 'partial', 'garbage', 'missing', 'old-copy', 'old-copy-and-receipt'):
            with self.subTest(fault):
                receipt = (self.root / record_batch.CHECKPOINT_FILE).read_bytes()
                if fault == 'missing':
                    cache.unlink()
                elif fault == 'old-copy':
                    replacement = self.root / 'replacement'
                    replacement.write_bytes(original)
                    replacement.replace(cache)
                elif fault == 'old-copy-and-receipt':
                    cache.write_bytes(original)
                    (self.root / record_batch.CHECKPOINT_FILE).write_bytes(receipt)
                else:
                    cache.write_bytes({'empty': b'', 'partial': original[:7000], 'garbage': b'not sqlite'}[fault])
                retry = run_batch(self.root, sample_batch())
                self.assertEqual(retry.returncode, 0, retry.stderr)
                self.assertEqual(json.loads(retry.stdout)['duplicates'], {'event': 3, 'metric': 1, 'outcome': 1})
                for stream, name in record_batch.STREAMS.items():
                    self.assertEqual((self.root / name).read_bytes(), before[stream])
                self.assertEqual(read_json(self.root / 'ledger.json', {})['runs']['R1']['status'], 'completed')

    def test_forged_metric_presence_cannot_drop_cost(self):
        _completed_run(self)
        db = sqlite3.connect(self.root / DATABASE_FILE)
        db.execute('INSERT INTO ids VALUES (?, ?)', ('metric', encode_key('ghost')))
        db.commit(); db.close()
        result = record_batch.write_batch(self.root, [{'stream': 'metric', 'record_id': 'ghost', 'cost_usd': 7}], refresh=False)
        self.assertEqual(result['persisted']['metric'], 1)
        self.assertEqual(stream_ids(self.root, 'metric'), ['m-1', 'ghost'])

    def test_unique_index_and_receipt_loss_recover_from_jsonl(self):
        _completed_run(self)
        db = sqlite3.connect(self.root / DATABASE_FILE)
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('INSERT INTO ids VALUES (?, ?)', ('metric', encode_key('m-1')))
        finally:
            db.close()
        (self.root / record_batch.CHECKPOINT_FILE).unlink()
        retry = run_batch(self.root, sample_batch())
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(json.loads(retry.stdout)['duplicates'], {'event': 3, 'metric': 1, 'outcome': 1})

    def test_legacy_v4_predictable_tail_membership_is_never_imported(self):
        _completed_run(self)
        from orchestrator.runtime import tail_fingerprint
        # Old-shaped metadata can accurately describe every boundary yet omit all IDs.
        streams = {s: {'size': (self.root / name).stat().st_size, 'ids': [],
                       'audited_size': (self.root / name).stat().st_size,
                       'binding': tail_fingerprint(self.root / name, (self.root / name).stat().st_size)}
                   for s, name in record_batch.STREAMS.items()}
        (self.root / record_batch.CHECKPOINT_FILE).write_text(json.dumps({'format_version': 4, 'streams': streams}))
        (self.root / DATABASE_FILE).unlink()
        retry = run_batch(self.root, sample_batch())
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(json.loads(retry.stdout)['duplicates'], {'event': 3, 'metric': 1, 'outcome': 1})
        self.assertEqual(stream_ids(self.root, 'metric'), ['m-1'])

    def test_crashes_during_index_transaction_and_after_commit_are_idempotent(self):
        for stage in ('transaction', 'committed', 'receipt'):
            with self.subTest(stage), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                self.assertTrue(record_batch.write_batch(root, sample_batch())['ok'])
                records = [{'stream': 'event', 'record_id': 'done', 'event': 'run_completed', 'run_id': 'R1'},
                           {'stream': 'metric', 'record_id': 'cost', 'cost_usd': 3}]
                script = '''
import json, os, sys
from orchestrator import record_batch
from orchestrator.record_index import RecordIndex
stage = sys.argv[2]
original = RecordIndex.commit
def crash_commit(self):
    if stage == 'committed': original(self)
    os._exit(9)
if stage in ('transaction', 'committed'):
    RecordIndex.commit = crash_commit
else:
    original_checkpoint = record_batch._write_checkpoint
    def crash_receipt(*args):
        original_checkpoint(*args)
        os._exit(9)
    record_batch._write_checkpoint = crash_receipt
record_batch.write_batch(sys.argv[1], json.loads(sys.stdin.read()))
'''
                crashed = subprocess.run([sys.executable, '-B', '-c', script, str(root), stage],
                    input=json.dumps(records), text=True, capture_output=True, env=cli_env(root), timeout=60)
                self.assertEqual(crashed.returncode, 9, crashed.stderr)
                before = {s: (root / name).read_bytes() for s, name in record_batch.STREAMS.items()}
                retry = run_batch(root, records)
                self.assertEqual(retry.returncode, 0, retry.stderr)
                self.assertEqual(json.loads(retry.stdout)['duplicates'], {'event': 1, 'metric': 1, 'outcome': 0})
                for stream, name in record_batch.STREAMS.items():
                    self.assertEqual((root / name).read_bytes(), before[stream])
                self.assertEqual(read_json(root / 'ledger.json', {})['runs']['R1']['status'], 'completed')

    def test_crash_at_every_durable_step_is_recovered_by_same_id_retry(self):
        """Sweep every instrumented crash point instead of hand-picked ones; retry must converge without duplicates."""
        records = [{'stream': 'event', 'record_id': 'done', 'event': 'run_completed', 'run_id': 'R1'},
                   {'stream': 'metric', 'record_id': 'cost', 'cost_usd': 3}]

        def seeded_root(tmp: str) -> Path:
            root = Path(tmp)
            self.assertTrue(record_batch.write_batch(root, sample_batch())['ok'])
            return root

        with tempfile.TemporaryDirectory() as tmp:
            status, total_steps = _crash_write_at_step(seeded_root(tmp), records, step=0)
        self.assertEqual(status, 0)
        self.assertGreaterEqual(total_steps, 12, 'too few durable steps are instrumented for the sweep to mean anything')
        for step in range(1, total_steps + 1):
            with self.subTest(step=step), tempfile.TemporaryDirectory() as tmp:
                root = seeded_root(tmp)
                status, _ = _crash_write_at_step(root, records, step)
                self.assertEqual(status, 9, f'child did not crash at step {step}')
                retry = record_batch.write_batch(root, records)
                self.assertTrue(retry['ok'], retry)
                for stream in ('event', 'metric'):
                    self.assertEqual(retry['persisted'][stream] + retry['duplicates'][stream], 1, (step, retry))
                self.assertEqual(stream_ids(root, 'event'), ['e-1', 'e-2', 'e-3', 'done'], step)
                self.assertEqual(stream_ids(root, 'metric'), ['m-1', 'cost'], step)
                self.assertEqual(read_json(root / 'ledger.json', {})['runs']['R1']['status'], 'completed', step)
                snapshot = _checkpoint_snapshot(root)
                for stream in ('event', 'metric', 'outcome'):
                    self.assertEqual(sorted(snapshot['streams'][stream]['ids']), sorted(stream_ids(root, stream)), (step, stream))
                    self.assertEqual(snapshot['streams'][stream]['size'], (root / record_batch.STREAMS[stream]).stat().st_size, (step, stream))
                self.assertEqual(strip_volatile(read_json(root / 'ledger.json', {})), strip_volatile(rebuild(root)), step)

    def test_process_dies_mid_canonical_write_then_same_id_retry_repairs_tail(self):
        self.assertTrue(record_batch.write_batch(self.root, sample_batch())['ok'])
        record = [{'stream': 'event', 'record_id': 'torn', 'event': 'run_completed', 'run_id': 'R1'}]
        script = '''
import json, os, sys
from orchestrator import record_batch
original = os.write
def torn(fd, data):
    original(fd, data[:len(data)//2])
    os._exit(9)
record_batch.os.write = torn
record_batch.write_batch(sys.argv[1], json.loads(sys.stdin.read()))
'''
        crashed = subprocess.run([sys.executable, '-B', '-c', script, str(self.root)], input=json.dumps(record),
            text=True, capture_output=True, env=cli_env(self.root), timeout=60)
        self.assertEqual(crashed.returncode, 9, crashed.stderr)
        torn = (self.root / 'events.jsonl').read_bytes()
        retry = run_batch(self.root, record)
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(json.loads(retry.stdout)['persisted']['event'], 1)
        self.assertTrue((self.root / 'events.jsonl').read_bytes().startswith(torn))
        self.assertEqual(stream_ids(self.root, 'event'), ['e-1', 'e-2', 'e-3', 'torn'])
        again = run_batch(self.root, record)
        self.assertEqual(json.loads(again.stdout)['duplicates']['event'], 1)
        self.assertEqual(read_json(self.root / 'ledger.json', {})['runs']['R1']['status'], 'completed')

    def test_directory_sync_failure_stops_before_the_next_stream(self):
        import stat
        real_fsync = os.fsync
        # The JSONL bytes alone are not durable until their directory entry is synced.
        def fail_directory(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode) and (self.root / 'events.jsonl').exists():
                raise OSError('directory sync failed')
            return real_fsync(fd)
        with patch('os.fsync', fail_directory):
            with self.assertRaises(record_batch.BatchAppendError) as caught:
                record_batch.write_batch(self.root, sample_batch())
        self.assertEqual(caught.exception.persisted, {'event': 0, 'metric': 0, 'outcome': 0})
        self.assertEqual(stream_ids(self.root, 'metric'), [], 'no later stream before event durability')
        retry = run_batch(self.root, sample_batch())
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(stream_ids(self.root, 'event'), ['e-1', 'e-2', 'e-3'])
        self.assertEqual(stream_ids(self.root, 'metric'), ['m-1'])

    def test_sqlite_commit_failure_reports_durable_counts_and_retry(self):
        with patch.object(RecordIndex, 'commit', side_effect=sqlite3.OperationalError('disk full')):
            result = record_batch.write_batch(self.root, sample_batch())
        self.assertEqual(result['status'], 'checkpoint_failed')
        self.assertEqual(result['persisted'], {'event': 3, 'metric': 1, 'outcome': 1})
        self.assertEqual(result['retry'], 'same_ids')
        retry = run_batch(self.root, sample_batch())
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(json.loads(retry.stdout)['duplicates'], {'event': 3, 'metric': 1, 'outcome': 1})

    def test_fragment_completion_is_seen_after_unrelated_cached_writes(self):
        _completed_run(self)
        events = self.root / 'events.jsonl'
        with events.open('ab') as f:
            f.write(b'{"record_id":"later","event":"run_started","run_id":"R2"')
        for i in range(3):
            record_batch.write_batch(self.root, [{'stream': 'metric', 'record_id': f'more-{i}'}], refresh=False)
        with events.open('ab') as f:
            f.write(b'}')  # complete object, still no newline
        retry = run_batch(self.root, [{'stream': 'event', 'record_id': 'later', 'event': 'run_started', 'run_id': 'R2'}])
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(json.loads(retry.stdout)['duplicates']['event'], 1)
        self.assertTrue(events.read_bytes().endswith(b'\n'))
        self.assertEqual(stream_ids(self.root, 'event').count('later'), 1)

    def test_forged_absence_cannot_replay_stale_run_started(self):
        _completed_run(self)
        before = (self.root / 'events.jsonl').read_bytes()
        _forge_index_with_stream_access(self.root, {'event': ['e-1']})
        retry = run_batch(self.root, [sample_batch()[0]])
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(json.loads(retry.stdout)['duplicates']['event'], 1)
        self.assertEqual((self.root / 'events.jsonl').read_bytes(), before)
        self.assertEqual(read_json(self.root / 'ledger.json', {})['runs']['R1']['status'], 'completed')

    def test_forged_absence_cannot_duplicate_metric_cost(self):
        _completed_run(self)
        before = (self.root / 'metrics.jsonl').read_bytes()
        _forge_index_with_stream_access(self.root, {'metric': ['m-1']})
        retry = run_batch(self.root, [sample_batch()[1]])
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(json.loads(retry.stdout)['duplicates']['metric'], 1)
        self.assertEqual((self.root / 'metrics.jsonl').read_bytes(), before)

    def test_malformed_tail_is_not_rescanned_by_unrelated_writes(self):
        _require_io_meter(self)
        _fill_streams(self.root, 500)
        with (self.root / 'events.jsonl').open('ab') as f:
            f.write(b'{"fragment":"' + b'x' * 2_000_000)
        def probe(i):
            return record_batch.write_batch(self.root, [{'stream': 'metric', 'record_id': f'probe-{i}'}], refresh=False)
        probe(0)  # reconcile the new fragment once
        before = (self.root / 'events.jsonl').read_bytes()
        with measure_io() as counts:
            for i in range(1, 4):
                self.assertTrue(probe(i)['ok'])
        self.assertLess(counts['read'], 150_000, counts)
        self.assertEqual((self.root / 'events.jsonl').read_bytes(), before)

    def test_total_io_per_write_does_not_scale_with_all_ids(self):
        _require_io_meter(self)
        measurements = {}
        for multiplier in (1, 2, 4):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                _fill_streams(root, 4000 * multiplier)
                def probe(i):
                    return record_batch.write_batch(root, [{'stream': 'metric', 'record_id': f'probe-{i}'}], refresh=False)
                probe(0); probe(1)
                with measure_io() as counts:
                    for i in range(2, 7):
                        self.assertTrue(probe(i)['ok'])
                measurements[multiplier] = dict(counts)
        print('TOTAL_IO', measurements)
        for direction in ('read', 'write'):
            self.assertLessEqual(measurements[4][direction], measurements[1][direction] + 100_000, measurements)
        self.assertGreater(measurements[4]['sqlite_read'], 0, 'meter must include SQLite C-level I/O')
        self.assertGreater(measurements[4]['sqlite_write'], 0)


class RemediationTask2BTests(TemporaryRootTestCase):
    """Task 2B: historical IDs the SQLite text binding rejects, and durability of freshly created state roots."""

    def test_historical_lone_surrogate_record_id_never_blocks_writes_and_still_dedups(self):
        self.root.mkdir()
        surrogate = 'old-\ud800'
        historical = {'record_id': surrogate, 'event': 'model_call', 'run_id': 'R0', 'model': 'gpt-4o', 'cost_usd': 1}
        line = json.dumps(historical, sort_keys=True) + '\n'
        self.assertIn('\\ud800', line, 'the old writer escaped the lone surrogate; the file itself is valid ASCII')
        metrics = self.root / 'metrics.jsonl'
        metrics.write_bytes(line.encode('ascii'))
        self.assertEqual(stream_ids(self.root, 'metric'), [surrogate], 'the JSON parser accepts the escaped surrogate')

        ordinary = record_batch.write_batch(self.root, sample_batch(), refresh=False)
        self.assertTrue(ordinary['ok'], ordinary)
        self.assertEqual(ordinary['persisted'], {'event': 3, 'metric': 1, 'outcome': 1})
        self.assertTrue(metrics.read_bytes().startswith(line.encode('ascii')), 'canonical history is untouched')
        self.assertEqual(stream_ids(self.root, 'metric'), [surrogate, 'm-1'])

        # Same-id retry in a fresh process: the historical surrogate id and the ordinary ids all dedup
        # from the committed cache, whose keys must round-trip the exact Python string.
        before = {s: (self.root / name).read_bytes() for s, name in record_batch.STREAMS.items()}
        retry = _write_in_child(self.root, [{'stream': 'metric', **historical}, *sample_batch()])
        self.assertTrue(retry['ok'], retry)
        self.assertEqual(retry['duplicates'], {'event': 3, 'metric': 2, 'outcome': 1})
        self.assertEqual(retry['persisted'], {'event': 0, 'metric': 0, 'outcome': 0})
        for stream, name in record_batch.STREAMS.items():
            self.assertEqual((self.root / name).read_bytes(), before[stream], stream)
        self.assertEqual(sorted(_checkpoint_snapshot(self.root)['streams']['metric']['ids']), sorted([surrogate, 'm-1']))

        # A new id with a lone surrogate is not rejected: the writer can store, dedup and replay it.
        fresh = {'stream': 'metric', 'record_id': 'fresh-\udfff', 'event': 'model_call', 'run_id': 'R0', 'cost_usd': 2}
        self.assertEqual(record_batch.write_batch(self.root, [fresh], refresh=False)['persisted']['metric'], 1)
        self.assertEqual(_write_in_child(self.root, [fresh])['duplicates']['metric'], 1)
        self.assertEqual(stream_ids(self.root, 'metric'), [surrogate, 'm-1', 'fresh-\udfff'])

    def test_historical_lone_surrogate_event_id_replays_into_the_ledger(self):
        self.root.mkdir()
        events = self.root / 'events.jsonl'
        events.write_bytes((json.dumps({'record_id': 'start-\ud800', 'event': 'run_started', 'run_id': 'R1'}) + '\n').encode('ascii'))
        done = [{'stream': 'event', 'record_id': 'done', 'event': 'run_completed', 'run_id': 'R1'}]
        with patch('orchestrator.record_batch.generate_dashboard'):  # dashboard rendering is outside this writer's contract
            result = record_batch.write_batch(self.root, done)
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['ledger_updated'])
        ledger = read_json(self.root / 'ledger.json', {})
        self.assertEqual(ledger['runs']['R1']['status'], 'completed')
        self.assertEqual(ledger['checkpoint']['events_replayed'], 2)
        self.assertEqual(strip_volatile(rebuild(self.root)), strip_volatile(ledger))
        self.assertEqual(_write_in_child(self.root, done)['duplicates']['event'], 1)

    def test_first_write_makes_every_created_ancestor_directory_durable(self):
        """T exists; T/new/deeper/state is created by the first write. Every new entry must be fsynced up to T."""
        for creator in ('write_batch', 'event_store'):
            with self.subTest(creator=creator), tempfile.TemporaryDirectory() as tmp:
                existing = Path(tmp)
                root = existing / 'new' / 'deeper' / 'state'
                calls: list[int] = []
                with patch('os.fsync', _fsync_by_inode(calls)):
                    if creator == 'write_batch':
                        self.assertTrue(record_batch.write_batch(root, sample_batch(), refresh=False)['ok'])
                    else:
                        EventStore(root).emit('run_started', run_id='R1')
                synced = set(calls)
                for path in (existing, existing / 'new', existing / 'new' / 'deeper', root, root / 'events.jsonl'):
                    self.assertIn(path.stat().st_ino, synced, f'{creator}: {path.relative_to(existing) if path != existing else "T"} was not fsynced')
                self.assertTrue(stream_ids(root, 'event'), 'the acknowledged record is in the stream')

    def _assert_ancestry_synced_before_the_first_record(self, root: Path, calls: list[int]) -> None:
        """Every directory from the real root up to its mount point was fsynced, and all of them before any stream byte."""
        first_record = calls.index((root / 'events.jsonl').stat().st_ino)
        directory = root.resolve(); device = directory.stat().st_dev
        while True:
            inode = directory.stat().st_ino
            self.assertIn(inode, calls, f'{directory} was not fsynced')
            self.assertLess(calls.index(inode), first_record, f'{directory} was first fsynced only after a record byte was')
            if directory.parent == directory or directory.parent.stat().st_dev != device:
                break
            directory = directory.parent

    def test_acknowledgement_syncs_the_whole_ancestry_even_when_someone_else_created_the_directories(self):
        """Reviewer race: another process (or an older writer) created T/new/deeper/state a moment ago and has not
        synced T yet, so this writer finds every directory already existing. Existence is not durability."""
        with tempfile.TemporaryDirectory() as tmp:
            existing = Path(tmp)
            root = existing / 'new' / 'deeper' / 'state'
            os.makedirs(root)  # what the other process's mkdir left in the page cache: present, never fsynced
            calls: list[int] = []
            with patch('os.fsync', _fsync_by_inode(calls)):
                self.assertTrue(record_batch.write_batch(root, sample_batch(), refresh=False)['ok'])
            self._assert_ancestry_synced_before_the_first_record(root, calls)
            self.assertEqual(stream_ids(root, 'event'), ['e-1', 'e-2', 'e-3'])

    def test_retry_after_an_ancestor_fsync_failure_syncs_the_chain_before_acknowledging(self):
        """The first attempt creates the directories but fails to sync T. The retry finds them existing and must
        still sync the whole chain before any record is appended or acknowledged."""
        with tempfile.TemporaryDirectory() as tmp:
            existing = Path(tmp)
            root = existing / 'new' / 'deeper' / 'state'
            failed: list[int] = []
            with patch('os.fsync', _fsync_by_inode(failed, fail_inode=existing.stat().st_ino)):
                with self.assertRaises(record_batch.BatchAppendError) as caught:
                    record_batch.write_batch(root, sample_batch(), refresh=False)
            self.assertEqual(caught.exception.persisted, {'event': 0, 'metric': 0, 'outcome': 0})
            self.assertEqual(caught.exception.retry, record_batch.RETRY_SAME_IDS)
            self.assertTrue(root.is_dir(), 'the directories now exist although T was never synced')
            self.assertFalse((root / 'events.jsonl').exists(), 'no record byte is written before the ancestry is durable')
            calls: list[int] = []
            with patch('os.fsync', _fsync_by_inode(calls)):
                retry = record_batch.write_batch(root, sample_batch(), refresh=False)
            self.assertTrue(retry['ok'], retry)
            self.assertEqual(retry['persisted'], {'event': 3, 'metric': 1, 'outcome': 1})
            self._assert_ancestry_synced_before_the_first_record(root, calls)
            self.assertEqual(stream_ids(root, 'event'), ['e-1', 'e-2', 'e-3'])

    def test_io_meter_refuses_to_report_partial_io_when_the_vfs_hook_is_unavailable(self):
        with patch.object(record_io_probe, '_sqlite_library', side_effect=OSError('no libsqlite3 symbols')):
            with self.assertRaises(IoMeterUnsupported):
                with measure_io():
                    self.fail('the meter must not yield counts without the SQLite hook')
            self.assertIn('no libsqlite3', record_io_probe.unsupported_reason())
        # Hook installs but intercepts nothing (e.g. sqlite3 bound to another library): also unsupported, never partial.
        with patch.object(record_io_probe, '_exercise_sqlite', lambda path: None):
            with self.assertRaises(IoMeterUnsupported):
                with measure_io():
                    self.fail('an un-intercepted hook must not yield counts')
