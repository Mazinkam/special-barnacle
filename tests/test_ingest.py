import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from orchestrator.ingest import (CODEX, HUMAIN_TERMINAL, _resolve_encoded_path, detect_runtime, discover_logs,
                                 ingest_file, ingest_paths, is_scratch_log, read_codex, read_humain_terminal)
from orchestrator.runtime import load_jsonl


def humain_terminal_log(path: Path) -> Path:
    rows = [
        {'type': 'session', 'id': 'sess-1'},
        {'type': 'message', 'id': 'user-1', 'timestamp': '2026-09-21T10:00:00.000Z',
         'message': {'role': 'user', 'content': []}},
        {'type': 'message', 'id': 'asst-1', 'timestamp': '2026-09-21T10:00:05.000Z',
         'message': {'role': 'assistant', 'model': 'claude-sonnet-5', 'provider': 'humain-node',
                     'usage': {'input': 2, 'output': 224, 'cacheRead': 1000, 'cacheWrite': 500,
                               'cacheWrite1h': 0, 'reasoning': 96, 'totalTokens': 1726}}},
        {'type': 'message', 'id': 'asst-2', 'timestamp': '2026-09-21T10:00:09.000Z',
         'message': {'role': 'assistant', 'model': 'claude-sonnet-5',
                     'usage': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 0}}},
    ]
    path.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
    return path


def codex_log(path: Path) -> Path:
    rows = [
        {'timestamp': '2026-09-20T05:00:00.000Z', 'ordinal': 0, 'type': 'session_meta',
         'payload': {'session_id': 'sess-c', 'cwd': '/work/forge', 'model_provider': 'openai'}},
        {'timestamp': '2026-09-20T05:00:01.000Z', 'ordinal': 1, 'type': 'turn_context',
         'payload': {'turn_id': 'turn-1', 'cwd': '/work/forge', 'model': 'gpt-6-astra'}},
        {'timestamp': '2026-09-20T05:00:02.000Z', 'ordinal': 2, 'type': 'token_usage_record',
         'payload': {'session_id': 'sess-c', 'turn_id': 'turn-1', 'response_id': 'resp-1',
                     'usage': {'input_tokens': 1000, 'cached_input_tokens': 800,
                               'cache_write_input_tokens': 0, 'output_tokens': 100, 'total_tokens': 1100},
                     'turn_token_usage': {'input_tokens': 1000, 'output_tokens': 100, 'total_tokens': 1100},
                     'thread_token_usage': {'input_tokens': 1000, 'output_tokens': 100, 'total_tokens': 1100}}},
        {'timestamp': '2026-09-20T05:00:03.000Z', 'ordinal': 3, 'type': 'token_usage_record',
         'payload': {'session_id': 'sess-c', 'turn_id': 'turn-1', 'response_id': 'resp-2',
                     'usage': {'input_tokens': 2000, 'cached_input_tokens': 1900,
                               'cache_write_input_tokens': 0, 'output_tokens': 50, 'total_tokens': 2050},
                     'turn_token_usage': {'input_tokens': 3000, 'output_tokens': 150, 'total_tokens': 3150},
                     'thread_token_usage': {'input_tokens': 3000, 'output_tokens': 150, 'total_tokens': 3150}}},
    ]
    path.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
    return path


