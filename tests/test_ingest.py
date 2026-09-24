import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from orchestrator.ingest import (CODEX, HUMAIN_TERMINAL, _resolve_encoded_path, detect_runtime, discover_logs,
                                 ingest_file, ingest_paths, is_scratch_log, read_codex, read_humain_terminal)
from orchestrator.pricing import estimate_cost_usd
from orchestrator.records import CALL, SESSION, covered_calls
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

    def test_truncated_trailing_json_does_not_erase_valid_usage(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = humain_terminal_log(Path(d, 'session.jsonl'))
            fixture_records = [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines()]
            valid_usage = next(row for row in fixture_records
                               if isinstance(row.get('message'), dict)
                               and row['message'].get('role') == 'assistant')
            log.write_text(json.dumps({'type': 'session', 'id': 'sess-1'}) + '\n'
                           + json.dumps(valid_usage) + '\n'
                           + '{"type":"message","id":"truncated","message":',
                           encoding='utf-8')

            result = ingest_paths([log], state_root=root, runtime=HUMAIN_TERMINAL)

            self.assertEqual(result['emitted'], 1)
            self.assertEqual(result['failures'], [])
            self.assertEqual(len(load_jsonl(root / 'metrics.jsonl')), 1)

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


class IncrementalContractTests(unittest.TestCase):
    """The public shape of `ingest_paths`/`ingest_file` survives the checkpointed implementation."""

    def _env(self, root):
        return patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(root),
                                       'CODING_AGENT_RUNTIME': 'humain-terminal',
                                       'CODING_AGENT_REPOSITORY': '/work/forge'})

    def test_return_shape_is_retained_and_per_file_summaries_expose_the_resume_point(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = codex_log(Path(d, 'rollout.jsonl'))
            with self._env(root):
                first = ingest_paths([log], state_root=root)
                second = ingest_paths([log], state_root=root)
            for result in (first, second):
                self.assertEqual(set(result) >= {'files', 'files_processed', 'failures', 'granularity', 'emitted', 'duplicates',
                                                 'zero_usage', 'usage_rows', 'estimated_cost_usd', 'unpriced_models',
                                                 'zero_token_models', 'dry_run'}, True, sorted(result))
                summary = result['files'][0]
                self.assertEqual(set(summary) >= {'file', 'runtime', 'granularity', 'usage_rows', 'emitted', 'duplicates',
                                                  'zero_usage', 'estimated_cost_usd', 'unpriced_models', 'dry_run',
                                                  'resumed', 'scanned_from'}, True, sorted(summary))
            self.assertFalse(first['files'][0]['resumed'])
            self.assertEqual(first['files'][0]['scanned_from'], 0)
            self.assertTrue(second['files'][0]['resumed'])
            self.assertEqual(second['files'][0]['scanned_from'], log.stat().st_size)
            self.assertEqual((second['emitted'], second['duplicates'], second['usage_rows']), (0, 2, 2))

    def test_a_file_is_appended_in_bounded_batches_not_one_write_per_call(self):
        from orchestrator import ingest as ingest_module
        from orchestrator.record_batch import MAX_BATCH_RECORDS, write_batch
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            rows = [{'type': 'session', 'id': 'big'}]
            for i in range(MAX_BATCH_RECORDS + 10):
                rows.append({'type': 'message', 'id': f'a{i}', 'timestamp': '2026-09-21T10:00:00.000Z',
                             'message': {'role': 'assistant', 'model': 'claude-sonnet-5',
                                         'usage': {'input': 1, 'output': 1, 'totalTokens': 2}}})
            log = Path(d, 'big.jsonl')
            log.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
            calls = []

            def counting(*args, **kwargs):
                calls.append(len(args[1]))
                return write_batch(*args, **kwargs)

            with self._env(root), patch.object(ingest_module, 'write_batch', counting):
                result = ingest_file(log, state_root=root, runtime=HUMAIN_TERMINAL)
            self.assertEqual(result['emitted'], MAX_BATCH_RECORDS + 10)
            self.assertEqual(calls, [MAX_BATCH_RECORDS, 10])
            self.assertEqual(len(load_jsonl(root / 'metrics.jsonl')), MAX_BATCH_RECORDS + 10)

    def test_ingested_rows_carry_stable_record_ids_so_retries_dedup_in_the_writer(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = codex_log(Path(d, 'rollout.jsonl'))
            with self._env(root):
                ingest_file(log, state_root=root)
            rows = load_jsonl(root / 'metrics.jsonl')
            self.assertEqual([r['record_id'] for r in rows], [r['call_id'] for r in rows])
            with self._env(root):
                ingest_file(log, state_root=Path(d, 'other'), granularity='session')
            aggregate = load_jsonl(Path(d, 'other', 'metrics.jsonl'))[0]
            self.assertEqual(aggregate['record_id'], aggregate['call_id'])


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


class DedupeHardeningTests(unittest.TestCase):
    """T5: session-granularity reconciliation must not double count, by either key."""

    def _env(self, root):
        return patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(root),
                                       'CODING_AGENT_RUNTIME': 'humain-terminal',
                                       'CODING_AGENT_REPOSITORY': '/work/forge'})

    def test_call_then_session_ingestion_of_the_same_file_does_not_double_count(self):
        # Re-ingesting one file at CALL granularity, then again at SESSION granularity, must
        # cost and cover exactly what the file actually contains — once, not twice.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = codex_log(Path(d, 'rollout.jsonl'))
            with self._env(root):
                per_call = ingest_paths([log], state_root=root)
                session = ingest_paths([log], state_root=root, granularity=SESSION)
            rows = load_jsonl(root / 'metrics.jsonl')
            self.assertEqual(per_call['emitted'], 2)
            self.assertEqual(session['emitted'], 0)
            self.assertEqual(session['duplicates'], 1)
            total_cost = round(sum(float(r.get('cost_usd') or 0) for r in rows), 6)
            self.assertAlmostEqual(total_cost, per_call['estimated_cost_usd'], places=6)
            self.assertEqual(sum(covered_calls(r) for r in rows), 2)

    def test_session_id_drift_does_not_double_count_because_ingest_source_reconciles(self):
        # `read_humain_terminal` derives `session_id` from a filename fallback until a later
        # `type=='session'` record overrides it. Simulate that drift: ingest the file once before
        # the override exists (CALL granularity, session_id falls back to 'sessA'), then again
        # after the file has gained a leading `session` record with a *different* id ('sess-B'),
        # this time at SESSION granularity. Without the `ingest_source` reconciliation key, the
        # second pass would look for prior totals under 'sess-B', find none, and re-emit the same
        # tokens the first pass already recorded under 'sessA'.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = Path(d, 'log_sessA.jsonl')

            def write(with_session_override):
                rows = []
                if with_session_override:
                    rows.append({'type': 'session', 'id': 'sess-B'})
                rows += [
                    {'type': 'message', 'id': 'asst-1', 'timestamp': '2026-09-21T10:00:00.000Z',
                     'message': {'role': 'assistant', 'model': 'claude-sonnet-5', 'provider': 'humain-node',
                                 'usage': {'input': 100, 'output': 50, 'cacheRead': 0, 'cacheWrite': 0,
                                           'totalTokens': 150}}},
                    {'type': 'message', 'id': 'asst-2', 'timestamp': '2026-09-21T10:00:05.000Z',
                     'message': {'role': 'assistant', 'model': 'claude-sonnet-5', 'provider': 'humain-node',
                                 'usage': {'input': 100, 'output': 50, 'cacheRead': 0, 'cacheWrite': 0,
                                           'totalTokens': 150}}},
                ]
                log.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')

            write(with_session_override=False)
            with self._env(root):
                first = ingest_file(log, state_root=root, runtime=HUMAIN_TERMINAL)
            self.assertEqual(first['emitted'], 2)
            self.assertEqual({r['session_id'] for r in load_jsonl(root / 'metrics.jsonl')}, {'sessA'})

            write(with_session_override=True)
            with self._env(root):
                second = ingest_file(log, state_root=root, runtime=HUMAIN_TERMINAL, granularity=SESSION)
            self.assertEqual(second['emitted'], 0)
            self.assertEqual(second['duplicates'], 1)
            rows = load_jsonl(root / 'metrics.jsonl')
            self.assertEqual(len(rows), 2)
            self.assertEqual(sum(r['input_tokens'] for r in rows), 200)
            self.assertEqual(sum(r['output_tokens'] for r in rows), 100)

    def test_session_id_drift_emits_new_calls_in_full_even_without_checkpoint(self):
        # Equal usage is not identity: only old native IDs are paid after a header rewrite.
        from orchestrator.ingest_checkpoint import checkpoint_path

        for first_granularity in (CALL, SESSION):
            for second_granularity in (CALL, SESSION):
                for lose_checkpoint in (False, True):
                    with self.subTest(first=first_granularity, second=second_granularity,
                                      lose_checkpoint=lose_checkpoint), tempfile.TemporaryDirectory() as d:
                        root = Path(d, 'state')
                        log = Path(d, 'log_sessA.jsonl')
                        old = {'type': 'message', 'id': 'old-call',
                               'message': {'role': 'assistant', 'model': 'claude-sonnet-5',
                                           'usage': {'input': 100, 'output': 50, 'totalTokens': 150}}}
                        log.write_text(json.dumps(old) + '\n', encoding='utf-8')
                        with self._env(root):
                            ingest_file(log, state_root=root, granularity=first_granularity)
                            if lose_checkpoint:
                                checkpoint_path(root, log).unlink()
                            log.write_text(''.join(json.dumps(row) + '\n' for row in [
                                {'type': 'session', 'id': 'sess-B'}, old, {**old, 'id': 'new-call'}
                            ]), encoding='utf-8')
                            second = ingest_file(log, state_root=root, granularity=second_granularity)
                            retry = ingest_file(log, state_root=root, granularity=second_granularity)
                            # A later suffix can repeat the drifted call; checkpoint history must
                            # retain its original paid identity rather than an unpaid alias.
                            with log.open('a', encoding='utf-8') as handle:
                                handle.write(json.dumps(old) + '\n')
                                handle.write(json.dumps({**old, 'id': 'later-call'}) + '\n')
                            growth = ingest_file(log, state_root=root, granularity=second_granularity)
                        self.assertEqual(second['emitted'], 1)
                        self.assertEqual(retry['emitted'], 0)
                        self.assertEqual(growth['emitted'], 1)
                        rows = load_jsonl(root / 'metrics.jsonl')
                        self.assertEqual(sum(covered_calls(row) for row in rows), 3)
                        self.assertEqual([(row['session_id'], row['input_tokens'], row['output_tokens'])
                                          for row in rows], [('sessA', 100, 50), ('sess-B', 100, 50),
                                                             ('sess-B', 100, 50)])
                        self.assertEqual(rows[-1].get('covers_calls', 1), 1)
                        self.assertEqual(rows[-1]['source'], 'session_ingest')
                        self.assertEqual(rows[-1]['ingest_source'], str(log))

    def test_drift_with_totals_only_source_history_is_rejected_before_writing(self):
        from orchestrator.ingest import SourceConflict
        from orchestrator.ingest_checkpoint import checkpoint_path

        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = humain_terminal_log(Path(d, 'log.jsonl'))
            with self._env(root):
                ingest_file(log, state_root=root, granularity=SESSION)
                rows = load_jsonl(root / 'metrics.jsonl')
                for row in rows:
                    row.pop('covered_call_ids', None)
                metrics = root / 'metrics.jsonl'
                metrics.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
                checkpoint_path(root, log).unlink()
                log.write_text(log.read_text().replace('sess-1', 'sess-2'), encoding='utf-8')
                before = metrics.read_bytes()
                with self.assertRaises(SourceConflict):
                    ingest_file(log, state_root=root, granularity=SESSION)
                self.assertEqual(metrics.read_bytes(), before)

    def test_drift_rejects_reused_native_id_with_changed_usage(self):
        from orchestrator.ingest import SourceConflict

        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = humain_terminal_log(Path(d, 'log_sessA.jsonl'))
            # Drift means the original calls had only filename-derived identity, not an
            # explicit session whose successor is entitled to reuse its native call IDs.
            original = '\n'.join(log.read_text().splitlines()[1:]) + '\n'
            log.write_text(original, encoding='utf-8')
            with self._env(root):
                ingest_file(log, state_root=root, granularity=SESSION)
                log.write_text(json.dumps({'type': 'session', 'id': 'sess-B'}) + '\n'
                               + original.replace('1726', '9999'), encoding='utf-8')
                before = (root / 'metrics.jsonl').read_bytes()
                with self.assertRaises(SourceConflict):
                    ingest_file(log, state_root=root, granularity=SESSION)
                self.assertEqual((root / 'metrics.jsonl').read_bytes(), before)

    def test_drift_cannot_treat_a_positional_fallback_as_a_native_id(self):
        from orchestrator.ingest import SourceConflict

        for new_id in (None, '0'):
            with self.subTest(new_id=new_id), tempfile.TemporaryDirectory() as d:
                root = Path(d, 'state')
                log = Path(d, 'log_sessA.jsonl')
                call = {'type': 'message', 'message': {'role': 'assistant', 'model': 'claude-sonnet-5',
                                                     'usage': {'input': 100, 'output': 50, 'totalTokens': 150}}}
                log.write_text(json.dumps(call) + '\n', encoding='utf-8')
                with self._env(root):
                    ingest_file(log, state_root=root, granularity=SESSION)
                    if new_id is not None:
                        call['id'] = new_id
                    log.write_text(''.join(json.dumps(row) + '\n' for row in [
                        {'type': 'session', 'id': 'sess-B'}, call
                    ]), encoding='utf-8')
                    before = (root / 'metrics.jsonl').read_bytes()
                    with self.assertRaises(SourceConflict):
                        ingest_file(log, state_root=root, granularity=SESSION)
                    self.assertEqual((root / 'metrics.jsonl').read_bytes(), before)

    def test_two_distinct_sessions_in_one_file_each_emit_their_full_totals(self):
        # The reviewer's regression. `read_humain_terminal` assigns `session_id` from the filename
        # fallback until a `type=='session'` record overrides it, so ONE physical log can carry two
        # distinct session_ids: calls before the override belong to 'sessA', calls after it to
        # 'sess-B'. A source-level reconciliation bucket that is not session-aware accumulates
        # across both and silently subtracts session A's already-recorded totals from session B.
        #
        # Expected: A = 1000/500, B = 1200/400. Regression produced B = 200/0, losing 1000 input
        # and ALL 400 output tokens with emitted:1 and no duplicate flag and no error.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = Path(d, 'log_sessA.jsonl')

            def call(native_id, ts, input_tokens, output_tokens):
                return {'type': 'message', 'id': native_id, 'timestamp': ts,
                        'message': {'role': 'assistant', 'model': 'claude-sonnet-5',
                                    'provider': 'humain-node',
                                    'usage': {'input': input_tokens, 'output': output_tokens,
                                              'cacheRead': 0, 'cacheWrite': 0,
                                              'totalTokens': input_tokens + output_tokens}}}

            session_a = [call('asst-a1', '2026-09-21T10:00:00.000Z', 1000, 500)]
            session_b = [{'type': 'session', 'id': 'sess-B'},
                         call('asst-b1', '2026-09-21T11:00:00.000Z', 1200, 400)]

            def write(rows):
                log.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')

            # Pass 1: the file so far holds only session A.
            write(session_a)
            with self._env(root):
                first = ingest_file(log, state_root=root, runtime=HUMAIN_TERMINAL, granularity=SESSION)
            self.assertEqual(first['emitted'], 1)

            # Pass 2: the same file has grown a second, distinct session.
            write(session_a + session_b)
            with self._env(root):
                second = ingest_file(log, state_root=root, runtime=HUMAIN_TERMINAL, granularity=SESSION)
            self.assertEqual(second['emitted'], 1)

            rows = load_jsonl(root / 'metrics.jsonl')
            by_session = {}
            for row in rows:
                bucket = by_session.setdefault(row['session_id'], {'input': 0, 'output': 0})
                bucket['input'] += int(row.get('input_tokens') or 0)
                bucket['output'] += int(row.get('output_tokens') or 0)
            self.assertEqual(sorted(by_session), sorted(['sessA', 'sess-B']))
            self.assertEqual(by_session['sessA'], {'input': 1000, 'output': 500})
            # Session B's full, unreduced totals -- not 200/0.
            self.assertEqual(by_session['sess-B'], {'input': 1200, 'output': 400})
            # Nothing lost in aggregate either.
            self.assertEqual(sum(r['input_tokens'] for r in rows), 2200)
            self.assertEqual(sum(r['output_tokens'] for r in rows), 900)

    def test_session_id_drift_between_two_session_passes_does_not_double_count(self):
        # Property (a) at SESSION->SESSION granularity: the file's single logical session is
        # recorded under 'sessA', then the `type=='session'` override appears and the very same
        # calls now read as 'sess-B'. The prior total was recorded for THIS file under a session_id
        # that is no longer present, so it must still be reconciled -- not re-emitted.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log = Path(d, 'log_sessA.jsonl')
            call = {'type': 'message', 'id': 'asst-1', 'timestamp': '2026-09-21T10:00:00.000Z',
                    'message': {'role': 'assistant', 'model': 'claude-sonnet-5', 'provider': 'humain-node',
                                'usage': {'input': 700, 'output': 300, 'cacheRead': 0, 'cacheWrite': 0,
                                          'totalTokens': 1000}}}

            def write(rows):
                log.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')

            write([call])
            with self._env(root):
                first = ingest_file(log, state_root=root, runtime=HUMAIN_TERMINAL, granularity=SESSION)
            self.assertEqual(first['emitted'], 1)
            self.assertEqual({r['session_id'] for r in load_jsonl(root / 'metrics.jsonl')}, {'sessA'})

            write([{'type': 'session', 'id': 'sess-B'}, call])
            with self._env(root):
                second = ingest_file(log, state_root=root, runtime=HUMAIN_TERMINAL, granularity=SESSION)
            self.assertEqual(second['emitted'], 0)
            self.assertEqual(second['duplicates'], 1)
            rows = load_jsonl(root / 'metrics.jsonl')
            self.assertEqual(sum(r['input_tokens'] for r in rows), 700)
            self.assertEqual(sum(r['output_tokens'] for r in rows), 300)

    def test_a_session_spanning_multiple_files_still_reconciles_by_session_id(self):
        # The multi-file case the session_id key exists for. Two different ingest_sources
        # (different files) sharing the same logical session_id must still be reconciled purely
        # by session_id, unaffected by the new ingest_source key: an empty ingest_source bucket
        # for the second (never-before-seen) file must not override a real session_id total.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            log1 = humain_terminal_log(Path(d, 'part1.jsonl'))
            log2 = humain_terminal_log(Path(d, 'part2.jsonl'))
            with self._env(root):
                first = ingest_file(log1, state_root=root, granularity=SESSION)
                second = ingest_file(log2, state_root=root, granularity=SESSION)
            self.assertGreater(first['emitted'], 0)
            self.assertEqual(second['emitted'], 0)
            self.assertEqual(second['duplicates'], 1)


