import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from orchestrator.dashboard import build_data
from orchestrator.economics import ESTIMATED, REPORTED, UNMETERED, cost_attribution, cost_class, is_call_row
from orchestrator.pricing import estimate_cost_usd, rate_for
from orchestrator.runtime import EventStore

PRICING = {'enabled': True, 'models': {'claude-sonnet-5': {'input_per_mtok': 2.0, 'output_per_mtok': 10.0,
                                                           'cache_read_per_mtok': 0.2,
                                                           'cache_write_per_mtok': 2.5}}}


class CostClassTests(unittest.TestCase):
    def test_reported_requires_an_explicit_claim(self):
        self.assertEqual(cost_class({'cost_usd': 1.0, 'cost_source': 'reported'}), REPORTED)
        self.assertEqual(cost_class({'cost_usd': 1.0, 'cost_source': 'provider-reported'}), REPORTED)

    def test_free_text_estimate_labels_are_normalized(self):
        self.assertEqual(cost_class({'cost_usd': .4, 'cost_source': 'estimated-from-total-tokens-blended-rate'}), ESTIMATED)
        self.assertEqual(cost_class({'cost_usd': .4, 'cost_source': 'estimated-from-reported-tokens'}), ESTIMATED)

    def test_absent_cost_is_unmetered_not_zero_spend(self):
        self.assertEqual(cost_class({'cost_source': 'unmetered'}), UNMETERED)
        self.assertEqual(cost_class({'cost_source': 'controller-context-not-metered'}), UNMETERED)
        self.assertEqual(cost_class({}), UNMETERED)

    def test_cost_without_provenance_is_never_promoted_to_reported(self):
        self.assertEqual(cost_class({'cost_usd': 2.0}), ESTIMATED)


class AttributionTests(unittest.TestCase):
    def test_splits_spend_and_reports_coverage_over_call_rows_only(self):
        rows = [
            {'event': 'model_call', 'cost_usd': 1.0, 'cost_source': 'reported'},
            {'event': 'model_call', 'cost_usd': .5, 'cost_source': 'estimated-from-reported-tokens'},
            {'event': 'model_call', 'model': 'x', 'cost_source': 'unmetered'},
            {'event': 'adaptive_route_decision', 'capability_class': 'architect'},
        ]
        self.assertFalse(is_call_row(rows[3]))
        summary = cost_attribution(rows)
        self.assertEqual(summary[REPORTED], {'cost': 1.0, 'calls': 1})
        self.assertEqual(summary[ESTIMATED], {'cost': .5, 'calls': 1})
        self.assertEqual(summary[UNMETERED]['calls'], 1)
        self.assertEqual(summary['call_rows'], 3)
        self.assertAlmostEqual(summary['coverage'], 2 / 3)


class DeclaredProvenanceTests(unittest.TestCase):
    def test_a_row_declaring_unmetered_is_counted_even_without_usage_fields(self):
        row = {'event': 'orchestration_telemetry_migration', 'role': 'technical_review', 'cost_source': 'unmetered'}
        self.assertTrue(is_call_row(row))
        summary = cost_attribution([row])
        self.assertEqual(summary[UNMETERED]['calls'], 1)
        self.assertEqual(summary['coverage'], 0.0)


class PricingTests(unittest.TestCase):
    def test_matches_a_region_prefixed_model_id(self):
        self.assertIsNotNone(rate_for('us.anthropic.claude-sonnet-5', PRICING))
        self.assertIsNone(rate_for('some-unlisted-model', PRICING))

    def test_prices_cached_input_separately(self):
        estimate = estimate_cost_usd(model='claude-sonnet-5', input_tokens=100_000,
                                     cached_input_tokens=90_000, output_tokens=10_000, pricing=PRICING)
        # 10k fresh @ $2/M + 90k cached @ $0.20/M + 10k output @ $10/M
        self.assertAlmostEqual(estimate['cost_usd'], .02 + .018 + .1, places=6)
        self.assertEqual(estimate['cost_source'], 'estimated-from-reported-tokens')

    def test_cache_writes_are_priced_and_alone_make_a_call_meterable(self):
        estimate = estimate_cost_usd(model='claude-sonnet-5', input_tokens=2, cache_write_tokens=1_000_000,
                                     output_tokens=0, pricing=PRICING)
        self.assertAlmostEqual(estimate['cost_usd'], 2.5 + 2 * 2.0 / 1_000_000, places=6)

    def test_unknown_model_or_zero_tokens_yields_no_estimate(self):
        self.assertIsNone(estimate_cost_usd(model='unlisted', input_tokens=1000, pricing=PRICING))
        self.assertIsNone(estimate_cost_usd(model='claude-sonnet-5', input_tokens=0, output_tokens=0,
                                            cache_write_tokens=0, pricing=PRICING))

    def test_disabled_pricing_declines_to_estimate(self):
        self.assertIsNone(estimate_cost_usd(model='claude-sonnet-5', input_tokens=1000,
                                            pricing={**PRICING, 'enabled': False}))


