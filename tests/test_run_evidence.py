import json, unittest
from orchestrator.run_evidence import summarize_runs, evidence_coverage

PRICING={'enabled':True,'models':{'claude-sonnet-4-5':{'input_per_mtok':3.0,'output_per_mtok':15.0,'cache_read_per_mtok':0.3,'cache_write_per_mtok':3.75}}}

def call(run_id,task_id,**kw):
    row={'event':'model_call','run_id':run_id,'task_id':task_id,'role':'worker','capability_class':'implementation_fast','model':'anthropic/claude-sonnet-4-5','agent_runtime':'humain-terminal'}
    row.update(kw); return row

def by_run(runs):
    return {r['run_id']:r for r in runs}


class SeparateRowsTests(unittest.TestCase):
    def test_cost_verification_and_decision_rows_are_not_interchangeable(self):
        metrics=[
            {'event':'adaptive_route_decision','run_id':'r1','task_class':'crud','selected_capability':'implementation_fast'},
            call('r1','r1-t1',cost_usd=.02,cost_source='reported',input_tokens=100,output_tokens=50),
            {'event':'task_verified','run_id':'r1','task_id':'r1-t1','result':'verified','quality_evidence_score':.97},
        ]
        r=by_run(summarize_runs(metrics,[],[]))['r1']
        self.assertEqual(r['cost_provenance'],'actual')
        self.assertEqual(r['call_rows'],1)
        self.assertEqual(r['verification_rows'],1)
        self.assertEqual(r['decision_rows'],1)
        self.assertEqual(r['verified_tasks'],1)
        self.assertAlmostEqual(r['cost_known_usd'],.02)
        self.assertAlmostEqual(r['cost_reported_usd'],.02)
        self.assertEqual(r['unmetered_calls'],0)
        self.assertTrue(r['cost_complete'])

    def test_session_ingest_rows_are_excluded_even_with_run_id(self):
        metrics=[
            call('r1','r1-t1',cost_usd=.02,cost_source='reported'),
            call('r1','r1-x',cost_usd=5.0,cost_source='estimated',source='session_ingest'),
            {'event':'model_call','run_id':'r1','role':'interactive_session','cost_usd':7.0},
        ]
        r=by_run(summarize_runs(metrics,[],[]))['r1']
        self.assertEqual(r['call_rows'],1)
        self.assertAlmostEqual(r['cost_known_usd'],.02)
        self.assertEqual(r['excluded_session_ingest_rows'],2)

    def test_session_ingest_alone_never_creates_a_run(self):
        metrics=[
            call('ghost','ghost-x',cost_usd=5.0,cost_source='estimated',source='session_ingest'),
            {'event':'model_call','run_id':'ghost2','role':'interactive_session','cost_usd':7.0},
            call('real','real-t1',cost_usd=.02,cost_source='reported'),
        ]
        runs=by_run(summarize_runs(metrics,[],[]))
        self.assertEqual(set(runs),{'real'})
        self.assertEqual(runs['real']['excluded_session_ingest_rows'],0)
        # A run established by another real stream still reports how many ingest rows were dropped.
        events=[{'event':'run_started','run_id':'ghost','ts':'2026-09-23T10:00:00+00:00'}]
        runs=by_run(summarize_runs(metrics,events,[]))
        self.assertEqual(set(runs),{'real','ghost'})
        self.assertEqual(runs['ghost']['excluded_session_ingest_rows'],1)
        self.assertEqual(runs['ghost']['call_rows'],0)
        self.assertIsNone(runs['ghost']['cost_known_usd'])