class GranularityStampingTests(unittest.TestCase):
    def _env(self, root):
        return patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(root),
                                       'CODING_AGENT_RUNTIME': 'humain-terminal',
                                       'CODING_AGENT_REPOSITORY': '/work/forge'})

    def test_every_emitted_row_carries_an_explicit_granularity(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            with self._env(root):
                ingest_file(humain_terminal_log(Path(d, 'a.jsonl')), state_root=root, granularity=CALL)
                ingest_file(codex_log(Path(d, 'b.jsonl')), state_root=root, granularity=SESSION)
            rows = load_jsonl(root / 'metrics.jsonl')
            self.assertTrue(rows)
            for row in rows:
                self.assertIn('granularity', row)
                self.assertIn(row['granularity'], (CALL, SESSION))
            # Session aggregates (the ones carrying covers_calls) must be stamped SESSION, never CALL.
            self.assertEqual({r['granularity'] for r in rows if r.get('covers_calls')}, {SESSION})
            self.assertEqual({r['granularity'] for r in rows if not r.get('covers_calls')}, {CALL})


class PricingProvenanceTests(unittest.TestCase):
    def test_estimate_surfaces_configured_rate_provenance(self):
        result = estimate_cost_usd(model='claude-sonnet-5', input_tokens=1000, output_tokens=100)
        self.assertIsNotNone(result)
        self.assertEqual(result['cost_rate_source'], 'unverified-local-catalog')
        self.assertIsNone(result['cost_rate_verified_on'])

    def test_absent_provenance_on_a_rate_entry_does_not_break_estimation(self):
        # Most of the live config predates `source`/`verified_on`; an entry missing them must
        # keep pricing correctly rather than raising.
        pricing = {'enabled': True, 'models': {'x-model': {'input_per_mtok': 1.0, 'output_per_mtok': 2.0}}}
        result = estimate_cost_usd(model='x-model', input_tokens=1000, output_tokens=1000, pricing=pricing)
        self.assertIsNotNone(result)
        self.assertGreater(result['cost_usd'], 0)
        self.assertIsNone(result['cost_rate_source'])
        self.assertIsNone(result['cost_rate_verified_on'])

    def test_ingested_rows_carry_rate_provenance(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d, 'state')
            with patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(root),
                                         'CODING_AGENT_RUNTIME': 'humain-terminal',
                                         'CODING_AGENT_REPOSITORY': '/work/forge'}):
                ingest_file(humain_terminal_log(Path(d, 's.jsonl')), state_root=root)
            rows = load_jsonl(root / 'metrics.jsonl')
            estimated = [r for r in rows if r.get('cost_source') == 'estimated-from-reported-tokens']
            self.assertTrue(estimated)
            self.assertEqual(estimated[0]['cost_rate_source'], 'unverified-local-catalog')
            self.assertIn('cost_rate_verified_on', estimated[0])


