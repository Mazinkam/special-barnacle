import json
import os
from pathlib import Path

from bench.contamination import scan_attempt, tool_locations


def _write(path: Path, events):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(e) + '\n' for e in events))


def _tools(tmp_path):
    skill = tmp_path / 'tools' / 'skill'; skill.mkdir(parents=True)
    bindir = tmp_path / 'tools' / 'ht' / 'bin'; bindir.mkdir(parents=True)
    return [os.path.realpath(skill), os.path.realpath(bindir)]


def test_bash_tool_call_reading_the_tool_dir_is_flagged(tmp_path):
    locs = _tools(tmp_path)
    work = tmp_path / 'attempt'
    _write(work / 'agent.jsonl', [
        {'type': 'tool_execution_start', 'toolCallId': '1', 'toolName': 'bash',
         'args': {'command': f'grep -r fix {locs[0]}/orchestrator | head'}}])
    contaminated, evidence = scan_attempt(work / 'agent.jsonl', [], locs)
    assert contaminated and len(evidence) == 1 and 'bash' in evidence[0] and 'agent.jsonl' in evidence[0]
    assert len(evidence[0]) <= 200


def test_assistant_tool_call_block_is_flagged(tmp_path):
    locs = _tools(tmp_path)
    work = tmp_path / 'attempt'
    _write(work / 'agent.jsonl', [{'type': 'message_end', 'message': {'role': 'assistant', 'content': [
        {'type': 'text', 'text': 'reading'},
        {'type': 'toolCall', 'id': 'c', 'name': 'read', 'arguments': {'path': f'{locs[1]}/cli.js'}}]}}])
    contaminated, evidence = scan_attempt(work / 'agent.jsonl', [], locs)
    assert contaminated and 'read' in evidence[0]


def test_prompt_header_and_result_mentions_are_not_flagged(tmp_path):
    locs = _tools(tmp_path)
    work = tmp_path / 'attempt'
    _write(work / 'agent.jsonl', [
        {'type': 'session', 'cwd': str(work), 'systemPrompt': f'extension loaded from {locs[0]}'},
        {'type': 'message_start', 'message': {'role': 'system', 'content': f'skill root {locs[0]}'}},
        {'type': 'message_end', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': f'see {locs[0]}'}]}},
        {'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': f'I will not read {locs[1]}'}]}},
        {'type': 'tool_execution_start', 'toolName': 'bash', 'args': {'command': 'ls'}},
        {'type': 'tool_execution_end', 'toolName': 'bash', 'result': {'content': [{'type': 'text', 'text': locs[0]}]}},
        {'type': 'tool_execution_start', 'toolName': 'read', 'args': {'path': locs[0] + '2/x.py'}},   # a sibling, not inside
    ])
    (work / 'noise.jsonl').write_text('not json\n')
    assert scan_attempt(work / 'agent.jsonl', [], locs) == (False, [])


def test_child_event_logs_of_the_attempts_runs_are_scanned(tmp_path):
    locs = _tools(tmp_path)
    runs = tmp_path / 'exp' / 'state' / 'runs'
    _write(runs / 'r-new' / 'T1.events.jsonl', [
        {'type': 'tool_execution_start', 'toolName': 'read', 'args': {'path': f'{locs[0]}/SKILL.md'}}] * 7)
    _write(runs / 'r-new' / 'T1.prompt.md', [{'x': locs[0]}])   # not an events log
    _write(tmp_path / 'attempt' / 'agent.jsonl', [])
    contaminated, evidence = scan_attempt(tmp_path / 'attempt' / 'agent.jsonl', [runs / 'r-new'], locs)
    assert contaminated and len(evidence) <= 5 and all('T1.events.jsonl' in e for e in evidence)


def test_tool_locations_cover_skill_root_and_binary_dir(tmp_path, fake_cfg):
    import dataclasses
    skill = tmp_path / 'skill'; skill.mkdir()
    cli = tmp_path / 'ht' / 'bundle' / 'cli.js'; cli.parent.mkdir(parents=True); cli.write_text('')
    cfg = dataclasses.replace(fake_cfg, skill_root=skill, binary=str(cli))
    locs = tool_locations(cfg)
    assert os.path.realpath(skill) in locs and os.path.realpath(cli.parent) in locs


def test_runner_journals_contamination(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    from bench.runner import run_experiment
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', f'toolcall:{fake_cfg.skill_root}/orchestrator/method.json')
    journal = run_experiment(tiny_suite, fake_cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    row = [json.loads(line) for line in journal.read_text().splitlines() if '"started"' not in line][0]
    assert row['contaminated'] is True and row['contamination_evidence']
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'noop')
    journal = run_experiment(tiny_suite, fake_cfg, ('direct',), tmp_path / 'exp2', approve_usd=100, sandbox=False)
    row = [json.loads(line) for line in journal.read_text().splitlines() if '"started"' not in line][0]
    assert row['contaminated'] is False and row['contamination_evidence'] == []
