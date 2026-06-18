"""Generate a full workflow graph from a plain-English description.

The model is asked to emit the same { nodes, edges } "graph_data" shape the canvas
saves (see client hooks/useWorkflow serializeGraph), so a generated graph loads
straight onto the canvas. KNOWN_NODE_TYPES mirrors the client's nodeTypes map
(client/src/components/canvas/nodeTypes.js): every type listed there has a React
component, so a graph that passes validation here is guaranteed to render.
"""
import json
import os

from services import llm

# Keep in sync with the client's nodeTypes map. Membership here is what makes a
# generated graph "loadable": each type renders on the canvas.
KNOWN_NODE_TYPES = {
    'trigger-manual', 'trigger-webhook', 'trigger-schedule',
    'action-http', 'action-email', 'action-slack', 'action-delay',
    'transform', 'condition',
    'ai-prompt', 'ai-classify', 'ai-extract',
    'output-log', 'output-return',
}

# gpt-4o (not -mini): turning a vague sentence into a correct, connected graph
# needs real reasoning. Overridable, but defaults to the stronger model.
GENERATE_MODEL = os.environ.get('OPENAI_GENERATE_MODEL', 'gpt-4o')

_INSTRUCTIONS = """You are the workflow builder for FlowForge, a visual automation \
tool. Turn the user's plain-English description into a workflow graph.

A workflow is a directed graph of nodes joined by edges. Describe it as a JSON \
object with this exact shape:
{
  "nodes": [
    {
      "id": "<short unique id>",
      "type": "<node type>",
      "position": { "x": <number>, "y": <number> },
      "data": { "label": "<short human label>", "config": { ...type-specific... } }
    }
  ],
  "edges": [
    { "id": "<unique id>", "source": "<node id>", "target": "<node id>", "sourceHandle": null }
  ]
}

Rules:
- Start every workflow with exactly one trigger node (trigger-webhook, \
trigger-manual, or trigger-schedule).
- Connect the nodes in execution order with edges (source -> target).
- Lay nodes out top-to-bottom: give each next node a larger y (start near \
{x:250,y:60} and add ~140 to y per step). For the two branches of a condition, \
offset their x (e.g. one near x:120 and one near x:380).
- Pass data between nodes with {{source-node-id.field}} placeholders inside config \
values. A webhook trigger exposes its posted JSON body, so a payment amount is \
{{trigger.amount}} when the trigger's id is "trigger".
- Give nodes short, meaningful ids (e.g. "trigger", "classify", "slack").

Node types and their config fields:
- trigger-webhook  config: {}                          Starts on an external POST; body available as {{id.field}}.
- trigger-manual   config: {}                          Starts when the user clicks Run.
- trigger-schedule config: {"cron":"0 9 * * 1"}        Runs on a cron schedule.
- action-http      config: {"method":"GET","url":"https://...","headers":"{}","body":""}  headers is a JSON string; returns {status, body}.
- action-email     config: {"to":"","subject":"","body":""}
- action-slack     config: {"webhookUrl":"https://hooks.slack.com/...","text":""}
- action-delay     config: {"durationMs":1000}
- transform        config: {"template":"{\\"field\\":\\"{{id.value}}\\"}"}   JSON template; resolves placeholders into a new object.
- condition        config: {"left":"{{id.field}}","operator":"equals","right":"value"}  operator is one of equals, not_equals, contains, greater_than, less_than. A condition has TWO outgoing edges: one with "sourceHandle":"true" and one with "sourceHandle":"false".
- ai-prompt        config: {"prompt":"...","system":""}  Returns {text}; use {{id.text}} downstream.
- ai-classify      config: {"text":"{{id.field}}","labels":"urgent, normal, spam"}  Returns {label}; use {{id.label}}.
- ai-extract       config: {"text":"{{id.field}}","fields":"name, email, amount"}  Returns {data:{...}}; use {{id.data.name}}.
- output-log       config: {"message":"{{id.field}}"}   Records a message to the run log.
- output-return    config: {}                           Returns the workflow's final result.

Respond with ONLY the JSON object. No markdown, no code fences, no explanation."""