class StampGranularityTests(unittest.TestCase):
    @staticmethod
    def _load_module():
        script_path = Path(__file__).resolve().parents[1] / 'scripts' / 'stamp_granularity.py'
        spec = importlib.util.spec_from_file_location('stamp_granularity_under_test', script_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    @staticmethod
    def _sample_rows():
        return [
            {'event': 'model_call', 'model': 'claude-sonnet-5', 'cost_usd': 0.01},
            {'event': 'model_call', 'covers_calls': 5, 'cost_usd': 0.5, 'legacy_source': 'old'},
            {'event': 'route_executed', 'executed_cost_usd': 0.2},
            {'event': 'model_call', 'granularity': 'call', 'cost_usd': 0.02},
        ]

    def test_dry_run_writes_nothing(self):
        stamp = self._load_module()
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            metrics = state / 'metrics.jsonl'
            metrics.write_text(''.join(json.dumps(r) + '\n' for r in self._sample_rows()), encoding='utf-8')
            before = metrics.read_text(encoding='utf-8')
            code = stamp.main([str(state)])
            self.assertEqual(code, 0)
            self.assertEqual(metrics.read_text(encoding='utf-8'), before)
            self.assertEqual(list(state.glob('metrics.pre-stamp-granularity-*.jsonl')), [])

    def test_write_path_is_idempotent_and_backs_up_first(self):
        stamp = self._load_module()
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            metrics = state / 'metrics.jsonl'
            metrics.write_text(''.join(json.dumps(r) + '\n' for r in self._sample_rows()), encoding='utf-8')

            code1 = stamp.main([str(state), '--write'])
            self.assertEqual(code1, 0)
            backups_after_first = list(state.glob('metrics.pre-stamp-granularity-*.jsonl'))
            self.assertEqual(len(backups_after_first), 1)

            first_rows = load_jsonl(metrics)
            self.assertEqual(len(first_rows), 4)
            for row in first_rows:
                self.assertIn('granularity', row)
            by_legacy = [r['granularity'] for r in first_rows if r.get('legacy_source')]
            self.assertEqual(by_legacy, [SESSION])
            by_route = [r['granularity'] for r in first_rows if r.get('event') == 'route_executed']
            self.assertEqual(by_route, ['event'])
            # Already-stamped row is untouched.
            already_stamped = [r for r in first_rows if r.get('cost_usd') == 0.02]
            self.assertEqual(already_stamped[0]['granularity'], CALL)

            after_first_write = metrics.read_text(encoding='utf-8')

            code2 = stamp.main([str(state), '--write'])
            self.assertEqual(code2, 0)
            self.assertEqual(metrics.read_text(encoding='utf-8'), after_first_write)
            # A backup is taken on every write, including a no-op second pass.
            self.assertGreaterEqual(len(list(state.glob('metrics.pre-stamp-granularity-*.jsonl'))), 1)

    def test_a_crash_mid_write_leaves_the_original_stream_intact(self):
        # Non-atomic rewrites truncate metrics.jsonl the moment they open it, so an interruption
        # part-way through destroys every row that had not been re-written yet. The rewrite must
        # land via a temp file + os.replace, so a failure leaves the original fully readable.
        stamp = self._load_module()
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            metrics = state / 'metrics.jsonl'
            metrics.write_text(''.join(json.dumps(r) + '\n' for r in self._sample_rows()), encoding='utf-8')
            before = metrics.read_text(encoding='utf-8')

            with patch.object(stamp.os, 'fsync', side_effect=OSError('No space left on device')):
                with self.assertRaises(OSError):
                    stamp.main([str(state), '--write'])

            # The shared stream is byte-identical and still parses to every original row.
            self.assertEqual(metrics.read_text(encoding='utf-8'), before)
            self.assertEqual(len(load_jsonl(metrics)), len(self._sample_rows()))
            # No temp debris left behind next to it.
            self.assertEqual([p.name for p in state.glob('.metrics.jsonl.*')], [])

    def test_write_replaces_the_target_rather_than_truncating_it_in_place(self):
        # Pin the mechanism, not just the outcome: the new content must arrive via os.replace onto
        # metrics.jsonl, from a staged sibling file.
        stamp = self._load_module()
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            metrics = state / 'metrics.jsonl'
            metrics.write_text(''.join(json.dumps(r) + '\n' for r in self._sample_rows()), encoding='utf-8')
            replaced: list[tuple[str, str]] = []
            real_replace = os.replace

            def spy(src, dst):
                replaced.append((str(src), str(dst)))
                return real_replace(src, dst)

            with patch.object(stamp.os, 'replace', side_effect=spy):
                self.assertEqual(stamp.main([str(state), '--write']), 0)
            self.assertEqual([dst for _, dst in replaced], [str(metrics)])
            # The staged file was a sibling, so the rename stays on one filesystem.
            self.assertEqual(Path(replaced[0][0]).parent, state)
            for row in load_jsonl(metrics):
                self.assertIn('granularity', row)

    def test_missing_state_dir_is_reported_not_raised(self):
        stamp = self._load_module()
        with tempfile.TemporaryDirectory() as d:
            code = stamp.main([str(Path(d, 'nope'))])
            self.assertEqual(code, 1)
