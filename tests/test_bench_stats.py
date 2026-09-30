import random
from bench.stats import paired_lower_bound, quality_verdict

def arm(pass_fracs):
    return {f't{i}': {'pass_frac': p, 'all_pass': p == 1.0} for i, p in enumerate(pass_fracs)}

def test_zero_variance_is_inconclusive():
    v = quality_verdict(arm([1.0] * 20), arm([1.0] * 20))
    assert v['verdict'] == 'inconclusive'

def test_too_few_tasks_is_inconclusive():
    assert paired_lower_bound([0.1, 0.2, 0.0]) is None

def test_clear_regression_fails():
    v = quality_verdict(arm([1.0] * 20), arm([0.0] * 10 + [1.0] * 10))
    assert v['verdict'] == 'fail'

def test_lower_bound_coverage_under_null():
    # Under a true zero difference the one-sided 95% LB should fall below 0 in >= ~90% of trials.
    rng = random.Random(3); below = 0; trials = 200
    for _ in range(trials):
        diffs = [rng.choice([-1/3, 0, 0, 1/3]) for _ in range(20)]
        lb = paired_lower_bound(diffs, reps=2000, seed=rng.randint(0, 10**6))
        below += lb is None or lb <= 0
    assert below / trials >= 0.9


def test_replaced_row_kept_until_replacement_is_terminal():
    from bench.stats import task_means
    old = {'attempt_id': 'a', 'task_id': 't', 'arm': 'x', 'verdict': 'unknown', 'execution_status': 'infra_error', 'replaced_by': 'a-r1'}
    assert task_means([old], 'x')['t']['n'] == 1
    new = {'attempt_id': 'a-r1', 'task_id': 't', 'arm': 'x', 'verdict': 'pass', 'execution_status': 'completed'}
    m = task_means([old, new], 'x')['t']
    assert m['n'] == 1 and m['pass_frac'] == 1.0


def test_nonzero_exit_graded_pass_is_not_a_pass():
    from bench.stats import task_means
    rows = [{'attempt_id': 'a', 'task_id': 't', 'arm': 'x', 'verdict': 'pass', 'execution_status': 'failed'},
            {'attempt_id': 'b', 'task_id': 't', 'arm': 'x', 'verdict': 'pass', 'execution_status': 'completed'},
            {'attempt_id': 'c', 'task_id': 't', 'arm': 'x', 'verdict': 'pass'}]
    m = task_means(rows, 'x')['t']
    assert m['pass_frac'] == 2 / 3 and m['all_pass'] is False
