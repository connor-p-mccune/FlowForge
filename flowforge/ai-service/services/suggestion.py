from openai import OpenAI
import json

client = OpenAI()


def get_node_suggestions(nodes, edges, last_node_type=None):
    node_summary = build_node_summary(nodes, edges)

    prompt = f"""You are helping a user build a workflow automation.
Current workflow:
{node_summary}
Last added node type: {last_node_type or 'unknown'}

Suggest 1-3 logical next nodes to add. Return ONLY a JSON array with no explanation:
[
  {{"type": "action-http", "label": "Fetch user data", "reason": "Common after a webhook trigger"}},
  ...
]

Available node types: trigger-manual, trigger-webhook, action-http, action-delay,
action-email, action-slack, condition, loop, ai-prompt, ai-classify, ai-extract,
output-log, output-return
"""

    response = client.chat.completions.create(
        model='gpt-4o-mini',
        messages=[{'role': 'user', 'content': prompt}],
        temperature=0.3,
    )

    raw = response.choices[0].message.content.strip()
    if raw.startswith('```'):
        raw = '\n'.join(raw.split('\n')[1:-1])

    return json.loads(raw)


def build_node_summary(nodes, edges):
    if not nodes:
        return 'Empty workflow (no nodes yet)'
    lines = []
    for node in nodes:
        node_id = node.get('id')
        node_type = node.get('type')
        label = node.get('data', {}).get('label', node_type)
        targets = [e['target'] for e in edges if e['source'] == node_id]
        connection_str = f' → {targets}' if targets else ''
        lines.append(f'- {label} ({node_type}){connection_str}')
    return '\n'.join(lines)
