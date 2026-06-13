import json
from unittest.mock import patch

import pytest

from services.nodes import run_llm_prompt, classify_text, extract_fields


class TestRunLlmPrompt:
    @patch('services.llm.chat')
    def test_returns_text(self, mock_chat):
        mock_chat.return_value = 'A short summary.'
        result = run_llm_prompt('Summarize this', system='Be terse')
        assert result == {'text': 'A short summary.'}

    def test_requires_prompt(self):
        with pytest.raises(ValueError):
            run_llm_prompt('')


class TestClassifyText:
    @patch('services.llm.chat')
    def test_normalises_to_a_provided_label(self, mock_chat):
        mock_chat.return_value = 'Positive'
        result = classify_text('I love it', ['positive', 'negative'])
        assert result == {'label': 'positive'}

    @patch('services.llm.chat')
    def test_accepts_comma_separated_labels(self, mock_chat):
        mock_chat.return_value = 'The answer is billing.'
        result = classify_text('Why was I charged twice?', 'billing, support, sales')
        assert result == {'label': 'billing'}

    def test_requires_text_and_labels(self):
        with pytest.raises(ValueError):
            classify_text('', ['a', 'b'])
        with pytest.raises(ValueError):
            classify_text('hello', [])


class TestExtractFields:
    @patch('services.llm.chat')
    def test_parses_json_object(self, mock_chat):
        mock_chat.return_value = json.dumps({'name': 'Ada', 'email': 'ada@example.com'})
        result = extract_fields('Ada <ada@example.com>', ['name', 'email'])
        assert result == {'data': {'name': 'Ada', 'email': 'ada@example.com'}}

    @patch('services.llm.chat')
    def test_strips_code_fences(self, mock_chat):
        mock_chat.return_value = '```json\n{"city": "Paris"}\n```'
        result = extract_fields('I live in Paris', 'city')
        assert result == {'data': {'city': 'Paris'}}

    def test_requires_text_and_fields(self):
        with pytest.raises(ValueError):
            extract_fields('', ['a'])
        with pytest.raises(ValueError):
            extract_fields('hello', '')


class TestNodeRoutes:
    def _client(self):
        from app import app
        return app.test_client()

    def test_llm_requires_prompt(self):
        res = self._client().post('/llm', json={})
        assert res.status_code == 400

    def test_classify_requires_fields(self):
        res = self._client().post('/classify', json={'text': 'hi'})
        assert res.status_code == 400

    def test_extract_requires_fields(self):
        res = self._client().post('/extract', json={'text': 'hi'})
        assert res.status_code == 400

    @patch('services.llm.chat')
    def test_llm_route_returns_text(self, mock_chat):
        mock_chat.return_value = 'hello world'
        res = self._client().post('/llm', json={'prompt': 'say hi'})
        assert res.status_code == 200
        assert res.get_json() == {'text': 'hello world'}
