"""Tests for natural-language workflow generation.

The OpenAI call is mocked (no network, no key), so these exercise the prompt
wiring, the JSON parsing/validation, and — via five representative model outputs
for five different prompts — that the pipeline yields valid, loadable graphs.
"""
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from services.generate import (
    KNOWN_NODE_TYPES,
    SYSTEM_PROMPT,
    _EXAMPLES,
    _validate_graph,
    generate_workflow,
)


# --- Five prompts → five representative gpt-4o outputs -----------------------
# Built as dicts (always valid JSON) covering the breadth of node types: a
# branching condition, scheduled reporting, AI classify+route, AI extract+POST,
# and a simple scheduled log. Each stands in for what the model would return.

def _node(node_id, node_type, x, y, config):
    return {
        'id': node_id,
        'type': node_type,
        'position': {'x': x, 'y': y},
        'data': {'label': node_id.title(), 'config': config},
    }


def _edge(eid, source, target, handle=None):
    return {'id': eid, 'source': source, 'target': target, 'sourceHandle': handle}


PROMPT_FIXTURES = [
    (
        'Notify me on Slack when a webhook receives a payment over $100',
        {
            'nodes': [
                _node('trigger', 'trigger-webhook', 250, 60, {}),
                _node('check', 'condition', 250, 200, {
                    'left': '{{trigger.amount}}', 'operator': 'greater_than', 'right': '100'}),
                _node('slack', 'action-slack', 120, 340, {
                    'webhookUrl': 'https://hooks.slack.com/services/X', 'text': '${{trigger.amount}}'}),
                _node('log', 'output-log', 380, 340, {'message': 'small payment'}),
            ],
            'edges': [
                _edge('e1', 'trigger', 'check'),
                _edge('e2', 'check', 'slack', 'true'),
                _edge('e3', 'check', 'log', 'false'),
            ],
        },
    ),
    (
        'Every Monday morning fetch our sales data and email me a summary',
        {
            'nodes': [
                _node('trigger', 'trigger-schedule', 250, 60, {'cron': '0 9 * * 1'}),
                _node('fetch', 'action-http', 250, 200, {
                    'method': 'GET', 'url': 'https://api.example.com/sales', 'headers': '{}', 'body': ''}),
                _node('summary', 'ai-prompt', 250, 340, {
                    'prompt': 'Summarize: {{fetch.body}}', 'system': 'Be concise.'}),
                _node('email', 'action-email', 250, 480, {
                    'to': 'me@example.com', 'subject': 'Sales', 'body': '{{summary.text}}'}),
            ],
            'edges': [
                _edge('e1', 'trigger', 'fetch'),
                _edge('e2', 'fetch', 'summary'),
                _edge('e3', 'summary', 'email'),
            ],
        },
    ),
    (
        'Classify incoming support tickets and route urgent ones to Slack',
        {
            'nodes': [
                _node('trigger', 'trigger-webhook', 250, 60, {}),
                _node('classify', 'ai-classify', 250, 200, {
                    'text': '{{trigger.message}}', 'labels': 'urgent, normal'}),
                _node('check', 'condition', 250, 340, {
                    'left': '{{classify.label}}', 'operator': 'equals', 'right': 'urgent'}),
                _node('slack', 'action-slack', 120, 480, {
                    'webhookUrl': 'https://hooks.slack.com/services/X', 'text': '{{trigger.message}}'}),
                _node('log', 'output-log', 380, 480, {'message': '{{trigger.message}}'}),
            ],
            'edges': [
                _edge('e1', 'trigger', 'classify'),
                _edge('e2', 'classify', 'check'),
                _edge('e3', 'check', 'slack', 'true'),
                _edge('e4', 'check', 'log', 'false'),
            ],
        },
    ),
    (
        'When a webhook receives a new signup, extract the name and email and add them to our CRM',
        {
            'nodes': [
                _node('trigger', 'trigger-webhook', 250, 60, {}),
                _node('extract', 'ai-extract', 250, 200, {
                    'text': '{{trigger.body}}', 'fields': 'name, email'}),
                _node('crm', 'action-http', 250, 340, {
                    'method': 'POST', 'url': 'https://api.example.com/crm',
                    'headers': '{"Content-Type":"application/json"}',
                    'body': '{"name":"{{extract.data.name}}","email":"{{extract.data.email}}"}'}),
            ],
            'edges': [
                _edge('e1', 'trigger', 'extract'),
                _edge('e2', 'extract', 'crm'),
            ],
        },
    ),
    (
        'Run every day at 9am, call our status API, and log the response',
        {
            'nodes': [
                _node('trigger', 'trigger-schedule', 250, 60, {'cron': '0 9 * * *'}),
                _node('status', 'action-http', 250, 200, {
                    'method': 'GET', 'url': 'https://api.example.com/status', 'headers': '{}', 'body': ''}),
                _node('log', 'output-log', 250, 340, {'message': '{{status.body}}'}),
            ],
            'edges': [
                _edge('e1', 'trigger', 'status'),
                _edge('e2', 'status', 'log'),
            ],
        },
    ),
]


