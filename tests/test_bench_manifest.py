import json
import pytest
from bench.manifest import ManifestError, load_manifest, load_suite

GOOD = {
    'id': 'forge-001', 'repo': '/src/forge', 'base_commit': 'a' * 40, 'goal': 'Fix X',
    'task_class': 'implementation', 'scope_band': 'small', 'risk': 'low', 'split': 'dev',
    'setup': [['bun', 'install']], 'visible_checks': [['bun', 'test']], 'hidden_checks': [['bun', 'test', 'hidden.test.ts']],
    'hidden_files': 'hidden', 'reference_patch': 'reference.patch', 'protected_paths': ['hidden.test.ts'], 'timeout_s': 1800,
}

def write(tmp_path, name, data):
    p = tmp_path / name; p.write_text(json.dumps(data)); return p

def test_valid_manifest_loads(tmp_path):
    m = load_manifest(write(tmp_path, 'forge-001.json', GOOD))
    assert m.scope_band == 'small' and m.hidden_checks == (('bun', 'test', 'hidden.test.ts'),)

@pytest.mark.parametrize('field,value', [('scope_band', 'huge'), ('risk', 'meh'), ('split', 'train'),
                                         ('base_commit', 'HEAD'), ('hidden_checks', []), ('timeout_s', 0)])
def test_invalid_fields_rejected(tmp_path, field, value):
    with pytest.raises(ManifestError, match=field):
        load_manifest(write(tmp_path, 'x.json', {**GOOD, field: value}))

def test_suite_rejects_duplicate_ids(tmp_path):
    write(tmp_path, 'a.json', GOOD); write(tmp_path, 'b.json', GOOD)
    with pytest.raises(ManifestError, match='duplicate id'):
        load_suite(tmp_path)
