"""Tests for the shared OpenAI access layer, with the OpenAI client mocked."""
import json
import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from services import llm


def fake_client(content='ok', usage=SimpleNamespace(prompt_tokens=11, completion_tokens=7)):
    """A stand-in for the OpenAI client whose completion returns `content`."""
    client = MagicMock()
    client.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))],
        usage=usage,
        model='gpt-4o-mini',
    )
    return client


class TestChat:
    def test_returns_trimmed_content(self):
        client = fake_client('  hello world  ')
        with patch('services.llm.get_client', return_value=client):
            assert llm.chat('say hi') == 'hello world'

    def test_includes_system_message_when_provided(self):
        client = fake_client()
        with patch('services.llm.get_client', return_value=client):
            llm.chat('the prompt', system='be terse')
        messages = client.chat.completions.create.call_args.kwargs['messages']
        assert messages[0] == {'role': 'system', 'content': 'be terse'}
        assert messages[-1] == {'role': 'user', 'content': 'the prompt'}

    def test_omits_system_message_by_default(self):
        client = fake_client()
        with patch('services.llm.get_client', return_value=client):
            llm.chat('prompt only')
        messages = client.chat.completions.create.call_args.kwargs['messages']
        assert len(messages) == 1
        assert messages[0]['role'] == 'user'

    def test_uses_model_from_env(self):
        client = fake_client()
        with patch('services.llm.get_client', return_value=client), \
                patch.dict(os.environ, {'OPENAI_MODEL': 'gpt-4o'}):
            llm.chat('hi')
        assert client.chat.completions.create.call_args.kwargs['model'] == 'gpt-4o'

    def test_defaults_model_when_env_unset(self):
        client = fake_client()
        with patch('services.llm.get_client', return_value=client), \
                patch.dict(os.environ, {}, clear=True):
            llm.chat('hi')
        assert client.chat.completions.create.call_args.kwargs['model'] == 'gpt-4o-mini'

    def test_propagates_client_errors(self):
        client = MagicMock()
        client.chat.completions.create.side_effect = RuntimeError('rate limited')
        with patch('services.llm.get_client', return_value=client):
            with pytest.raises(RuntimeError, match='rate limited'):
                llm.chat('hi')


class TestChatWithUsage:
    def test_returns_text_and_token_counts(self):
        client = fake_client('  hello  ')
        with patch('services.llm.get_client', return_value=client):
            text, usage = llm.chat_with_usage('say hi')
        assert text == 'hello'
        assert usage == {'model': 'gpt-4o-mini', 'promptTokens': 11, 'completionTokens': 7}

    def test_reports_the_model_the_provider_actually_used(self):
        # Providers alias model names (a request for 'gpt-4o-mini' can come back
        # as a dated snapshot). Pricing has to follow what was billed, not what
        # was asked for.
        client = fake_client()
        client.chat.completions.create.return_value.model = 'gpt-4o-mini-2024-07-18'
        with patch('services.llm.get_client', return_value=client):
            _text, usage = llm.chat_with_usage('hi')
        assert usage['model'] == 'gpt-4o-mini-2024-07-18'

    def test_degrades_to_zero_counts_when_usage_is_absent(self):
        # A proxy or a future API shape that omits usage must not fail the node.
        # An unpriced AI step is a reporting gap; a failed run is an outage.
        client = fake_client(usage=None)
        with patch('services.llm.get_client', return_value=client):
            _text, usage = llm.chat_with_usage('hi')
        assert usage['promptTokens'] == 0
        assert usage['completionTokens'] == 0

    def test_chat_still_returns_only_text(self):
        # The existing callers (and the whole suite above) must not have to care.
        client = fake_client('plain')
        with patch('services.llm.get_client', return_value=client):
            assert llm.chat('hi') == 'plain'


class TestParseJson:
    def test_parses_plain_json_object(self):
        assert llm.parse_json('{"a": 1}') == {'a': 1}

    def test_strips_json_code_fences(self):
        assert llm.parse_json('```json\n{"a": 1}\n```') == {'a': 1}

    def test_strips_bare_code_fences(self):
        assert llm.parse_json('```\n[1, 2, 3]\n```') == [1, 2, 3]

    def test_raises_on_invalid_json(self):
        with pytest.raises(json.JSONDecodeError):
            llm.parse_json('not json at all')
