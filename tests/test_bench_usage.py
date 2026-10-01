import json

from bench.usage import agent_stream_cost


def _write(tmp_path, events):
    p = tmp_path / 'agent.jsonl'
    p.write_text(''.join(json.dumps(e) + '\n' for e in events) + 'not json\n')
    return p


def _assistant(total):
    usage = {'input': 1, 'output': 1}
    if total is not None:
        usage['cost'] = {'total': total}
    return {'type': 'message_end', 'message': {'role': 'assistant', 'usage': usage}}


def _subagent(kind, call, results):
    body = {'details': {'results': results}}
    return {'type': kind, 'toolName': 'subagent', 'toolCallId': call,
            **({'partialResult': body} if kind == 'tool_execution_update' else {'result': body})}


def test_sums_own_turns_and_latest_nested_snapshot(tmp_path):
    p = _write(tmp_path, [
        _assistant(0.10), {'type': 'message_end', 'message': {'role': 'user'}}, _assistant(0.05),
        _subagent('tool_execution_update', 'c1', [{'taskId': 't1', 'usage': {'cost': 0.01}}]),
        _subagent('tool_execution_update', 'c1', [{'taskId': 't1', 'usage': {'cost': 0.03}}]),   # cumulative
        _subagent('tool_execution_end', 'c1', [{'taskId': 't1', 'usage': {'cost': 0.04}},
                                               {'taskId': 't2', 'usage': {'cost': 0.02}}]),
    ])
    cost, complete = agent_stream_cost(p)
    assert round(cost, 6) == 0.21 and complete is True        # 0.10 + 0.05 + 0.04 + 0.02


def test_missing_turn_cost_marks_incomplete_never_zero(tmp_path):
    cost, complete = agent_stream_cost(_write(tmp_path, [_assistant(0.10), _assistant(None)]))
    assert round(cost, 6) == 0.10 and complete is False


def test_nested_result_without_cost_marks_incomplete(tmp_path):
    p = _write(tmp_path, [_assistant(0.10), _subagent('tool_execution_end', 'c1', [{'taskId': 't1', 'usage': {}}])])
    assert agent_stream_cost(p)[1] is False


def test_no_assistant_turn_is_unknown(tmp_path):
    assert agent_stream_cost(_write(tmp_path, [{'type': 'session'}])) == (None, False)
    assert agent_stream_cost(tmp_path / 'missing.jsonl') == (None, False)
