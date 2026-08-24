// Can a callback wait ever be satisfied?
//
// Every failure here looks identical at run time — the run parks for the full
// timeout and then takes the timed-out branch — and identical to a partner
// system that simply never replied. That is what makes it worth finding
// statically: the investigation otherwise starts at the partner, and the answer
// was on the canvas.

const { callbackIssues } = require('../services/callbackLiveness')

const node = (id, type, config = {}, label = id) => ({
  id, type, position: { x: 0, y: 0 }, data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`, source, target, sourceHandle,
})

const codes = (graph) => callbackIssues(graph).map((i) => i.code)
const find = (graph, code) => callbackIssues(graph).find((i) => i.code === code)

// trigger → send → wait: the shape that works.
const LIVE = {
  nodes: [
    node('t1', 'trigger-manual'),
    node('send', 'action-http', { url: 'https://partner.example.com/jobs', body: '{"reply": "{{callbacks.wait}}"}' }, 'Ask partner'),
    node('wait', 'wait-callback', { timeoutMinutes: 30 }, 'Wait for partner'),
    node('done', 'output-log', { message: 'ok' }, 'Log'),
  ],
  edges: [edge('t1', 'send'), edge('send', 'wait'), edge('wait', 'done', 'received')],
}

describe('callbackIssues', () => {
  it('says nothing about a wait whose URL an upstream node sends', () => {
    expect(callbackIssues(LIVE)).toEqual([])
  })

  it('says nothing at all about a workflow with no callback node', () => {
    const graph = {
      nodes: [node('t1', 'trigger-manual'), node('a', 'action-http', { url: 'https://x.dev' })],
      edges: [edge('t1', 'a')],
    }
    expect(callbackIssues(graph)).toEqual([])
  })

  // — nothing sends it ————————————————————————————————————————————————

  it('reports a wait no node mentions at all', () => {
    const graph = {
      ...LIVE,
      nodes: LIVE.nodes.map((n) =>
        n.id === 'send' ? node('send', 'action-http', { url: 'https://partner.example.com' }, 'Ask partner') : n
      ),
    }
    const found = find(graph, 'callback-never-sent')
    expect(found.severity).toBe('error')
    expect(found.nodeId).toBe('wait')
    expect(found.message).toMatch(/never leaves FlowForge/)
  })

  it('reports a callback URL that is only logged', () => {
    // stdout is not a delivery mechanism, and this is the version somebody
    // writes while debugging and then forgets to finish.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('log', 'output-log', { message: 'callback: {{callbacks.wait}}' }, 'Log the URL'),
        node('wait', 'wait-callback', {}, 'Wait for partner'),
      ],
      edges: [edge('t1', 'log'), edge('log', 'wait')],
    }
    const found = find(graph, 'callback-never-sent')
    expect(found.severity).toBe('error')
    expect(found.message).toMatch(/a logged callback URL is not a delivered one/)
    expect(found.message).toMatch(/Log the URL/)
  })

  // — the dataflow case, which a string search gets wrong ————————————

  it('follows the URL through a node that repackages it', () => {
    // A transform builds the body and the HTTP node references it. The URL is
    // sent, and no HTTP node mentions `callbacks` anywhere.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('build', 'transform', { template: '{"replyTo": "{{callbacks.wait}}"}' }, 'Build body'),
        node('send', 'action-http', { url: 'https://partner.dev', body: '{{build}}' }, 'Ask partner'),
        node('wait', 'wait-callback', {}, 'Wait for partner'),
      ],
      edges: [edge('t1', 'build'), edge('build', 'send'), edge('send', 'wait')],
    }
    expect(callbackIssues(graph)).toEqual([])
  })

  it('treats a sub-workflow that receives the URL as able to send it', () => {
    // The URL leaves this graph, and what the callee does with it is that
    // graph's business. Claiming it is never sent would be a guess.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('call', 'sub-workflow', { workflowId: 'other', input: '{{callbacks.wait}}' }, 'Delegate'),
        node('wait', 'wait-callback', {}, 'Wait'),
      ],
      edges: [edge('t1', 'call'), edge('call', 'wait')],
    }
    expect(callbackIssues(graph)).toEqual([])
  })

  // — the deadlock ————————————————————————————————————————————————————

  it('reports a sender that cannot run until the wait finishes', () => {
    // A wait-for cycle inside a graph that has no cycles: the wait blocks on
    // the send, the send blocks on the wait.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('wait', 'wait-callback', {}, 'Wait for partner'),
        node('send', 'action-http', { url: 'https://partner.dev', body: '{{callbacks.wait}}' }, 'Ask partner'),
      ],
      edges: [edge('t1', 'wait'), edge('wait', 'send', 'received')],
    }
    const found = find(graph, 'callback-deadlock')
    expect(found.severity).toBe('error')
    expect(found.message).toMatch(/Ask partner, which runs after this wait/)
    expect(found.message).toMatch(/Move it upstream/)
  })

  it('accepts a sender on a parallel branch, which is not downstream', () => {
    // `t1 → send` and `t1 → wait`: the two race, and the callback row is armed
    // at run start, so an early reply is adopted rather than lost.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('send', 'action-http', { url: 'https://partner.dev', body: '{{callbacks.wait}}' }, 'Ask partner'),
        node('wait', 'wait-callback', {}, 'Wait'),
      ],
      edges: [edge('t1', 'send'), edge('t1', 'wait')],
    }
    expect(callbackIssues(graph)).toEqual([])
  })

  it('prefers the usable sender when one is upstream and one is downstream', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('send', 'action-http', { url: 'https://p.dev', body: '{{callbacks.wait}}' }, 'Ask'),
        node('wait', 'wait-callback', {}, 'Wait'),
        node('retry', 'action-http', { url: 'https://p.dev', body: '{{callbacks.wait}}' }, 'Ask again'),
      ],
      edges: [edge('t1', 'send'), edge('send', 'wait'), edge('wait', 'retry', 'timed-out')],
    }
    expect(callbackIssues(graph)).toEqual([])
  })

  // — the path-dependent case ————————————————————————————————————————

  it('warns when the sender does not run on every path to the wait', () => {
    // The condition's false branch reaches the wait without the URL ever going
    // out — live on one path, dead on the other, and impossible to tell apart
    // from a flaky partner.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('check', 'condition', { expression: 'urgent' }, 'Urgent?'),
        node('send', 'action-http', { url: 'https://p.dev', body: '{{callbacks.wait}}' }, 'Ask partner'),
        node('wait', 'wait-callback', {}, 'Wait for partner'),
      ],
      edges: [
        edge('t1', 'check'),
        edge('check', 'send', 'true'),
        edge('send', 'wait'),
        edge('check', 'wait', 'false'),
      ],
    }
    const found = find(graph, 'callback-may-not-be-sent')
    expect(found.severity).toBe('warning')
    expect(found.message).toMatch(/does not run on every path/)
  })

  it('does not warn when the sender dominates the wait', () => {
    // Every path to the wait goes through the send, so the URL always went out.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('send', 'action-http', { url: 'https://p.dev', body: '{{callbacks.wait}}' }, 'Ask'),
        node('check', 'condition', { expression: 'urgent' }, 'Urgent?'),
        node('wait', 'wait-callback', {}, 'Wait'),
      ],
      edges: [
        edge('t1', 'send'),
        edge('send', 'check'),
        edge('check', 'wait', 'true'),
        edge('check', 'wait', 'false'),
      ],
    }
    expect(callbackIssues(graph)).toEqual([])
  })

  // — several waits, and the graphs that break naive versions ————————

  it('judges each wait separately', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('send', 'action-http', { url: 'https://p.dev', body: '{{callbacks.first}}' }, 'Ask once'),
        node('first', 'wait-callback', {}, 'First wait'),
        node('second', 'wait-callback', {}, 'Second wait'),
      ],
      edges: [edge('t1', 'send'), edge('send', 'first'), edge('first', 'second', 'received')],
    }
    const issues = callbackIssues(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].nodeId).toBe('second')
  })

  it('does not credit a wait for holding its own URL', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('wait', 'wait-callback', { note: '{{callbacks.wait}}' }, 'Wait'),
      ],
      edges: [edge('t1', 'wait')],
    }
    expect(codes(graph)).toEqual(['callback-never-sent'])
  })

  it('finds the reference however deep in the config it is', () => {
    const graph = {
      ...LIVE,
      nodes: LIVE.nodes.map((n) =>
        n.id === 'send'
          ? node('send', 'action-http', { url: 'https://p.dev', headers: { 'X-Reply': '{{callbacks.wait}}' } }, 'Ask')
          : n
      ),
    }
    expect(callbackIssues(graph)).toEqual([])
  })

  it('says nothing about a cyclic graph, which never runs at all', () => {
    const graph = {
      nodes: [node('a', 'wait-callback'), node('b', 'transform')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    expect(callbackIssues(graph)).toEqual([])
  })

  it('ignores sticky notes, like every analysis over the execution graph', () => {
    const graph = {
      ...LIVE,
      nodes: [...LIVE.nodes, node('n1', 'note', { text: '{{callbacks.wait}}' }, 'A note')],
    }
    expect(callbackIssues(graph)).toEqual([])
  })
})
