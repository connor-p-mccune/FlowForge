"""Next-step node suggestions for the workflow builder.

The types this may suggest are the types `generate.py` may emit, and it reads
them from there rather than keeping its own list. It had one, and it was a
different — shorter — list: no schedule trigger, no return node, and none of the
branching nodes, so the builder could never suggest putting an approval in front
of the payment it had just helped somebody add.

Two lists of the same thing is one list and one stale copy. Which one is stale
is decided by whichever was edited last, and nobody edits the one they are not
looking at.
"""
from services import llm
from services.generate import KNOWN_NODE_TYPES

# Sorted so the prompt is stable across runs: an unordered set would reshuffle
# the sentence on every call, and a cached completion would be a coin toss.
AVAILABLE_NODE_TYPES = ', '.join(sorted(KNOWN_NODE_TYPES))


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