class MeteringAtWriteTimeTests(unittest.TestCase):
    def _store(self, directory, runtime):
        return patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(Path(directory, 'state')),
                                       'CODING_AGENT_RUNTIME': runtime,
                                       'CODING_AGENT_REPOSITORY': '/work/forge'})

    def test_token_only_runtime_gets_an_estimated_cost(self):
        with tempfile.TemporaryDirectory() as directory, self._store(directory, 'humain-terminal'):
            record = EventStore().metric(event='model_call', model='claude-sonnet-5',
                                         input_tokens=1_000_000, output_tokens=0)
            self.assertEqual(record['cost_source'], 'estimated-from-reported-tokens')
            self.assertAlmostEqual(record['cost_usd'], 2.0, places=6)

    def test_call_without_tokens_or_cost_is_labelled_unmetered(self):
        with tempfile.TemporaryDirectory() as directory, self._store(directory, 'codex'):
            record = EventStore().metric(event='model_call', role='technical_review')
            self.assertEqual(record['cost_source'], 'unmetered')
            self.assertNotIn('cost_usd', record)

    def test_reported_cost_and_existing_provenance_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory, self._store(directory, 'codex'):
            store = EventStore()
            self.assertEqual(store.metric(event='model_call', cost_usd=.25)['cost_source'], 'reported')
            kept = store.metric(event='model_call', cost_usd=.25, cost_source='estimated-by-harness')
            self.assertEqual(kept['cost_source'], 'estimated-by-harness')

    def test_non_call_metrics_are_left_alone(self):
        with tempfile.TemporaryDirectory() as directory, self._store(directory, 'codex'):
            record = EventStore().metric(event='adaptive_route_decision', capability_class='architect')
            self.assertNotIn('cost_source', record)


class DashboardAttributionTests(unittest.TestCase):
    def test_unmetered_runtime_is_distinguishable_from_free(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'metrics.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in [
                {'event': 'model_call', 'agent_runtime': 'claude-code', 'cost_usd': 1.0,
                 'cost_source': 'estimated-from-total-tokens-blended-rate'},
                {'event': 'model_call', 'agent_runtime': 'codex', 'cost_source': 'unmetered'},
                {'event': 'model_call', 'agent_runtime': 'humain-terminal', 'cost_usd': .5,
                 'cost_source': 'reported'},
                {'metric': 'tasks_accepted', 'runtime': 'humain-terminal', 'value': 3},
            ]), encoding='utf-8')
            data = build_data(root, config={})
            self.assertAlmostEqual(data['summary']['estimated_cost'], 1.0)
            self.assertAlmostEqual(data['summary']['reported_cost'], .5)
            self.assertEqual(data['summary']['unmetered_calls'], 1)
            self.assertAlmostEqual(data['summary']['cost_coverage'], 2 / 3)
            self.assertEqual(data['by_runtime']['codex']['unmetered_calls'], 1)
            self.assertEqual(data['by_runtime']['codex']['metered_calls'], 0)
            self.assertAlmostEqual(data['by_runtime']['humain-terminal']['reported_cost'], .5)
            self.assertAlmostEqual(data['by_runtime']['claude-code']['estimated_cost'], 1.0)
            # a row using the legacy `runtime` key must not pool into 'unknown'
            self.assertNotIn('unknown', data['by_runtime'])
            # `rows` counts every orchestrated record for the runtime (the `tasks_accepted` metric row
            # included); `call_rows` counts only those accountable for cost. The old single `calls`
            # key conflated the two and rendered '309 calls · 110 metered · 16 unmetered'.
            ht = data['by_runtime']['humain-terminal']
            self.assertEqual(ht['rows'], 2)
            self.assertEqual(ht['call_rows'], 1)
            # the ambiguous `calls` key is gone: it used to mean rows
            self.assertNotIn('calls', ht)
            for name, rt in data['by_runtime'].items():
                self.assertEqual(rt['metered_calls'] + rt['unmetered_calls'], rt['call_rows'],
                                 f'{name} does not reconcile')

    def test_session_ingest_rows_are_isolated_from_orchestrated_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'metrics.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in [
                {'event': 'model_call', 'source': 'session_ingest', 'role': 'interactive_session',
                 'agent_runtime': 'claude-code', 'cost_usd': 3.0, 'cost_source': 'reported'},
                {'event': 'model_call', 'role': 'interactive_session', 'agent_runtime': 'codex',
                 'cost_usd': 4.0, 'cost_source': 'reported'},
                {'event': 'model_call', 'role': 'implementer', 'agent_runtime': 'humain-terminal',
                 'cost_usd': 1.0, 'cost_source': 'reported'},
                {'event': 'model_call', 'role': 'technical_review', 'agent_runtime': 'humain-terminal',
                 'cost_usd': 2.0, 'cost_source': 'reported'},
            ]), encoding='utf-8')
            data = build_data(root, config={})
            self.assertNotIn('interactive_session', data['by_role'])
            self.assertNotIn('claude-code', data['by_runtime'])
            self.assertNotIn('codex', data['by_runtime'])
            self.assertAlmostEqual(data['summary']['total_cost'], 3.0)
            # no row carries `covers_calls`, so rows and calls agree here; they are still reported
            # as separate fields because session aggregates make them differ 13-fold on live data.
            self.assertEqual(data['interactive_sessions']['rows'], 2)
            self.assertEqual(data['interactive_sessions']['calls'], 2)
            self.assertAlmostEqual(data['interactive_sessions']['cost'], 7.0)


if __name__ == '__main__':
    unittest.main()