class MissingDataTests(unittest.TestCase):
    def test_absent_tokens_cost_and_duration_are_unknown_not_zero(self):
        metrics=[
            call('r2','r2-a',cost_usd=.05,cost_source='reported',input_tokens=10,output_tokens=5,duration_ms=1000),
            call('r2','r2-b'),  # no cost, no tokens, no duration, no cost_source
            call('r2','r2-c',cost_source='unmetered'),
        ]
        r=by_run(summarize_runs(metrics,[],[]))['r2']
        # actual cost equals the sum of observed (metered) calls only
        self.assertAlmostEqual(r['cost_known_usd'],.05)
        self.assertEqual(r['call_rows'],3)
        self.assertEqual(r['metered_calls'],1)
        self.assertEqual(r['unmetered_calls'],2)
        self.assertNotEqual(r['unmetered_calls'],0)
        self.assertFalse(r['cost_complete'])
        self.assertAlmostEqual(r['cost_coverage'],1/3)
        self.assertEqual(r['tokens_known_calls'],1)
        self.assertEqual(r['tokens_missing_calls'],2)
        self.assertIsNone(r['elapsed_ms'])
        self.assertEqual(r['elapsed_source'],'unknown')
        self.assertEqual(r['status'],'incomplete')
        self.assertEqual(r['verification'],'unknown')
        # dispatch durations are reported for what was observed, with the missing count
        self.assertEqual(r['dispatch_duration_ms_total'],1000)
        self.assertEqual(r['duration_missing_calls'],2)

    def test_ht_crash_row_with_zero_estimated_cost_and_zero_tokens_is_unmetered(self):
        # HT's captureDispatchCost writes this exact shape when a child crashes before any usage
        # is reported: cost 0, tokens 0, cost_source 'estimated-from-reported-tokens'. Nothing was
        # measured, so it must land in the unmetered bucket, not as a metered $0 call.
        crash=call('r12','r12-crash',cost_usd=0,cost_source='estimated-from-reported-tokens',input_tokens=0,output_tokens=0,
                   cached_input_tokens=0,cache_write_tokens=0,duration_ms=0,result='fail')
        metrics=[call('r12','r12-a',cost_usd=.05,cost_source='reported',input_tokens=10,output_tokens=5),crash]
        r=by_run(summarize_runs(metrics,[],[]))['r12']
        self.assertEqual(r['call_rows'],2)
        self.assertEqual(r['metered_calls'],1)
        self.assertEqual(r['unmetered_calls'],1)
        self.assertFalse(r['cost_complete'])
        self.assertAlmostEqual(r['cost_known_usd'],.05)
        self.assertAlmostEqual(r['cost_estimated_usd'],0)
        self.assertEqual(r['tokens_known_calls'],1)
        self.assertEqual(r['tokens_missing_calls'],1)
        # A genuine estimated $0 call that did report tokens stays metered (pricing may be tiny/zero).
        priced=call('r13','r13-a',cost_usd=0,cost_source='estimated-from-reported-tokens',input_tokens=5,output_tokens=1,cost_rate_model='free-model')
        r13=by_run(summarize_runs([priced],[],[]))['r13']
        self.assertEqual(r13['metered_calls'],1)
        self.assertEqual(r13['tokens_known_calls'],1)

    def test_run_with_no_calls_has_no_cost_not_zero_cost(self):
        events=[{'event':'run_started','run_id':'r3','ts':'2026-09-23T10:00:00+00:00'}]
        r=by_run(summarize_runs([],events,[]))['r3']
        self.assertEqual(r['call_rows'],0)
        self.assertIsNone(r['cost_known_usd'])
        self.assertIsNone(r['cost_coverage'])
        self.assertIsNone(r['elapsed_ms'])


