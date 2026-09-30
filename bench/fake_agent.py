#!/usr/bin/env python3
"""Zero-spend stand-in for humain-terminal used by runner tests (spec §2.6)."""
import json, os, subprocess, sys, time
from pathlib import Path

behaviour = os.environ.get('BENCH_FAKE_BEHAVIOUR', 'noop')
state = Path(os.environ['CODING_AGENT_ORCHESTRATOR_HOME']); state.mkdir(parents=True, exist_ok=True)
run_id = f"fake-{time.time_ns()}"
now = time.strftime('%Y-%m-%dT%H:%M:%S+00:00', time.gmtime())
with (state / 'metrics.jsonl').open('a') as fh:
    fh.write(json.dumps({'event': 'model_call', 'run_id': run_id, 'task_id': f'{run_id}-t', 'model': 'fake/m', 'cost_usd': 0.01,
                         'cost_source': 'reported', 'input_tokens': 10, 'output_tokens': 5, 'complexity': 2, 'risk': 'low'}) + '\n')
with (state / 'events.jsonl').open('a') as fh:
    fh.write(json.dumps({'event': 'run_started', 'run_id': run_id, 'started_at': now, 'ts': now}) + '\n')
if behaviour.startswith('sleep:'):
    time.sleep(float(behaviour.split(':', 1)[1]))
elif behaviour.startswith('toolcall:'):   # a bash tool call reading the given path, as --mode json records it
    print(json.dumps({'type': 'tool_execution_start', 'toolCallId': 'c1', 'toolName': 'bash',
                      'args': {'command': f"cat {behaviour.split(':', 1)[1]}"}}))
elif behaviour.startswith('apply:'):
    subprocess.run(['git', 'apply', behaviour.split(':', 1)[1]], check=True)
with (state / 'outcomes.jsonl').open('a') as fh:
    fh.write(json.dumps({'run_id': run_id, 'task_id': 'run-complete', 'outcome': 'verified', 'note': json.dumps({'fix_rounds': 0}),
                         'elapsed_ms': 10, 'elapsed_source': 'monotonic'}) + '\n')
print(json.dumps({'type': 'done', 'run_id': run_id}))
sys.exit(0)
