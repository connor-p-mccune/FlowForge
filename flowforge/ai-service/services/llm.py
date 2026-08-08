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
    text, _usage = chat_with_usage(
        prompt, system=system, temperature=temperature, model=model
    )
    return text


def chat_with_usage(prompt, system=None, temperature=0.3, model=None):
    """Like `chat`, but also returns the call's token usage.

    Returns `(text, usage)` where usage is
    `{'model': ..., 'promptTokens': int, 'completionTokens': int}`.

    This exists because the server prices AI steps: tokens are the only part of
    a workflow run that costs real, attributable money, and the only place that
    number is knowable is here, at the call. Deriving it later from the text
    would be a guess.

    Usage is best-effort by design. A provider response missing the `usage`
    block — a proxy, a mock, a future API shape — yields zero counts rather
    than an exception: failing an AI node because its *invoice line* couldn't be
    computed would be exactly the wrong trade.
    """
    messages = []
    if system:
        messages.append({'role': 'system', 'content': system})
    messages.append({'role': 'user', 'content': prompt})

    resolved_model = model or os.environ.get('OPENAI_MODEL', 'gpt-4o-mini')
    response = get_client().chat.completions.create(
        model=resolved_model,
        messages=messages,
        temperature=temperature,
    )
    return response.choices[0].message.content.strip(), _usage_of(response, resolved_model)


def _usage_of(response, model):
    """Token counts from a completion response, tolerating their absence."""
    usage = getattr(response, 'usage', None)
    return {
        'model': getattr(response, 'model', None) or model,
        'promptTokens': int(getattr(usage, 'prompt_tokens', 0) or 0),
        'completionTokens': int(getattr(usage, 'completion_tokens', 0) or 0),
    }


def parse_json(raw):
    """Parse model output as JSON, tolerating ```json code fences."""
    raw = raw.strip()
    if raw.startswith('```'):
        raw = '\n'.join(raw.split('\n')[1:-1]).strip()
    return json.loads(raw)