class ElapsedTests(unittest.TestCase):
    def test_elapsed_spans_parallel_workers_from_terminal_boundary(self):
        metrics=[
            call('r4','r4-w1',cost_usd=.1,cost_source='reported',duration_ms=60000),
            call('r4','r4-w2',cost_usd=.1,cost_source='reported',duration_ms=60000),
        ]
        outcomes=[{'ts':'2026-09-23T10:01:05+00:00','run_id':'r4','task_id':'run-complete','outcome':'verified','quality':1,
                   'note':json.dumps({'success_rate':1,'verification_passed':True,'retries':0}),
                   'started_at':'2026-09-23T10:00:00.000Z','finished_at':'2026-09-23T10:01:05.000Z','elapsed_ms':65000,'elapsed_source':'monotonic'}]
        r=by_run(summarize_runs(metrics,[],outcomes))['r4']
        self.assertEqual(r['elapsed_ms'],65000)
        self.assertEqual(r['elapsed_source'],'monotonic')
        self.assertEqual(r['dispatch_duration_ms_total'],120000)
        self.assertNotEqual(r['elapsed_ms'],r['dispatch_duration_ms_total'])
        self.assertEqual(r['status'],'completed')
        self.assertEqual(r['started_at'],'2026-09-23T10:00:00.000Z')
        self.assertEqual(r['finished_at'],'2026-09-23T10:01:05.000Z')
        self.assertEqual(r['verification'],'passed')
        self.assertEqual(r['tasks'],2)
        self.assertNotIn('workers',r)

    def test_elapsed_ms_without_declared_source_is_reported_not_monotonic(self):
        outcomes=[{'run_id':'r4b','task_id':'run-complete','outcome':'verified','note':'{}','elapsed_ms':4200}]
        r=by_run(summarize_runs([],[],outcomes))['r4b']
        self.assertEqual(r['elapsed_ms'],4200)
        self.assertEqual(r['elapsed_source'],'reported')
        events=[{'event':'run_completed','run_id':'r4c','elapsed_ms':100,'elapsed_source':'wall_clock'}]
        self.assertEqual(by_run(summarize_runs([],events,[]))['r4c']['elapsed_source'],'wall_clock')

    def test_elapsed_from_timestamps_when_monotonic_missing(self):
        outcomes=[{'run_id':'r5','task_id':'run-failed','outcome':'fail','note':'crashed',
                   'started_at':'2026-09-23T10:00:00+00:00','finished_at':'2026-09-23T10:00:30+00:00'}]
        r=by_run(summarize_runs([],[],outcomes))['r5']
        self.assertEqual(r['elapsed_ms'],30000)
        self.assertEqual(r['elapsed_source'],'timestamps')
        self.assertEqual(r['status'],'failed')

    def test_engine_terminal_events_with_time_fields(self):
        events=[{'event':'run_started','run_id':'r6','ts':'2026-09-23T10:00:00+00:00'},
                {'event':'run_completed','run_id':'r6','ts':'2026-09-23T10:00:09+00:00','elapsed_ms':9000}]
        r=by_run(summarize_runs([],events,[]))['r6']
        self.assertEqual(r['status'],'completed')
        self.assertEqual(r['elapsed_ms'],9000)

    def test_record_timestamps_alone_never_fabricate_elapsed(self):
        events=[{'event':'run_started','run_id':'r7','ts':'2026-09-23T10:00:00+00:00'},
                {'event':'run_completed','run_id':'r7','ts':'2026-09-23T10:00:09+00:00'}]
        r=by_run(summarize_runs([],events,[]))['r7']
        self.assertIsNone(r['elapsed_ms'])
        self.assertEqual(r['elapsed_source'],'unknown')


class VerificationAndReworkTests(unittest.TestCase):
    def test_qa_outcome_retries_and_delayed_outcomes(self):
        metrics=[
            call('r8','r8-lead',role='lead',capability_class='lead',cost_usd=.5,cost_source='reported'),
            call('r8','r8-w1',cost_usd=.1,cost_source='reported',result='fail'),
            call('r8','r8-w1-retry1',cost_usd=.1,cost_source='reported',retry=1),
            call('r8','r8-qa',role='qa_agent',capability_class='qa_agent',cost_usd=.2,cost_source='reported'),
        ]
        events=[{'event':'dispatch_started','run_id':'r8','task_id':'r8-w1-retry1','retry_of':'r8-w1'}]
        outcomes=[
            {'run_id':'r8','task_id':'r8-qa','outcome':'fail','quality':0.0,'note':'FAIL tests'},
            {'run_id':'r8','task_id':'run-complete','outcome':'verified','quality':1,'note':json.dumps({'verification_passed':False,'retries':1})},
            {'run_id':'r8','task_id':'r8-w1','reopened':True},
        ]
        r=by_run(summarize_runs(metrics,events,outcomes))['r8']
        self.assertEqual(r['verification'],'failed')
        self.assertEqual(r['retries'],1)
        self.assertTrue(r['delayed_bad_outcome'])
        self.assertAlmostEqual(r['cost_known_usd'],.9)
        self.assertAlmostEqual(r['overhead_cost_usd'],.7)
        self.assertAlmostEqual(r['implementation_cost_usd'],.2)
        self.assertAlmostEqual(r['overhead_ratio'],.7/.9)
        self.assertEqual(r['overhead_by_role'],{'lead':.5,'qa_agent':.2})


