"""LLM-backed work for individual workflow nodes: free-form prompts,
classification, and structured field extraction. Each function returns a plain
dict that becomes the node's output in the execution engine.
"""
from services import llm


def _as_list(value):
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [part.strip() for part in str(value or '').split(',') if part.strip()]


def run_llm_prompt(prompt, system=None):
    if not prompt:
        raise ValueError('prompt is required')
    text = llm.chat(prompt, system=system, temperature=0.4)
    return {'text': text}


def classify_text(text, labels):
    if not text:
        raise ValueError('text is required')
    label_list = _as_list(labels)
    if not label_list:
        raise ValueError('labels are required')

    prompt = f"""Classify the text below into exactly one of these categories:
{', '.join(label_list)}

Text:
\"\"\"
{text}
\"\"\"

Respond with ONLY the category name, exactly as written above."""

    raw = llm.chat(prompt, temperature=0).strip()
    # Normalise the model's answer back to one of the provided labels.
    match = next((l for l in label_list if l.lower() == raw.lower()), None)
    if match is None:
        match = next((l for l in label_list if l.lower() in raw.lower()), raw)
    return {'label': match}


def extract_fields(text, fields):
    if not text:
        raise ValueError('text is required')
    field_list = _as_list(fields)
    if not field_list:
        raise ValueError('fields are required')

    prompt = f"""Extract the following fields from the text as a JSON object:
{', '.join(field_list)}

Use null for any field that is not present. Return ONLY the JSON object.

Text:
\"\"\"
{text}
\"\"\""""

    raw = llm.chat(prompt, temperature=0)
    data = llm.parse_json(raw)
    return {'data': data}
