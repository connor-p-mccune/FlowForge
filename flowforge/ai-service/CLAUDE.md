# ai-service/

Python Flask microservice on port 5000. Handles LLM-powered node suggestions. Called exclusively by the Node.js backend — never directly by the frontend.

---

## Commands

```bash
# Install deps
pip install -r requirements.txt

# Run dev server
python app.py

# Run tests
python -m pytest tests/
```

---

## Folder structure

```
ai-service/
├── app.py                    # Flask app, registers routes
├── requirements.txt
├── Dockerfile
├── services/
│   └── suggestion.py         # Prompt construction + OpenAI call + response parsing
└── tests/
    └── test_suggestion.py
```

---

## requirements.txt

```
flask==3.0.0
openai==1.12.0
python-dotenv==1.0.0
pytest==8.0.0
```

---

## app.py skeleton

```python
from flask import Flask, request, jsonify
from services.suggestion import get_node_suggestions
import os
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

@app.route('/suggest', methods=['POST'])
def suggest():
    data = request.get_json()
    if not data or 'nodes' not in data or 'edges' not in data:
        return jsonify({'error': 'nodes and edges are required'}), 400
    try:
        suggestions = get_node_suggestions(
            nodes=data['nodes'],
            edges=data['edges'],
            last_node_type=data.get('lastNodeType')
        )
        return jsonify({'suggestions': suggestions})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
```

---

## services/suggestion.py pattern

Build a prompt that describes the current graph and asks for next-step suggestions. Parse the response as JSON.

```python
from openai import OpenAI
import json

client = OpenAI()  # reads OPENAI_API_KEY from environment automatically

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
    # Strip markdown code fences if present
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
```

---

## Adding a new AI capability

1. Add a new route in `app.py` (e.g., `POST /extract-schema`)
2. Add the corresponding function in `services/suggestion.py` or a new service file
3. Add a proxy route on the Node.js backend in `server/src/services/aiProxy.js`
4. Expose it through the Express API at `/api/ai/your-endpoint`
5. Never expose the Python service port publicly in production — it only talks to the Node backend

---

## Dockerfile

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "app.py"]
```

---

## Error handling

Always return `{ error: string }` with an appropriate status code on failure. Never let an unhandled exception return a 500 with a Python traceback — the backend uses the response body to surface errors to the frontend.