class OutcomeJoinTests(unittest.TestCase):
    """Ordinary `(run_id, task_id)` outcomes are attested verdicts and must join the run's attempt timeline.

    The shared resolver (`records.resolve_task_verification`, used by the dashboard) and `history`
    both read an outcomes-stream `outcome: 'fail'` for a task as that task failing. Run evidence
    reading only the metrics-side `task_verified` row and reporting the run `passed` was the one
    place the three disagreed.
    """
    T0='2026-09-23T10:00:00+00:00'; T1='2026-09-23T10:05:00+00:00'; T2='2026-09-23T10:10:00+00:00'

    def test_outcome_fail_after_metrics_verified_fails_the_run(self):
        metrics=[call('R','T',cost_usd=.1,cost_source='reported',ts=self.T0),
                 {'event':'task_verified','run_id':'R','task_id':'T','ts':self.T1}]
        outcomes=[{'run_id':'R','task_id':'T','outcome':'fail','ts':self.T2}]
        r=by_run(summarize_runs(metrics,[],outcomes))['R']
        self.assertEqual(r['verification'],'failed')
        self.assertEqual(r['verified_tasks'],0)
        self.assertEqual(r['verification_rows'],2)

    def test_outcome_joins_by_run_and_task_not_task_alone(self):
        # The same task id failing in another run says nothing about this run.
        metrics=[call('R','T',cost_usd=.1,cost_source='reported',ts=self.T0),
                 {'event':'task_verified','run_id':'R','task_id':'T','ts':self.T1}]
        outcomes=[{'run_id':'other','task_id':'T','outcome':'fail','ts':self.T2}]
        runs=by_run(summarize_runs(metrics,[],outcomes))
        self.assertEqual(runs['R']['verification'],'passed')
        self.assertEqual(runs['R']['verified_tasks'],1)
        self.assertEqual(runs['other']['verification'],'failed')
        # Nor does a failure on a different task of this run get pinned on T; it fails the run on its own.
        outcomes=[{'run_id':'R','task_id':'U','outcome':'fail','ts':self.T2}]
        r=by_run(summarize_runs(metrics,[],outcomes))['R']
        self.assertEqual(r['verification'],'failed')
        self.assertEqual(r['verified_tasks'],1)

    def test_latest_attested_verdict_wins_across_streams(self):
        # A later attested pass (a retry that verified) supersedes an earlier attested failure...
        metrics=[call('R','T',cost_usd=.1,cost_source='reported',ts=self.T0),
                 {'event':'task_verified','run_id':'R','task_id':'T','ts':self.T2}]
        outcomes=[{'run_id':'R','task_id':'T','outcome':'fail','ts':self.T1}]
        r=by_run(summarize_runs(metrics,[],outcomes))['R']
        self.assertEqual(r['verification'],'passed')
        self.assertEqual(r['verified_tasks'],1)
        # ...regardless of which stream carried which verdict.
        metrics=[call('R','T',cost_usd=.1,cost_source='reported',ts=self.T0),
                 {'event':'task_verified','run_id':'R','task_id':'T','result':'fail','ts':self.T1}]
        outcomes=[{'run_id':'R','task_id':'T','outcome':'verified','ts':self.T2}]
        r=by_run(summarize_runs(metrics,[],outcomes))['R']
        self.assertEqual(r['verification'],'passed')
        self.assertEqual(r['verified_tasks'],1)

    def test_same_instant_contradiction_fails_conservatively(self):
        metrics=[{'event':'task_verified','run_id':'R','task_id':'T','ts':self.T1}]
        outcomes=[{'run_id':'R','task_id':'T','outcome':'fail','ts':self.T1}]
        r=by_run(summarize_runs(metrics,[],outcomes))['R']
        self.assertEqual(r['verification'],'failed')
        self.assertEqual(r['verified_tasks'],0)
        # Stream order must not decide a tie: two same-instant rows resolve the same way in either order.
        pair=[{'event':'task_verified','run_id':'R','task_id':'T','ts':self.T1},
              {'event':'task_verified','run_id':'R','task_id':'T','result':'fail','ts':self.T1}]
        self.assertEqual(by_run(summarize_runs(pair,[],[]))['R']['verification'],'failed')
        self.assertEqual(by_run(summarize_runs(pair[::-1],[],[]))['R']['verification'],'failed')
        pair=[{'run_id':'R','task_id':'T','outcome':'verified','ts':self.T1},{'run_id':'R','task_id':'T','outcome':'fail','ts':self.T1}]
        self.assertEqual(by_run(summarize_runs([],[],pair))['R']['verification'],'failed')
        self.assertEqual(by_run(summarize_runs([],[],pair[::-1]))['R']['verification'],'failed')

    def test_missing_timestamps_never_upgrade_a_verdict(self):
        # Undated legacy rows cannot establish that a pass came after a failure: they sort before every
        # dated row and, among themselves, the failure wins whatever the stream order.
        undated_pass={'event':'task_verified','run_id':'R','task_id':'T'}
        undated_fail={'run_id':'R','task_id':'T','outcome':'fail'}
        self.assertEqual(by_run(summarize_runs([undated_pass],[],[undated_fail]))['R']['verification'],'failed')
        self.assertEqual(by_run(summarize_runs([{**undated_fail,'event':'task_failed'}],[],[{'run_id':'R','task_id':'T','outcome':'verified'}]))['R']['verification'],'failed')
        # A dated verdict supersedes an undated one in either direction.
        dated_fail={'run_id':'R','task_id':'T','outcome':'fail','ts':self.T1}
        dated_pass={'run_id':'R','task_id':'T','outcome':'verified','ts':self.T1}
        self.assertEqual(by_run(summarize_runs([undated_pass],[],[dated_fail]))['R']['verification'],'failed')
        self.assertEqual(by_run(summarize_runs([],[],[undated_fail,dated_pass]))['R']['verification'],'passed')
        # Garbage timestamps are treated as missing, not raised.
        self.assertEqual(by_run(summarize_runs([{**undated_pass,'ts':'not-a-time'}],[],[{**undated_fail,'ts':None}]))['R']['verification'],'failed')

    def test_run_scoped_qa_outcome_is_a_run_verdict_not_a_task_verification(self):
        # The bridge's `${run}-qa` gate row and the terminal summary carry `verification_scope: 'run'`;
        # they decide the run verdict once and never appear as a verified/failed *task*.
        metrics=[call('R','T',cost_usd=.1,cost_source='reported',ts=self.T0),
                 {'event':'task_verified','run_id':'R','task_id':'T','ts':self.T1}]
        outcomes=[{'run_id':'R','task_id':'R-qa','outcome':'verified','verification_scope':'run','ts':self.T2},
                  {'run_id':'R','task_id':'run-complete','outcome':'verified','verification_scope':'run','ts':self.T2,
                   'note':json.dumps({'verification_passed':True})}]
        r=by_run(summarize_runs(metrics,[],outcomes))['R']
        self.assertEqual(r['verification'],'passed')
        self.assertEqual(r['verified_tasks'],1)
        self.assertEqual(r['verification_rows'],1)
        # A legacy `-qa` row without the scope marker is still the run gate, not a second task.
        outcomes=[{'run_id':'R','task_id':'R-qa','outcome':'verified','ts':self.T2}]
        r=by_run(summarize_runs(metrics,[],outcomes))['R']
        self.assertEqual(r['verification'],'passed')
        self.assertEqual(r['verified_tasks'],1)
        self.assertEqual(r['verification_rows'],1)
        # And a failing run gate fails the run even when every task verified.
        outcomes=[{'run_id':'R','task_id':'R-qa','outcome':'fail','verification_scope':'run','ts':self.T2}]
        r=by_run(summarize_runs(metrics,[],outcomes))['R']
        self.assertEqual(r['verification'],'failed')
        self.assertEqual(r['verified_tasks'],1)

    def test_joined_outcomes_add_no_cost_rows(self):
        metrics=[call('R','T',cost_usd=.1,cost_source='reported',input_tokens=10,output_tokens=5,duration_ms=100,ts=self.T0)]
        before=by_run(summarize_runs(metrics,[],[]))['R']
        outcomes=[{'run_id':'R','task_id':'T','outcome':'fail','cost_usd':9.0,'input_tokens':999,'duration_ms':999,'ts':self.T1},
                  {'run_id':'R','task_id':'U','outcome':'verified','ts':self.T1}]
        after=by_run(summarize_runs(metrics,[],outcomes))['R']
        for k in ('call_rows','metered_calls','unmetered_calls','cost_known_usd','cost_reported_usd','input_tokens','output_tokens',
                  'dispatch_duration_ms_total','duration_missing_calls','tasks','roles','overhead_cost_usd','implementation_cost_usd'):
            self.assertEqual(after[k],before[k],k)
        self.assertEqual(after['verification'],'failed')
        self.assertEqual(after['verified_tasks'],1)
        self.assertEqual(after['verification_rows'],2)


