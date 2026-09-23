"""Reproducible synthetic durable-core benchmark (never accesses live state).

PYTHONDONTWRITEBYTECODE=1 python3 -B -m tests.record_index_benchmark 5000
Run in a fresh process per size/revision. RSS is process high-water, including
fixture setup; times and logical I/O cover only 20 warm write_batch(refresh=False)
calls. I/O includes JSONL, receipt, SQLite database AND rollback journal. Dashboard
and ledger rendering are deliberately excluded from this cache comparison.
"""
import json
import resource
import statistics
import sys
import tempfile
import time
from pathlib import Path

from orchestrator.record_batch import write_batch
from tests.record_io_probe import measure_io
from tests.test_record_batch import _fill_streams


def main():
    rows = int(sys.argv[1])
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _fill_streams(root, rows)
        def probe(i):
            result = write_batch(root, [{'stream': 'metric', 'record_id': f'probe-{i}'}], refresh=False)
            assert result['ok'], result
        probe(0); probe(1)
        # Measure wall time without Python/ctypes instrumentation overhead.
        elapsed = []
        for i in range(2, 22):
            start = time.perf_counter()
            probe(i)
            elapsed.append(1000 * (time.perf_counter() - start))
        with measure_io() as counts:
            for i in range(22, 42): probe(i)
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        print(json.dumps({'rows_per_stream': rows, 'calls': 20,
            'median_ms': round(statistics.median(elapsed), 3),
            'read_bytes_per_call': counts['read'] / 20,
            'write_bytes_per_call': counts['write'] / 20,
            'sqlite_read_per_call': counts['sqlite_read'] / 20,
            'sqlite_write_per_call': counts['sqlite_write'] / 20,
            'process_peak_rss_mib': round(rss / (1024**2 if sys.platform == 'darwin' else 1024), 2)}))


if __name__ == '__main__':
    main()
