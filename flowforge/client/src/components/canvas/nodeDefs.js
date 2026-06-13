// Default data for each node type — used by the toolbar when creating nodes
// and by the config panel to know which fields a type supports.
export const NODE_DEFS = {
  'trigger-manual': {
    label: 'Manual Trigger',
    subtype: 'manual',
    config: {},
  },
  'trigger-webhook': {
    label: 'Webhook Trigger',
    subtype: 'webhook',
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
  'action-email': {
    label: 'Send Email',
    subtype: 'email',
    config: { to: '', subject: '', body: '' },
  },
  'action-slack': {
    label: 'Send Slack',
    subtype: 'slack',
    config: { webhookUrl: '', text: '' },
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
    config: { prompt: '', system: '' },
  },
  'ai-classify': {
    label: 'Classify',
    subtype: 'classify',
    config: { text: '', labels: '' },
  },
  'ai-extract': {
    label: 'Extract',
    subtype: 'extract',
    config: { text: '', fields: '' },
  },
  'output-log': {
    label: 'Log Output',
    subtype: 'log',
    config: { message: '' },
  },
}

export const TOOLBAR_BUTTONS = [
  { type: 'trigger-manual', label: 'Trigger', className: 'toolbar-btn--trigger' },
  { type: 'trigger-webhook', label: 'Webhook', className: 'toolbar-btn--trigger' },
  { type: 'action-http', label: 'HTTP', className: 'toolbar-btn--action' },
  { type: 'action-delay', label: 'Delay', className: 'toolbar-btn--action' },
  { type: 'action-email', label: 'Email', className: 'toolbar-btn--action' },
  { type: 'action-slack', label: 'Slack', className: 'toolbar-btn--action' },
  { type: 'transform', label: 'Transform', className: 'toolbar-btn--action' },
  { type: 'condition', label: 'Condition', className: 'toolbar-btn--condition' },
  { type: 'ai-prompt', label: 'AI', className: 'toolbar-btn--ai' },
  { type: 'ai-classify', label: 'Classify', className: 'toolbar-btn--ai' },
  { type: 'ai-extract', label: 'Extract', className: 'toolbar-btn--ai' },
  { type: 'output-log', label: 'Output', className: 'toolbar-btn--output' },
]