class CounterfactualTests(unittest.TestCase):
    def test_flat_baseline_is_labelled_counterfactual_and_never_claims_savings_without_coverage(self):
        metrics=[
            call('r9','r9-a',cost_usd=.02,cost_source='reported',input_tokens=1000,output_tokens=1000),
            call('r9','r9-b',cost_usd=.5,cost_source='reported'),  # reported cost, but no tokens to reprice
        ]
        r=by_run(summarize_runs(metrics,[],[],baseline_model='claude-sonnet-4-5',pricing=PRICING))['r9']
        cf=r['counterfactual']
        self.assertEqual(cf['provenance'],'counterfactual')
        self.assertEqual(cf['baseline_model'],'claude-sonnet-4-5')
        self.assertAlmostEqual(cf['cost_usd'],(1000*3.0+1000*15.0)/1e6)
        self.assertEqual(cf['priced_calls'],1)
        self.assertEqual(cf['unpriced_calls'],1)
        self.assertFalse(cf['comparable'])
        self.assertIsNone(cf['delta_usd'])
        self.assertIn('coverage',cf['reason'])

    def test_full_coverage_reports_delta_but_still_counterfactual(self):
        metrics=[call('r10','r10-a',cost_usd=.5,cost_source='reported',input_tokens=1000,output_tokens=1000)]
        r=by_run(summarize_runs(metrics,[],[],baseline_model='claude-sonnet-4-5',pricing=PRICING))['r10']
        cf=r['counterfactual']
        self.assertTrue(cf['comparable'])
        self.assertAlmostEqual(cf['delta_usd'],.5-.018)
        self.assertEqual(cf['provenance'],'counterfactual')

    def test_no_baseline_means_no_counterfactual_block(self):
        r=by_run(summarize_runs([call('r11','r11-a',cost_usd=.5,cost_source='reported')],[],[]))['r11']
        self.assertIsNone(r['counterfactual'])


