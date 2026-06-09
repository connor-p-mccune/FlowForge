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
            last_node_type=data.get('lastNodeType'),
        )
        return jsonify({'suggestions': suggestions})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
