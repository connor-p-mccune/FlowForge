// Default data for each node type — used by the toolbar when creating nodes
// and by the config panel to know which fields a type supports.
export const NODE_DEFS = {
  'trigger-manual': {
    label: 'Manual Trigger',
    subtype: 'manual',
    config: {},
  },
  'action-http': {
    label: 'HTTP Request',
    subtype: 'http',
    config: { method: 'GET', url: '', headers: '{}', body: '' },
  },
  'action-delay': {
    label: 'Delay',
    subtype: 'delay',
    config: { durationMs: 1000 },
  },
  'transform': {
    label: 'Transform',
    subtype: 'transform',
    config: { template: '{\n  "value": "{{node-id.field}}"\n}' },
  },
  'condition': {
    label: 'Condition',
    subtype: 'condition',
    config: { left: '', operator: 'equals', right: '' },
  },
  'ai-prompt': {
    label: 'AI Prompt',
    subtype: 'prompt',
    config: { prompt: '' },
  },
  'output-log': {
    label: 'Log Output',
    subtype: 'log',
    config: { message: '' },
  },
}

export const TOOLBAR_BUTTONS = [
  { type: 'trigger-manual', label: 'Trigger', className: 'toolbar-btn--trigger' },
  { type: 'action-http', label: 'HTTP', className: 'toolbar-btn--action' },
  { type: 'action-delay', label: 'Delay', className: 'toolbar-btn--action' },
  { type: 'transform', label: 'Transform', className: 'toolbar-btn--action' },
  { type: 'condition', label: 'Condition', className: 'toolbar-btn--condition' },
  { type: 'ai-prompt', label: 'AI', className: 'toolbar-btn--ai' },
  { type: 'output-log', label: 'Output', className: 'toolbar-btn--output' },
]
