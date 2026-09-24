import os
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path


class InstallSweepTests(unittest.TestCase):
    def test_explicit_agent_links_cover_every_agent_markdown_file(self):
        repository = Path(__file__).resolve().parents[1]
        script = (repository / 'install.sh').read_text(encoding='utf-8')
        listed = set(__import__('re').findall(r'"\$AGENTS_SRC/([^|]+)\|', script))
        present = {path.name for path in (repository / 'bridge/agents').glob('*.md')}
        self.assertEqual(listed, present)

    def test_install_plist_forwards_configured_interval_without_touching_user_dirs(self):
        repository = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            home = root / 'home'
            agent_dir = root / 'agent'
            state_dir = root / 'state'
            shim_dir = root / 'shims'
            home.mkdir()
            shim_dir.mkdir()
            (shim_dir / 'uname').write_text("#!/bin/sh\nprintf '%s\\n' Darwin\n", encoding='utf-8')
            (shim_dir / 'launchctl').write_text('#!/bin/sh\nexit 0\n', encoding='utf-8')
            (shim_dir / 'uname').chmod(0o755)
            (shim_dir / 'launchctl').chmod(0o755)

            env = {
                **os.environ,
                'HOME': str(home),
                'PATH': f"{shim_dir}:{os.environ['PATH']}",
                'HUMAIN_TERMINAL_AGENT_DIR': str(agent_dir),
                'HUMAIN_ORCHESTRATOR_STATE_ROOT': str(state_dir),
                'HUMAIN_ORCHESTRATOR_INGEST_INTERVAL': '321',
                'HUMAIN_ORCHESTRATOR_PYTHON': '/usr/bin/python3',
            }
            result = subprocess.run(['bash', str(repository / 'install.sh')], cwd=repository,
                                    env=env, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            plist_path = home / 'Library' / 'LaunchAgents' / 'com.humain.orchestrator-ingest.plist'
            with plist_path.open('rb') as stream:
                plist = plistlib.load(stream)
            self.assertEqual(plist['Label'], 'com.humain.orchestrator-ingest')
            self.assertEqual(plist['StartInterval'], 321)
            self.assertIs(plist['RunAtLoad'], True)
            self.assertEqual(plist['ProgramArguments'], [
                '/usr/bin/python3', '-m', 'orchestrator.cli', 'ingest', '--discover',
                '--since-days', '2', '--granularity', 'session', '--quiet',
            ])
            self.assertEqual(plist['EnvironmentVariables']['HUMAIN_ORCHESTRATOR_INGEST_INTERVAL'], '321')
            self.assertEqual(plist['EnvironmentVariables']['CODING_AGENT_ORCHESTRATOR_HOME'], str(state_dir))
            self.assertTrue(agent_dir.exists())
            self.assertTrue(state_dir.exists())


if __name__ == '__main__':
    unittest.main()
