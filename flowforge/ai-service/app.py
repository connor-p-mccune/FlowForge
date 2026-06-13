from flask import Flask, request, jsonify
from services.suggestion import get_node_suggestions
from services.nodes import run_llm_prompt, classify_text, extract_fields
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
            last_node_type=data.get('lastNodeType'),
        )
        return jsonify({'suggestions': suggestions})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/llm', methods=['POST'])
def llm_prompt():
    data = request.get_json() or {}
    if not data.get('prompt'):
        return jsonify({'error': 'prompt is required'}), 400
    try:
        return jsonify(run_llm_prompt(data['prompt'], system=data.get('system')))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/classify', methods=['POST'])
def classify():
    data = request.get_json() or {}
    if not data.get('text') or not data.get('labels'):
        return jsonify({'error': 'text and labels are required'}), 400
    try:
        return jsonify(classify_text(data['text'], data['labels']))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/extract', methods=['POST'])
def extract():
    data = request.get_json() or {}
    if not data.get('text') or not data.get('fields'):
        return jsonify({'error': 'text and fields are required'}), 400
    try:
        return jsonify(extract_fields(data['text'], data['fields']))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
