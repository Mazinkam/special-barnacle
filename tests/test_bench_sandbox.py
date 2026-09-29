import subprocess, sys
import pytest
from bench.sandbox import sandbox_argv

pytestmark = pytest.mark.skipif(sys.platform != 'darwin', reason='sandbox-exec is macOS-only')

def test_denied_root_is_unreadable(tmp_path):
    secret = tmp_path / 'checkout'; secret.mkdir(); (secret / 'solution.txt').write_text('FUTURE')
    p = subprocess.run(sandbox_argv(['/bin/cat', str(secret / 'solution.txt')], deny_read=[secret], allow_network=True), capture_output=True, text=True)
    assert p.returncode != 0 and 'FUTURE' not in p.stdout

def test_allowed_path_is_readable(tmp_path):
    ok = tmp_path / 'snap'; ok.mkdir(); (ok / 'a.txt').write_text('base')
    p = subprocess.run(sandbox_argv(['/bin/cat', str(ok / 'a.txt')], deny_read=[tmp_path / 'other'], allow_network=True), capture_output=True, text=True)
    assert p.returncode == 0 and p.stdout == 'base'

def test_network_denied_when_requested():
    p = subprocess.run(sandbox_argv(['/usr/bin/curl', '-sS', '--max-time', '3', 'https://example.com'], deny_read=[], allow_network=False), capture_output=True, text=True)
    assert p.returncode != 0
