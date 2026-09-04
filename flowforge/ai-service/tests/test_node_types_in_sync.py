"""The generator's node-type list, against the canvas that has to render it.

`generate.py` says a graph passing its validation is "guaranteed to render",
and that guarantee rests entirely on KNOWN_NODE_TYPES matching the client's
`nodeTypes` map. Nothing held it, and it had drifted: the canvas renders
twenty-four types and the generator knew fourteen, so no description mentioning
sign-off could ever produce an approval gate.

The check is deliberately in *this* package. The AI service is the one that
must not drift from the client — the canvas is free to grow, and what must not
happen is a type appearing there and quietly staying out of reach here.

It is also deliberately two-sided. A missing type is a capability nobody
notices is absent; an *extra* type is a generated graph the canvas cannot draw,
which is the failure the original comment was promising against. Requiring
every rendered type to be classified as either generated or explicitly not
means a new node type forces a decision rather than an omission.
"""
import re
from pathlib import Path

import pytest

from services.generate import KNOWN_NODE_TYPES, NOT_GENERATED

NODE_TYPES_JS = (
    Path(__file__).resolve().parents[2] / 'client' / 'src' / 'components' / 'canvas' / 'nodeTypes.js'
)


def canvas_node_types():
    """The keys of the client's `nodeTypes` map.

    Parsed rather than imported, because this is a Python package reading a
    JavaScript module — the same shape as the CLI's cross-package signing test,
    which duplicates a canonicalisation and pins it instead of sharing it.
    """
    source = NODE_TYPES_JS.read_text(encoding='utf-8')
    body = source.split('export const nodeTypes = {', 1)[1].split('}', 1)[0]
    return {m.group(1) for m in re.finditer(r"^\s*'([^']+)'\s*:", body, re.M)}


def test_the_canvas_map_is_readable():
    """A parse that silently matched nothing would make every check below vacuous."""
    assert NODE_TYPES_JS.exists(), f'{NODE_TYPES_JS} is missing'
    assert len(canvas_node_types()) > 15


def test_every_rendered_type_is_classified():
    """A new node type must be a decision, not an omission."""
    unclassified = canvas_node_types() - KNOWN_NODE_TYPES - NOT_GENERATED
    assert unclassified == set(), (
        f'{sorted(unclassified)} render on the canvas but are neither generated '
        'nor listed in NOT_GENERATED'
    )


def test_the_generator_emits_nothing_the_canvas_cannot_draw():
    """The half the original comment was promising, and nothing was checking."""
    assert KNOWN_NODE_TYPES - canvas_node_types() == set()


def test_the_two_lists_do_not_overlap():
    assert not KNOWN_NODE_TYPES & NOT_GENERATED


@pytest.mark.parametrize(
    'node_type',
    ['approval', 'switch', 'validate', 'filter', 'map', 'aggregate'],
)
def test_the_gates_and_list_nodes_are_generatable(node_type):
    """The six that were missing.

    `approval` is the one that mattered: a workflow description asking for
    sign-off before a payment is among the commonest things anybody wants, and
    the generator could not express it at all.
    """
    assert node_type in KNOWN_NODE_TYPES


@pytest.mark.parametrize('node_type', ['sub-workflow', 'for-each', 'wait-callback', 'note'])
def test_the_ones_it_will_not_guess_at(node_type):
    """Excluded for reasons rather than by oversight — see NOT_GENERATED."""
    assert node_type in NOT_GENERATED
    assert node_type not in KNOWN_NODE_TYPES


@pytest.mark.parametrize('node_type', sorted(KNOWN_NODE_TYPES))
def test_the_prompt_documents_every_type_it_may_emit(node_type):
    """A type the model is allowed to use and never told about is one it will
    only produce by accident, with config it invented."""
    from services.generate import _INSTRUCTIONS

    assert f'- {node_type} ' in _INSTRUCTIONS, f'{node_type} is generatable but undocumented'
