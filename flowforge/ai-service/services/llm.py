"""Shared OpenAI access for every AI capability in this service.

The client is created lazily so importing this module (and therefore the Flask
app and the test suite) never requires an API key — only an actual LLM call does.
"""
import json
import os

from openai import OpenAI

_client = None


def get_client():
    """Return a process-wide OpenAI client, creating it on first use."""
    global _client
    if _client is None:
        _client = OpenAI()
    return _client


def chat(prompt, system=None, temperature=0.3, model=None):
    """Run a single-turn chat completion and return the trimmed text.

    `model` lets a caller request a more capable model than the default
    (e.g. workflow generation needs gpt-4o). When omitted it falls back to the
    OPENAI_MODEL env var, then gpt-4o-mini.
    """
    messages = []
    if system:
        messages.append({'role': 'system', 'content': system})
    messages.append({'role': 'user', 'content': prompt})

    response = get_client().chat.completions.create(
        model=model or os.environ.get('OPENAI_MODEL', 'gpt-4o-mini'),
        messages=messages,
        temperature=temperature,
    )
    return response.choices[0].message.content.strip()


def parse_json(raw):
    """Parse model output as JSON, tolerating ```json code fences."""
    raw = raw.strip()
    if raw.startswith('```'):
        raw = '\n'.join(raw.split('\n')[1:-1]).strip()
    return json.loads(raw)