# Few-shot anchors, built as data so they are always valid JSON: a simple 2-node
# flow, a branching flow with a condition, and a 4-node flow mixing AI + actions.
_EXAMPLES = [
    (
        'Post to Slack whenever a webhook receives an order',
        {
            'nodes': [
                {
                    'id': 'trigger',
                    'type': 'trigger-webhook',
                    'position': {'x': 250, 'y': 60},
                    'data': {'label': 'Order Webhook', 'config': {}},
                },
                {
                    'id': 'slack',
                    'type': 'action-slack',
                    'position': {'x': 250, 'y': 200},
                    'data': {
                        'label': 'Notify Slack',
                        'config': {
                            'webhookUrl': 'https://hooks.slack.com/services/T000/B000/XXXX',
                            'text': 'New order received: {{trigger.orderId}}',
                        },
                    },
                },
            ],
            'edges': [
                {'id': 'e1', 'source': 'trigger', 'target': 'slack', 'sourceHandle': None},
            ],
        },
    ),
    (
        "When a webhook gets a payment, alert Slack if it's over $100, otherwise log it",
        {
            'nodes': [
                {
                    'id': 'trigger',
                    'type': 'trigger-webhook',
                    'position': {'x': 250, 'y': 60},
                    'data': {'label': 'Payment Webhook', 'config': {}},
                },
                {
                    'id': 'check',
                    'type': 'condition',
                    'position': {'x': 250, 'y': 200},
                    'data': {
                        'label': 'Over $100?',
                        'config': {
                            'left': '{{trigger.amount}}',
                            'operator': 'greater_than',
                            'right': '100',
                        },
                    },
                },
                {
                    'id': 'slack',
                    'type': 'action-slack',
                    'position': {'x': 120, 'y': 340},
                    'data': {
                        'label': 'Alert Slack',
                        'config': {
                            'webhookUrl': 'https://hooks.slack.com/services/T000/B000/XXXX',
                            'text': 'Large payment received: ${{trigger.amount}}',
                        },
                    },
                },
                {
                    'id': 'log',
                    'type': 'output-log',
                    'position': {'x': 380, 'y': 340},
                    'data': {
                        'label': 'Log Payment',
                        'config': {'message': 'Payment of ${{trigger.amount}} received'},
                    },
                },
            ],
            'edges': [
                {'id': 'e1', 'source': 'trigger', 'target': 'check', 'sourceHandle': None},
                {'id': 'e2', 'source': 'check', 'target': 'slack', 'sourceHandle': 'true'},
                {'id': 'e3', 'source': 'check', 'target': 'log', 'sourceHandle': 'false'},
            ],
        },
    ),
    (
        'Every Monday morning fetch our sales report and email me a summary',
        {
            'nodes': [
                {
                    'id': 'trigger',
                    'type': 'trigger-schedule',
                    'position': {'x': 250, 'y': 60},
                    'data': {'label': 'Every Monday 9am', 'config': {'cron': '0 9 * * 1'}},
                },
                {
                    'id': 'fetch',
                    'type': 'action-http',
                    'position': {'x': 250, 'y': 200},
                    'data': {
                        'label': 'Fetch Sales',
                        'config': {
                            'method': 'GET',
                            'url': 'https://api.example.com/sales/weekly',
                            'headers': '{}',
                            'body': '',
                        },
                    },
                },
                {
                    'id': 'summary',
                    'type': 'ai-prompt',
                    'position': {'x': 250, 'y': 340},
                    'data': {
                        'label': 'Summarize Sales',
                        'config': {
                            'prompt': 'Summarize this weekly sales data in 3 bullet points: {{fetch.body}}',
                            'system': 'You are a concise business analyst.',
                        },
                    },
                },
                {
                    'id': 'email',
                    'type': 'action-email',
                    'position': {'x': 250, 'y': 480},
                    'data': {
                        'label': 'Email Summary',
                        'config': {
                            'to': 'me@example.com',
                            'subject': 'Weekly Sales Summary',
                            'body': '{{summary.text}}',
                        },
                    },
                },
            ],
            'edges': [
                {'id': 'e1', 'source': 'trigger', 'target': 'fetch', 'sourceHandle': None},
                {'id': 'e2', 'source': 'fetch', 'target': 'summary', 'sourceHandle': None},
                {'id': 'e3', 'source': 'summary', 'target': 'email', 'sourceHandle': None},
            ],
        },
    ),
]


def _format_examples():
    blocks = []
    for i, (desc, graph) in enumerate(_EXAMPLES, 1):
        blocks.append(f'Example {i} — "{desc}":\n{json.dumps(graph)}')
    return '\n\n'.join(blocks)


SYSTEM_PROMPT = _INSTRUCTIONS + '\n\nHere are three examples.\n\n' + _format_examples()


def generate_workflow(prompt):
    """Build a workflow graph from a natural-language prompt.

    Returns the validated graph_data dict ({nodes, edges}). Raises ValueError if
    the prompt is blank or the model's response isn't a usable graph.
    """
    if not prompt or not str(prompt).strip():
        raise ValueError('prompt is required')

    raw = llm.chat(prompt, system=SYSTEM_PROMPT, temperature=0.2, model=GENERATE_MODEL)

    try:
        graph = llm.parse_json(raw)
    except (json.JSONDecodeError, ValueError):
        raise ValueError('The model did not return valid JSON') from None

    _validate_graph(graph)
    return graph


def _validate_graph(graph):
    """Raise ValueError unless `graph` is a structurally valid, loadable graph:
    a {nodes, edges} object whose nodes have known types and whose edges connect
    existing nodes.
    """
    if not isinstance(graph, dict):
        raise ValueError('Generated workflow must be a JSON object')

    nodes = graph.get('nodes')
    edges = graph.get('edges')
    if not isinstance(nodes, list):
        raise ValueError('Generated workflow is missing a nodes array')
    if not isinstance(edges, list):
        raise ValueError('Generated workflow is missing an edges array')
    if not nodes:
        raise ValueError('Generated workflow has no nodes')

    ids = set()
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError('Each node must be an object')
        node_id = node.get('id')
        if not node_id or not isinstance(node_id, str):
            raise ValueError('Each node needs a string id')
        if node_id in ids:
            raise ValueError(f'Duplicate node id: {node_id}')
        ids.add(node_id)
        if node.get('type') not in KNOWN_NODE_TYPES:
            raise ValueError(f'Unknown node type: {node.get("type")}')

    for edge in edges:
        if not isinstance(edge, dict):
            raise ValueError('Each edge must be an object')
        if edge.get('source') not in ids or edge.get('target') not in ids:
            raise ValueError('Each edge must connect two existing nodes')
