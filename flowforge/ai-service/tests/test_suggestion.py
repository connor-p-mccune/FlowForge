import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from services.suggestion import get_node_suggestions, build_node_summary


class TestBuildNodeSummary:
    def test_empty_workflow(self):
        result = build_node_summary([], [])
        assert result == 'Empty workflow (no nodes yet)'

    def test_single_node_no_edges(self):
        nodes = [{'id': '1', 'type': 'trigger-manual', 'data': {'label': 'Start'}}]
        result = build_node_summary(nodes, [])
        assert 'Start' in result
        assert 'trigger-manual' in result

    def test_node_with_connection(self):
        nodes = [
            {'id': '1', 'type': 'trigger-manual', 'data': {'label': 'Start'}},
            {'id': '2', 'type': 'action-http', 'data': {'label': 'Fetch'}},
        ]
        edges = [{'source': '1', 'target': '2'}]
        result = build_node_summary(nodes, edges)
        assert '→' in result
        assert '2' in result

    def test_branching_node_lists_all_its_targets(self):
        nodes = [
            {'id': '1', 'type': 'condition', 'data': {'label': 'Check'}},
            {'id': '2', 'type': 'output-log', 'data': {'label': 'Yes'}},
            {'id': '3', 'type': 'output-log', 'data': {'label': 'No'}},
        ]
        edges = [{'source': '1', 'target': '2'}, {'source': '1', 'target': '3'}]
        result = build_node_summary(nodes, edges)
        assert "['2', '3']" in result  # both branch targets shown
        assert 'Check' in result

    def test_one_line_per_node(self):
        nodes = [
            {'id': '1', 'type': 'trigger-manual', 'data': {'label': 'Start'}},
            {'id': '2', 'type': 'action-http', 'data': {'label': 'Fetch'}},
            {'id': '3', 'type': 'output-log', 'data': {'label': 'Done'}},
        ]
        result = build_node_summary(nodes, [])
        assert len(result.splitlines()) == 3

    def test_falls_back_to_type_when_label_missing(self):
        nodes = [{'id': '1', 'type': 'action-http', 'data': {}}]
        result = build_node_summary(nodes, [])
        assert 'action-http' in result


class TestGetNodeSuggestions:
    @patch('services.llm.chat')
    def test_returns_list_of_suggestions(self, mock_chat):
        suggestions = [
            {'type': 'action-http', 'label': 'Fetch data', 'reason': 'Common next step'}
        ]
        mock_chat.return_value = json.dumps(suggestions)

        nodes = [{'id': '1', 'type': 'trigger-manual', 'data': {'label': 'Start'}}]
        result = get_node_suggestions(nodes, [], last_node_type='trigger-manual')

        assert isinstance(result, list)
        assert len(result) == 1
        assert result[0]['type'] == 'action-http'

    @patch('services.llm.chat')
    def test_strips_markdown_code_fences(self, mock_chat):
        suggestions = [{'type': 'output-log', 'label': 'Log result', 'reason': 'End of flow'}]
        mock_chat.return_value = '```json\n' + json.dumps(suggestions) + '\n```'

        result = get_node_suggestions([], [], last_node_type=None)
        assert isinstance(result, list)
        assert result[0]['type'] == 'output-log'

    @patch('services.llm.chat')
    def test_wraps_single_object_in_list(self, mock_chat):
        mock_chat.return_value = json.dumps(
            {'type': 'trigger-manual', 'label': 'Manual trigger', 'reason': 'Start'}
        )
        result = get_node_suggestions([], [], last_node_type=None)
        assert isinstance(result, list)
        assert len(result) == 1

    @patch('services.llm.chat')
    def test_propagates_llm_errors(self, mock_chat):
        mock_chat.side_effect = RuntimeError('OpenAI unavailable')
        with pytest.raises(RuntimeError, match='OpenAI unavailable'):
            get_node_suggestions([], [], last_node_type=None)

    @patch('services.llm.chat')
    def test_raises_on_unparseable_response(self, mock_chat):
        mock_chat.return_value = 'sorry, I cannot help with that'
        with pytest.raises(json.JSONDecodeError):
            get_node_suggestions([], [])


class TestGetNodeSuggestionsWithMockedOpenAI:
    """Exercise suggestion + llm together against a fake OpenAI client."""

    def _client_returning(self, content):
        client = MagicMock()
        client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        )
        return client

    def test_parses_suggestions_from_a_mocked_completion(self):
        suggestions = [{'type': 'action-http', 'label': 'Fetch data', 'reason': 'next step'}]
        client = self._client_returning(json.dumps(suggestions))

        with patch('services.llm.get_client', return_value=client):
            result = get_node_suggestions(
                [{'id': '1', 'type': 'trigger-manual', 'data': {'label': 'Start'}}],
                [],
                last_node_type='trigger-manual',
            )

        assert result == suggestions
        client.chat.completions.create.assert_called_once()
        messages = client.chat.completions.create.call_args.kwargs['messages']
        assert messages[-1]['role'] == 'user'
        assert 'Start' in messages[-1]['content']  # graph summary made it into the prompt

    def test_surfaces_a_failing_completion(self):
        client = MagicMock()
        client.chat.completions.create.side_effect = RuntimeError('rate limited')
        with patch('services.llm.get_client', return_value=client):
            with pytest.raises(RuntimeError, match='rate limited'):
                get_node_suggestions([], [])


class TestRoutes:
    def test_health_returns_ok(self):
        from app import app
        client = app.test_client()
        res = client.get('/health')
        assert res.status_code == 200
        assert res.get_json() == {'status': 'ok'}

    def test_suggest_requires_nodes_and_edges(self):
        from app import app
        client = app.test_client()
        res = client.post('/suggest', json={})
        assert res.status_code == 400
        assert 'error' in res.get_json()
