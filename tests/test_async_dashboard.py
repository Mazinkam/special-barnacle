"""Eventually-consistent post-write dashboard: coalescing, correctness, crash safety, no deadlock."""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from orchestrator.app import refresh as refresh_module
from orchestrator.app.refresh import SYNC_ENV, refresh_after_write
from orchestrator.presentation import publish
from orchestrator.presentation.dashboard_data import build_data
from orchestrator.record_batch import write_batch

REPO = Path(__file__).resolve().parents[1]


def _event(i):
    return {'stream': 'event', 'record_id': f'e{i}', 'event': 'note'}


def _write(root, i):
    return write_batch(root, [_event(i)], refresh=False)


def _wait(cond, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond(): return
        time.sleep(0.02)
    raise AssertionError('timed out')


def _strip(html):
    return re.sub(r'"generated_at":\s*"[^"]*"', '', html)


@pytest.fixture(autouse=True)
def _async(monkeypatch):
    monkeypatch.delenv(SYNC_ENV, raising=False)


def test_burst_coalesces_into_bounded_renders_and_matches_sync_render(tmp_path):
    counted = []

    def counting(root, config): counted.append(1); return build_data(root, config)

    with patch.object(refresh_module, '_spawn_renderer', lambda *a: None):  # writers never render
        for i in range(25):
            assert refresh_after_write(tmp_path, _write(tmp_path, i), config={})['ok']
    assert counted == [] and not (tmp_path / 'dashboard.html').exists()
    assert publish.render_until_current(tmp_path, {}, build_data=counting) == 1
    assert publish.dashboard_is_current(tmp_path)
    assert publish.render_until_current(tmp_path, {}, build_data=counting) == 0
    assert len(counted) == 1
    page = (tmp_path / 'dashboard.html').read_text()
    publish.generate_dashboard(tmp_path, config={})
    assert _strip((tmp_path / 'dashboard.html').read_text()) == _strip(page)


def test_write_during_render_gets_second_pass_only(tmp_path):
    _write(tmp_path, 0)
    counted = []

    def build(root, config):
        counted.append(1)
        if len(counted) == 1:
            for i in range(1, 6): _write(tmp_path, i)  # burst lands mid-render
        return build_data(root, config)

    assert publish.render_until_current(tmp_path, {}, build_data=build) == 2
    assert publish.dashboard_is_current(tmp_path)


def test_receipt_reflects_version_before_build(tmp_path):
    _write(tmp_path, 0)
    before = publish.stream_version(tmp_path)

    def build(root, config):
        _write(tmp_path, 1)
        return build_data(root, config)

    publish.generate_dashboard(tmp_path, {}, build_data=build)
    receipt = json.loads((tmp_path / 'dashboard.version.json').read_text())
    assert receipt == before and not publish.dashboard_is_current(tmp_path)


def test_failed_render_keeps_old_page_and_receipt_never_ahead(tmp_path):
    _write(tmp_path, 0)
    publish.generate_dashboard(tmp_path, {})
    page, receipt = (tmp_path / 'dashboard.html').read_bytes(), (tmp_path / 'dashboard.version.json').read_bytes()
    _write(tmp_path, 1)

    def boom(d): raise RuntimeError('killed')

    with patch.object(publish, 'render', boom), pytest.raises(RuntimeError):
        publish.render_until_current(tmp_path, {})
    assert (tmp_path / 'dashboard.html').read_bytes() == page
    assert (tmp_path / 'dashboard.version.json').read_bytes() == receipt
    assert publish.render_slot_free(tmp_path)  # lock released, later renders are not blocked
    assert publish.render_until_current(tmp_path, {}) == 1


def test_sigkilled_renderer_leaves_page_and_frees_locks(tmp_path):
    _write(tmp_path, 0)
    publish.generate_dashboard(tmp_path, {})
    page = (tmp_path / 'dashboard.html').read_bytes()
    _write(tmp_path, 1)
    code = ("import sys,time\nfrom orchestrator.presentation import publish\n"
            "def slow(root, config): open(sys.argv[1]+'/started','w').close(); time.sleep(60)\n"
            "publish.render_until_current(sys.argv[1], {}, build_data=slow)\n")
    p = subprocess.Popen([sys.executable, '-c', code, str(tmp_path)], cwd=REPO)
    try:
        _wait(lambda: (tmp_path / 'started').exists())
        assert not publish.render_slot_free(tmp_path)
        p.send_signal(signal.SIGKILL); p.wait()
    finally:
        p.kill()
    assert (tmp_path / 'dashboard.html').read_bytes() == page
    assert publish.render_slot_free(tmp_path)
    assert publish.render_until_current(tmp_path, {}) == 1
    assert publish.dashboard_is_current(tmp_path)


def test_concurrent_writers_end_to_end_converge_without_deadlock(tmp_path):
    def writer(base):
        for i in range(base, base + 8):
            assert refresh_after_write(tmp_path, _write(tmp_path, i), config={})['ok']

    threads = [threading.Thread(target=writer, args=(b,)) for b in (0, 100, 200, 300)]
    for t in threads: t.start()
    for t in threads: t.join(60)
    assert not any(t.is_alive() for t in threads)
    _wait(lambda: publish.dashboard_is_current(tmp_path) and publish.render_slot_free(tmp_path))
    page = (tmp_path / 'dashboard.html').read_text()
    publish.generate_dashboard(tmp_path, config={})
    assert _strip((tmp_path / 'dashboard.html').read_text()) == _strip(page)


def test_sync_env_renders_inside_write_and_dashboard_command_always_renders(tmp_path, monkeypatch):
    monkeypatch.setenv(SYNC_ENV, '1')
    result = refresh_after_write(tmp_path, _write(tmp_path, 0), config={})
    assert result['dashboard_updated'] and publish.dashboard_is_current(tmp_path)
    renders = []
    real = publish.render
    with patch.object(publish, 'render', lambda d: renders.append(1) or real(d)):
        publish.generate_dashboard(tmp_path, config={})
    assert renders == [1]


def test_write_landing_after_in_lock_check_is_not_lost(tmp_path):
    """Lost wakeup: the renderer finds the page current *under* the slot lock, then a write lands and its
    writer probes the (still held) slot and skips spawning. The renderer must re-check after release."""
    _write(tmp_path, 0)
    real, calls = publish.dashboard_is_current, []

    def racing(root):
        calls.append(1)
        if len(calls) == 2:  # the in-lock check: another renderer just published, then a write lands
            publish.generate_dashboard(tmp_path, {})
            current = real(root)
            _write(tmp_path, 1)
            assert not publish.render_slot_free(tmp_path)  # so that writer's refresh spawns nothing
            return current
        return real(root)

    with patch.object(publish, 'dashboard_is_current', racing):
        publish.render_until_current(tmp_path, {})
    assert publish.dashboard_is_current(tmp_path)


def test_relative_state_root_renders_the_callers_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    rel = Path('state')
    assert refresh_after_write(rel, _write(rel, 0), config={})['ok']
    _wait(lambda: publish.dashboard_is_current(tmp_path / 'state') and publish.render_slot_free(tmp_path / 'state'), 20)


def test_detached_render_failure_is_reported_by_the_next_write_until_a_render_succeeds(tmp_path):
    """Sync mode reports a failed render as refresh_failed (exit 3); async must not hide it forever."""
    site = tmp_path / 'site'; site.mkdir(); flag = tmp_path / 'fail'; flag.touch()
    (site / 'sitecustomize.py').write_text(
        f"import os, sys\nsys.path.insert(0, {str(REPO)!r})\n"
        "from orchestrator.presentation import dashboard_data as d\n_real = d.build_data\n"
        f"def boom(root, config):\n    if os.path.exists({str(flag)!r}): raise RuntimeError('render exploded')\n"
        "    return _real(root, config)\nd.build_data = boom\n")
    state = tmp_path / 'state'; err = state / publish.RENDER_ERROR
    env = {k: v for k, v in os.environ.items() if k != SYNC_ENV}
    env.update(PYTHONPATH=str(site), CODING_AGENT_ORCHESTRATOR_HOME=str(state))

    def event(i):
        out = subprocess.run([sys.executable, '-m', 'orchestrator.cli', 'event', 'note', json.dumps({'record_id': f'r{i}'})],
                             cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
        return out.returncode, json.loads(out.stdout)

    assert event(0)[0] == 0  # the failure happens later, in the child
    _wait(lambda: err.exists(), 20)
    code, body = event(1)
    assert code == 3 and body['status'] == 'refresh_failed' and 'render exploded' in body['error']
    assert body['retry'] == 'same_ids' and body['persisted']['event'] == 1  # records are still durable
    flag.unlink()  # the cause goes away; any successful render (here in-process, or a retried child) clears it
    _wait(lambda: publish.render_until_current(state, {}) >= 0 and publish.render_slot_free(state)
          and publish.dashboard_is_current(state) and not err.exists(), 30)
    assert event(2)[0] == 0


def test_cli_write_with_captured_pipes_returns_before_slow_render(tmp_path):
    """A hook/CI caller using capture_output must not wait for the detached renderer (no inherited pipes)."""
    site = tmp_path / 'site'; site.mkdir()
    (site / 'sitecustomize.py').write_text(  # inherited by the detached child through PYTHONPATH
        f"import sys, time\nsys.path.insert(0, {str(REPO)!r})\n"
        "from orchestrator.presentation import dashboard_data as d\n_real = d.build_data\n"
        "def slow(root, config): time.sleep(4); return _real(root, config)\nd.build_data = slow\n")
    state = tmp_path / 'state'
    env = {k: v for k, v in os.environ.items() if k != SYNC_ENV}
    env.update(PYTHONPATH=str(site), CODING_AGENT_ORCHESTRATOR_HOME=str(state))
    t0 = time.monotonic()
    out = subprocess.run([sys.executable, '-m', 'orchestrator.cli', 'event', 'note', '{"record_id":"r1"}'],
                         cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
    elapsed = time.monotonic() - t0
    assert out.returncode == 0, out.stderr
    body = json.loads(out.stdout)
    assert body['ok'] and body['dashboard_updated'] is False
    assert elapsed < 3, elapsed  # the detached render alone sleeps 4s
    _wait(lambda: publish.dashboard_is_current(state) and publish.render_slot_free(state), 30)
    assert time.monotonic() - t0 >= 4  # the page really came from the slow detached child
    page = (state / 'dashboard.html').read_text()
    publish.generate_dashboard(state, config=json.loads((REPO / 'orchestrator' / 'config.json').read_text()))
    assert _strip((state / 'dashboard.html').read_text()) == _strip(page)  # child env/cwd == in-call render


def test_death_between_page_and_receipt_leaves_page_stale_not_claimed_current(tmp_path):
    _write(tmp_path, 0)
    publish.generate_dashboard(tmp_path, {})
    old_receipt = (tmp_path / 'dashboard.version.json').read_bytes()
    _write(tmp_path, 1)

    def die(*a, **k): raise SystemExit('killed after page replace')

    with patch.object(publish, 'write_json', die), pytest.raises(SystemExit):
        publish.render_until_current(tmp_path, {})
    assert (tmp_path / 'dashboard.version.json').read_bytes() == old_receipt  # receipt never runs ahead
    assert not publish.dashboard_is_current(tmp_path) and publish.render_slot_free(tmp_path)
    assert publish.render_until_current(tmp_path, {}) == 1 and publish.dashboard_is_current(tmp_path)
