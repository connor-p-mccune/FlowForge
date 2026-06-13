"""Next-step node suggestions for the workflow builder."""
from services import llm

AVAILABLE_NODE_TYPES = (
    'trigger-manual, trigger-webhook, action-http, action-delay, '
    'action-email, action-slack, condition, transform, ai-prompt, '
    'ai-classify, ai-extract, output-log'
)


def get_node_suggestions(nodes, edges, last_node_type=None):
    node_summary = build_node_summary(nodes, edges)

    prompt = f"""You are helping a user build a workflow automation.
Current workflow:
{node_summary}
Last added node type: {last_node_type or 'unknown'}

Suggest 1-3 logical next nodes to add. Return ONLY a JSON array with no explanation:
[
  {{"type": "action-http", "label": "Fetch user data", "reason": "Common after a webhook trigger"}}
]

Available node types: {AVAILABLE_NODE_TYPES}
"""

    raw = llm.chat(prompt, temperature=0.3)
    suggestions = llm.parse_json(raw)
    # Defend against the model returning a single object instead of an array
    if isinstance(suggestions, dict):
        suggestions = [suggestions]
    return suggestions


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