class OrderingTests(unittest.TestCase):
    def test_runs_are_ordered_by_earliest_observed_time_not_stream_order(self):
        metrics=[call('new','new-a',cost_usd=.1,cost_source='reported',ts='2026-09-23T12:00:00+00:00')]
        outcomes=[{'run_id':'old','task_id':'run-complete','outcome':'verified','note':'{}','ts':'2026-09-22T09:00:00+00:00'}]
        events=[{'event':'run_started','run_id':'mid','ts':'2026-09-23T10:00:00+00:00'}]
        self.assertEqual([r['run_id'] for r in summarize_runs(metrics,events,outcomes)],['old','mid','new'])
        # Ordering never fabricates a duration: `ts` is used for sequence only.
        self.assertTrue(all(r['elapsed_ms'] is None for r in summarize_runs(metrics,events,outcomes)))
        # Runs with no timestamp at all keep their first-seen position after the timestamped ones.
        metrics.append(call('nots','nots-a',cost_usd=.1,cost_source='reported'))
        self.assertEqual([r['run_id'] for r in summarize_runs(metrics,events,outcomes)][-1],'nots')


class CoverageTests(unittest.TestCase):
    def test_evidence_coverage_counts_runs_not_rows(self):
        metrics=[
            call('c1','c1-a',cost_usd=.1,cost_source='reported'),
            call('c1','c1-b',cost_usd=.1,cost_source='reported'),
            call('c2','c2-a'),
            call('c2','c2-b',cost_usd=.1,cost_source='reported'),
        ]
        outcomes=[{'run_id':'c1','task_id':'run-complete','outcome':'verified','note':json.dumps({'verification_passed':True}),'elapsed_ms':1000,
                   'started_at':'2026-09-23T10:00:00+00:00','finished_at':'2026-09-23T10:00:01+00:00'}]
        runs=summarize_runs(metrics,[],outcomes)
        cov=evidence_coverage(runs)
        self.assertEqual(cov['runs'],2)
        self.assertEqual(cov['runs_completed'],1)
        self.assertEqual(cov['runs_fully_priced'],1)
        self.assertEqual(cov['runs_with_elapsed'],1)
        self.assertEqual(cov['runs_with_verification'],1)
        self.assertAlmostEqual(cov['priced_run_coverage'],.5)
        self.assertAlmostEqual(cov['duration_coverage'],.5)
        self.assertEqual(cov['unmetered_calls'],1)
        self.assertEqual(cov['call_rows'],4)
        self.assertEqual(cov['cost_provenance'],'actual')


