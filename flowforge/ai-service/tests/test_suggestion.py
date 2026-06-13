import json
from unittest.mock import patch

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