class ReaderTests(unittest.TestCase):
    def test_humain_terminal_folds_cache_reads_into_input_tokens(self):
        with tempfile.TemporaryDirectory() as d:
            calls = read_humain_terminal(humain_terminal_log(Path(d, 'session.jsonl')))
        self.assertEqual(len(calls), 2)
        first = calls[0]
        # usage.input excludes cache reads in this harness; cached must stay a subset of input_tokens
        self.assertEqual(first['input_tokens'], 1002)
        self.assertEqual(first['cached_input_tokens'], 1000)
        self.assertEqual(first['cache_write_tokens'], 500)
        self.assertEqual(first['output_tokens'], 224)
        self.assertEqual(first['session_id'], 'sess-1')
        self.assertEqual(first['model'], 'claude-sonnet-5')

    def test_humain_terminal_ignores_user_messages(self):
        with tempfile.TemporaryDirectory() as d:
            calls = read_humain_terminal(humain_terminal_log(Path(d, 'session.jsonl')))
        self.assertTrue(all(call['output_tokens'] >= 0 for call in calls))
        self.assertNotIn('user-1', [call['native_id'] for call in calls])

    def test_codex_uses_per_response_usage_not_cumulative_totals(self):
        with tempfile.TemporaryDirectory() as d:
            calls = read_codex(codex_log(Path(d, 'rollout.jsonl')))
        self.assertEqual([c['input_tokens'] for c in calls], [1000, 2000])
        self.assertEqual([c['output_tokens'] for c in calls], [100, 50])
        self.assertEqual({c['model'] for c in calls}, {'gpt-6-astra'})
        self.assertEqual({c['repository'] for c in calls}, {'/work/forge'})

    def test_detects_the_harness_from_record_shape(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(detect_runtime(humain_terminal_log(Path(d, 'a.jsonl'))), HUMAIN_TERMINAL)
            self.assertEqual(detect_runtime(codex_log(Path(d, 'b.jsonl'))), CODEX)
            Path(d, 'c.jsonl').write_text('{"type":"other"}\n', encoding='utf-8')
            self.assertIsNone(detect_runtime(Path(d, 'c.jsonl')))


class IngestTests(unittest.TestCase):
    def _env(self, root):
        return patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(root),
                                       'CODING_AGENT_RUNTIME': 'humain-terminal',
                                       'CODING_AGENT_REPOSITORY': '/work/forge'})

    def test_records_zero_usage_calls_as_unmetered_rather_than_dropping_them(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            with self._env(root):
                summary = ingest_file(humain_terminal_log(Path(d, 'session.jsonl')), state_root=root)
            self.assertEqual(summary['emitted'], 2)
            self.assertEqual(summary['zero_usage'], 1)
            self.assertGreater(summary['estimated_cost_usd'], 0)
            rows = load_jsonl(root / 'metrics.jsonl')
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[1]['cost_source'], 'unmetered')
            self.assertEqual(rows[0]['cost_source'], 'estimated-from-reported-tokens')
            self.assertEqual(rows[0]['agent_runtime'], 'humain-terminal')
            self.assertEqual(rows[0]['source'], 'session_ingest')
            self.assertEqual(rows[0]['ts'], '2026-09-21T10:00:05.000Z')

    def test_re_ingesting_the_same_log_adds_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = codex_log(Path(d, 'rollout.jsonl'))
            with self._env(root):
                first = ingest_paths([log], state_root=root)
                second = ingest_paths([log], state_root=root)
            self.assertEqual(first['emitted'], 2)
            self.assertEqual(second['emitted'], 0)
            self.assertEqual(second['duplicates'], 2)
            self.assertEqual(len(load_jsonl(root / 'metrics.jsonl')), 2)

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            with self._env(root):
                summary = ingest_paths([codex_log(Path(d, 'rollout.jsonl'))], state_root=root, dry_run=True)
            self.assertEqual(summary['emitted'], 2)
            self.assertGreater(summary['estimated_cost_usd'], 0)
            self.assertEqual(load_jsonl(root / 'metrics.jsonl'), [])

    def test_unpriced_model_is_reported_rather_than_guessed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = Path(d, 'session.jsonl')
            log.write_text(json.dumps({'type': 'message', 'id': 'a1', 'timestamp': '2026-09-21T10:00:00.000Z',
                                       'message': {'role': 'assistant', 'model': 'mystery-model-9',
                                                   'usage': {'input': 10, 'output': 10, 'totalTokens': 20}}}) + '\n',
                           encoding='utf-8')
            with self._env(root):
                summary = ingest_file(log, state_root=root, runtime=HUMAIN_TERMINAL)
            self.assertEqual(summary['unpriced_models'], {'mystery-model-9': 1})
            self.assertEqual(summary['estimated_cost_usd'], 0.0)
            self.assertEqual(load_jsonl(root / 'metrics.jsonl')[0]['cost_source'], 'unmetered')

    def test_repository_override_wins_over_environment(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            with self._env(root):
                ingest_file(humain_terminal_log(Path(d, 's.jsonl')), state_root=root, repository='/other/repo')
            self.assertEqual(load_jsonl(root / 'metrics.jsonl')[0]['repository'], '/other/repo')

    def test_repository_falls_back_to_environment_attribution_not_the_ingest_cwd(self):
        # A HUMAIN Terminal log records no cwd; the row must be attributed to the configured
        # repository, never to wherever the ingest command was run from.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            with self._env(root):
                ingest_file(humain_terminal_log(Path(d, 's.jsonl')), state_root=root)
            self.assertEqual(load_jsonl(root / 'metrics.jsonl')[0]['repository'], '/work/forge')

    def test_codex_log_cwd_is_preserved_when_no_override_is_given(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            with self._env(root):
                ingest_file(codex_log(Path(d, 'rollout.jsonl')), state_root=root)
            self.assertEqual({r['repository'] for r in load_jsonl(root / 'metrics.jsonl')}, {'/work/forge'})

    def test_unknown_format_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d, 'x.jsonl')
            log.write_text('{"type":"other"}\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                ingest_file(log, state_root=Path(d, 'state'))
            with self.assertRaises(FileNotFoundError):
                ingest_file(Path(d, 'missing.jsonl'), state_root=Path(d, 'state'))


if __name__ == '__main__':
    unittest.main()


class SessionGranularityTests(unittest.TestCase):
    def _env(self, root):
        return patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(root),
                                       'CODING_AGENT_RUNTIME': 'humain-terminal',
                                       'CODING_AGENT_REPOSITORY': '/work/forge'})

    def test_collapses_a_session_into_one_row_per_model(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            with self._env(root):
                summary = ingest_file(codex_log(Path(d, 'rollout.jsonl')), state_root=root, granularity='session')
            rows = load_jsonl(root / 'metrics.jsonl')
            self.assertEqual(summary['emitted'], 1)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['granularity'], 'session')
            self.assertEqual(rows[0]['covers_calls'], 2)
            self.assertEqual(rows[0]['input_tokens'], 3000)      # 1000 + 2000
            self.assertEqual(rows[0]['output_tokens'], 150)      # 100 + 50
            self.assertEqual(rows[0]['cached_input_tokens'], 2700)

    def test_aggregate_cost_equals_the_sum_of_per_call_costs(self):
        with tempfile.TemporaryDirectory() as d:
            log = codex_log(Path(d, 'rollout.jsonl'))
            per_call_root, session_root = Path(d, 's1'), Path(d, 's2')
            with self._env(per_call_root):
                per_call = ingest_file(log, state_root=per_call_root)
            with self._env(session_root):
                aggregate = ingest_file(log, state_root=session_root, granularity='session')
            self.assertAlmostEqual(per_call['estimated_cost_usd'], aggregate['estimated_cost_usd'], places=6)

    def test_aggregating_a_session_already_ingested_per_call_adds_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = codex_log(Path(d, 'rollout.jsonl'))
            with self._env(root):
                ingest_file(log, state_root=root)
                second = ingest_file(log, state_root=root, granularity='session')
            self.assertEqual(second['emitted'], 0)
            self.assertEqual(second['duplicates'], 1)
            self.assertEqual(len(load_jsonl(root / 'metrics.jsonl')), 2)

    def test_regrowth_after_aggregation_emits_only_the_delta(self):
        with tempfile.TemporaryDirectory() as d:
            root, log = Path(d, 'state'), codex_log(Path(d, 'rollout.jsonl'))
            with self._env(root):
                ingest_file(log, state_root=root, granularity='session')
                with log.open('a') as handle:
                    handle.write(json.dumps({'timestamp': '2026-09-20T05:00:04.000Z', 'ordinal': 4,
                                             'type': 'token_usage_record',
                                             'payload': {'session_id': 'sess-c', 'turn_id': 'turn-1',
                                                         'response_id': 'resp-3',
                                                         'usage': {'input_tokens': 500, 'cached_input_tokens': 0,
                                                                   'cache_write_input_tokens': 0,
                                                                   'output_tokens': 25, 'total_tokens': 525}}}) + '\n')
                delta = ingest_file(log, state_root=root, granularity='session')
            rows = load_jsonl(root / 'metrics.jsonl')
            self.assertEqual(delta['emitted'], 1)
            self.assertEqual(rows[-1]['input_tokens'], 500)
            self.assertEqual(rows[-1]['output_tokens'], 25)
            self.assertEqual(rows[-1]['covers_calls'], 1)
            # every token counted exactly once across both rows
            self.assertEqual(sum(r['input_tokens'] for r in rows), 3500)

    def test_bad_granularity_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                ingest_file(codex_log(Path(d, 'r.jsonl')), state_root=Path(d, 'state'), granularity='hourly')