def fake_client(content):
    """Stand-in OpenAI client whose completion returns `content`."""
    client = MagicMock()
    client.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
    )
    return client


class TestGenerateProducesLoadableGraphs:
    """Five different prompts must each yield a valid, loadable graph."""

    @pytest.mark.parametrize('prompt,graph', PROMPT_FIXTURES, ids=[p[:25] for p in (f[0] for f in PROMPT_FIXTURES)])
    def test_prompt_yields_valid_loadable_graph(self, prompt, graph):
        with patch('services.llm.chat', return_value=json.dumps(graph)):
            result = generate_workflow(prompt)

        # Shape the canvas expects.
        assert isinstance(result['nodes'], list) and result['nodes']
        assert isinstance(result['edges'], list)
        # Loadable: every node type renders on the canvas...
        for node in result['nodes']:
            assert node['type'] in KNOWN_NODE_TYPES
        # ...and every edge connects two real nodes.
        ids = {n['id'] for n in result['nodes']}
        for edge in result['edges']:
            assert edge['source'] in ids
            assert edge['target'] in ids
        # And it passes the validator without raising.
        _validate_graph(result)

    def test_all_five_prompts_are_distinct(self):
        assert len({p for p, _ in PROMPT_FIXTURES}) == 5


class TestGenerateWorkflow:
    @patch('services.llm.chat')
    def test_strips_markdown_code_fences(self, mock_chat):
        graph = {'nodes': [_node('t', 'trigger-manual', 0, 0, {})], 'edges': []}
        mock_chat.return_value = '```json\n' + json.dumps(graph) + '\n```'
        result = generate_workflow('start manually then stop')
        assert result['nodes'][0]['id'] == 't'

    @patch('services.llm.chat')
    def test_uses_gpt_4o_at_low_temperature_with_system_prompt(self, mock_chat):
        mock_chat.return_value = json.dumps(
            {'nodes': [_node('t', 'trigger-manual', 0, 0, {})], 'edges': []}
        )
        generate_workflow('anything')
        kwargs = mock_chat.call_args.kwargs
        assert kwargs['model'] == 'gpt-4o'          # not -mini: needs reasoning
        assert kwargs['temperature'] == 0.2
        assert kwargs['system'] is SYSTEM_PROMPT

    @patch('services.llm.chat')
    def test_blank_prompt_raises(self, mock_chat):
        with pytest.raises(ValueError, match='prompt is required'):
            generate_workflow('   ')
        mock_chat.assert_not_called()

    @patch('services.llm.chat')
    def test_non_json_response_raises(self, mock_chat):
        mock_chat.return_value = 'Sure! Here is a workflow for you.'
        with pytest.raises(ValueError, match='did not return valid JSON'):
            generate_workflow('do something')