if __name__=='__main__': unittest.main()


def cap_event(run_id, task_id, **kw):
    row = {'event': 'spend_cap_exceeded', 'run_id': run_id, 'task_id': task_id, 'capability': 'lead_large',
           'model': 'bedrock/fable', 'cap_usd': 10, 'cost_usd': 10.02486, 'nested_cost_usd': 5.26763,
           'action': 'warn', 'ts': '2026-09-24T20:09:22.979Z', 'record_id': f'cap-{run_id}-{task_id}'}
    row.update(kw); return row


class SpendCapTests(unittest.TestCase):
    def test_run_without_breach_has_empty_hits(self):
        run = by_run(summarize_runs([call('r1', 't1', cost_usd=0.1, cost_source='reported')], [], []))['r1']
        self.assertEqual(run['spend_cap_hits'], [])
        self.assertFalse(run['spend_cap_hit'])

    def test_breach_is_joined_to_its_run_with_overage_and_subagent_share(self):
        runs = by_run(summarize_runs([call('r1', 'r1-lead-0', cost_usd=10.0, cost_source='reported')],
                                     [cap_event('r1', 'r1-lead-0')], []))
        run = runs['r1']
        self.assertTrue(run['spend_cap_hit'])
        (hit,) = run['spend_cap_hits']
        self.assertEqual(hit['task_id'], 'r1-lead-0')
        self.assertEqual(hit['capability'], 'lead_large')
        self.assertEqual(hit['action'], 'warn')
        self.assertAlmostEqual(hit['over_usd'], 0.02486)
        self.assertAlmostEqual(hit['over_ratio'], 1.002486)
        self.assertAlmostEqual(hit['nested_share'], 5.26763 / 10.02486)

    def test_malformed_amounts_are_unknown_not_zero(self):
        runs = by_run(summarize_runs([], [cap_event('r1', 't', cap_usd=None, cost_usd='bogus', nested_cost_usd=None)], []))
        (hit,) = runs['r1']['spend_cap_hits']
        for key in ('cap_usd', 'cost_usd', 'nested_cost_usd', 'over_usd', 'over_ratio', 'nested_share'):
            self.assertIsNone(hit[key], key)

    def test_duplicate_records_count_once(self):
        e = cap_event('r1', 't')
        runs = by_run(summarize_runs([], [e, dict(e)], []))
        self.assertEqual(len(runs['r1']['spend_cap_hits']), 1)