class DiscoveryTests(unittest.TestCase):
    def test_finds_both_harness_layouts_and_honours_since_days(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            ht = home / '.humain-terminal/agent/sessions/--project--/new.jsonl'
            cx = home / '.codex/sessions/2026/09/20/rollout-old.jsonl'
            for path in (ht, cx):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{}\n', encoding='utf-8')
            os.utime(cx, (time.time() - 60 * 86_400,) * 2)
            self.assertEqual({p.name for p in discover_logs(home=home)}, {'new.jsonl', 'rollout-old.jsonl'})
            self.assertEqual([p.name for p in discover_logs(since_days=30, home=home)], ['new.jsonl'])
            self.assertEqual([p.name for p in discover_logs(runtimes=['codex'], home=home)], ['rollout-old.jsonl'])


class BulkResilienceTests(unittest.TestCase):
    def test_an_unreadable_log_does_not_abort_the_batch(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            good = codex_log(Path(d, 'good.jsonl'))
            bad = Path(d, 'bad.jsonl')
            bad.write_text('{"type":"other"}\n', encoding='utf-8')
            with patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(root),
                                         'CODING_AGENT_RUNTIME': 'codex',
                                         'CODING_AGENT_REPOSITORY': '/work/forge'}):
                result = ingest_paths([bad, good, Path(d, 'missing.jsonl')], state_root=root)
            self.assertEqual(result['emitted'], 2)
            self.assertEqual(len(result['failures']), 2)
            self.assertEqual({f['error'].split(':')[0] for f in result['failures']},
                             {'ValueError', 'FileNotFoundError'})