class TestValidateGraph:
    def test_rejects_non_object(self):
        with pytest.raises(ValueError, match='must be a JSON object'):
            _validate_graph(['not', 'a', 'dict'])

    def test_rejects_missing_nodes_array(self):
        with pytest.raises(ValueError, match='missing a nodes array'):
            _validate_graph({'edges': []})

    def test_rejects_missing_edges_array(self):
        with pytest.raises(ValueError, match='missing an edges array'):
            _validate_graph({'nodes': [_node('t', 'trigger-manual', 0, 0, {})]})

    def test_rejects_empty_nodes(self):
        with pytest.raises(ValueError, match='has no nodes'):
            _validate_graph({'nodes': [], 'edges': []})

    def test_rejects_unknown_node_type(self):
        graph = {'nodes': [_node('t', 'action-teleport', 0, 0, {})], 'edges': []}
        with pytest.raises(ValueError, match='Unknown node type'):
            _validate_graph(graph)

    def test_rejects_duplicate_node_ids(self):
        graph = {
            'nodes': [_node('t', 'trigger-manual', 0, 0, {}), _node('t', 'output-log', 0, 1, {})],
            'edges': [],
        }
        with pytest.raises(ValueError, match='Duplicate node id'):
            _validate_graph(graph)

    def test_rejects_non_object_node(self):
        with pytest.raises(ValueError, match='node must be an object'):
            _validate_graph({'nodes': ['just a string'], 'edges': []})

    def test_rejects_non_object_edge(self):
        graph = {'nodes': [_node('t', 'trigger-manual', 0, 0, {})], 'edges': ['nope']}
        with pytest.raises(ValueError, match='edge must be an object'):
            _validate_graph(graph)

    def test_rejects_node_without_id(self):
        graph = {'nodes': [{'type': 'trigger-manual', 'data': {}}], 'edges': []}
        with pytest.raises(ValueError, match='string id'):
            _validate_graph(graph)

    def test_rejects_edge_to_missing_node(self):
        graph = {
            'nodes': [_node('t', 'trigger-manual', 0, 0, {})],
            'edges': [_edge('e1', 't', 'ghost')],
        }
        with pytest.raises(ValueError, match='connect two existing nodes'):
            _validate_graph(graph)

    def test_accepts_a_well_formed_graph(self):
        graph = PROMPT_FIXTURES[0][1]
        _validate_graph(graph)  # should not raise


class TestSystemPrompt:
    def test_lists_every_known_node_type(self):
        for node_type in KNOWN_NODE_TYPES:
            assert node_type in SYSTEM_PROMPT

    def test_explains_condition_branch_handles_and_forbids_fences(self):
        assert 'sourceHandle' in SYSTEM_PROMPT
        assert '"true"' in SYSTEM_PROMPT and '"false"' in SYSTEM_PROMPT
        assert 'no markdown' in SYSTEM_PROMPT.lower() or 'no code fences' in SYSTEM_PROMPT.lower()

    def test_embeds_three_examples(self):
        assert len(_EXAMPLES) == 3
        assert SYSTEM_PROMPT.count('Example ') >= 3

    def test_each_embedded_example_is_itself_valid(self):
        # The few-shot anchors must obey the same rules we ask the model to follow.
        for _desc, graph in _EXAMPLES:
            _validate_graph(graph)


class TestGenerateWithMockedOpenAI:
    """End-to-end through the real llm layer against a fake OpenAI client."""

    def test_parses_graph_from_a_mocked_completion(self):
        graph = PROMPT_FIXTURES[1][1]
        client = fake_client(json.dumps(graph))
        with patch('services.llm.get_client', return_value=client):
            result = generate_workflow('weekly sales email')

        assert result['nodes'][0]['type'] == 'trigger-schedule'
        kwargs = client.chat.completions.create.call_args.kwargs
        assert kwargs['model'] == 'gpt-4o'
        assert kwargs['messages'][0]['role'] == 'system'
        assert kwargs['messages'][-1]['content'] == 'weekly sales email'

    def test_surfaces_a_failing_completion(self):
        client = MagicMock()
        client.chat.completions.create.side_effect = RuntimeError('rate limited')
        with patch('services.llm.get_client', return_value=client):
            with pytest.raises(RuntimeError, match='rate limited'):
                generate_workflow('anything')


class TestRoutes:
    def test_generate_requires_prompt(self):
        from app import app
        client = app.test_client()
        res = client.post('/generate', json={})
        assert res.status_code == 400
        assert 'error' in res.get_json()

    def test_generate_returns_graph_data_on_success(self):
        from app import app
        graph = PROMPT_FIXTURES[0][1]
        with patch('services.generate.llm.chat', return_value=json.dumps(graph)):
            client = app.test_client()
            res = client.post('/generate', json={'prompt': 'pay alert'})
        assert res.status_code == 200
        body = res.get_json()
        assert 'graph_data' in body
        assert body['graph_data']['nodes'][0]['id'] == 'trigger'

    def test_generate_returns_error_on_bad_model_output(self):
        from app import app
        with patch('services.generate.llm.chat', return_value='not json'):
            client = app.test_client()
            res = client.post('/generate', json={'prompt': 'pay alert'})
        assert res.status_code == 500
        assert 'error' in res.get_json()
