import json, tempfile, unittest
from pathlib import Path
from orchestrator.features import FeaturePolicy, validate_features
from orchestrator.adaptive import adaptive_route, deterministic_coin, should_canary
from orchestrator.controls import promotion_action, verification_plan, approval_for, budget_action, stop_loss_action
from orchestrator.policy_simulation import simulate_policy


class V3FeatureTests(unittest.TestCase):
    def base_features(self):
        return json.loads(Path('orchestrator/config.json').read_text())['features']

    def test_feature_inheritance(self):
        f=FeaturePolicy(self.base_features()).resolve(
            repo_overrides={'adaptive_routing':{'mode':'observe'}},
            task_overrides={'adaptive_routing':{'mode':'enforce'}})
        self.assertEqual(f['adaptive_routing']['mode'],'enforce')
        self.assertTrue(f['historical_learning']['enabled'])

    def test_invalid_mode_rejected(self):
        f=self.base_features(); f['adaptive_routing']['mode']='magic'
        self.assertTrue(validate_features(f))

    def test_deterministic_coin(self):
        self.assertEqual(deterministic_coin('abc',.5), deterministic_coin('abc',.5))
        self.assertEqual(should_canary('run-1',5), should_canary('run-1',5))

    def test_recommend_does_not_execute_empirical(self):
        f=self.base_features(); f['adaptive_routing']['mode']='recommend'; f['historical_learning']['minimum_samples']=1
        stats=[{'task_class':'crud','complexity_bucket':'3-4','risk':'low','capability':'implementation_strong','effort':'standard','verification_depth':'broad','samples':20,'effective_samples':20,'verified_cost_usd':.01,'avg_quality_evidence':.99,'delayed_failure_rate':0}]
        r=adaptive_route(run_id='x',task_class='crud',complexity=3,risk='low',quality_floor=.9,cost_aggressiveness=.8,stats=stats,features=f,default_efforts={'implementation_fast':'low','implementation_strong':'standard'},min_samples=1)
        self.assertEqual(r['mode'],'recommend')
        self.assertEqual(r['selected'],r['default'])

    def test_enforce_needs_history(self):
        f=self.base_features(); f['adaptive_routing']['mode']='enforce'; f['historical_learning']['minimum_samples']=20
        r=adaptive_route(run_id='x',task_class='new',complexity=5,risk='medium',quality_floor=.95,cost_aggressiveness=.7,stats=[],features=f,default_efforts={'implementation_fast':'low','implementation_strong':'standard'},min_samples=20)
        self.assertEqual(r['explanation']['action'],'fallback_insufficient_history')

    def test_controls(self):
        f=self.base_features()
        self.assertEqual(promotion_action(features=f,conceptual_failures=1),'promote_capability')
        self.assertTrue(verification_plan(features=f,risk='high')['integration_tests'])
        self.assertEqual(approval_for(features=f,action='destructive'),'deny')
        self.assertEqual(budget_action(features=f,spent=2,budget=1),'warn')
        self.assertEqual(stop_loss_action(features=f,expected_cost=1,actual_cost=4),'replan')

    def test_policy_simulation_empty(self):
        s=simulate_policy(stats=[],quality_floor=.95,cost_aggressiveness=.7)
        self.assertTrue(s['estimated'])
        self.assertIsNone(s['estimated_avg_verified_cost_usd'])

if __name__=='__main__': unittest.main()