class RepositoryDecodingTests(unittest.TestCase):
    def test_resolves_encoded_paths_including_segments_containing_dashes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'Users/abdulkarim/Projects/humain-terminal').mkdir(parents=True)
            resolved = _resolve_encoded_path('--Users-abdulkarim-Projects-humain-terminal--', root=root)
            self.assertEqual(resolved, root / 'Users/abdulkarim/Projects/humain-terminal')

    def test_returns_none_rather_than_guessing_when_no_directory_matches(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(_resolve_encoded_path('--nope-not-here--', root=Path(d)))

    def test_session_rows_carry_the_repository_decoded_from_the_log_path(self):
        with tempfile.TemporaryDirectory() as d:
            project = Path(d, 'Users/me/Projects/my-app')
            sessions = Path(d, 'sessions')
            sessions.mkdir(parents=True)
            project.mkdir(parents=True)
            with patch('orchestrator.ingest._resolve_encoded_path', return_value=project):
                calls = read_humain_terminal(humain_terminal_log(Path(sessions, 's_abc.jsonl')))
            self.assertEqual({c['repository'] for c in calls}, {str(project)})

    def test_scratch_sessions_are_excluded_from_discovery_by_default(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            real = home / '.humain-terminal/agent/sessions/--Users-me-Projects-app--/s.jsonl'
            scratch = home / '.humain-terminal/agent/sessions/--var-folders-vn-abc-T-pi-1-2--/s.jsonl'
            for path in (real, scratch):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{}\n', encoding='utf-8')
            self.assertTrue(is_scratch_log(scratch))
            self.assertFalse(is_scratch_log(real))
            self.assertEqual([p for p in discover_logs(home=home)], [real])
            self.assertEqual(len(discover_logs(home=home, include_scratch=True)), 2)
