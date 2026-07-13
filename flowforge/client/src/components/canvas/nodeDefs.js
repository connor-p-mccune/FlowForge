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
  'trigger-schedule': {
    label: 'Schedule Trigger',
    subtype: 'schedule',
    config: { cron: '0 9 * * *' },
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
  // Switch: multi-way routing. Each case has a label (its branch handle) and an
  // FXL boolean; the run takes the first matching case's branch, or 'default'.
  'switch': {
    label: 'Switch',
    subtype: 'switch',
    config: { cases: [{ label: 'case-1', expression: '' }] },
  },
  // Filter: keep the items of a list that satisfy an FXL predicate. source is a
  // template resolving to an array; predicate is a boolean expression evaluated
  // per item (item fields in scope directly, plus item / index / items).
  'filter': {
    label: 'Filter',
    subtype: 'filter',
    config: { source: '', predicate: '' },
  },
  // Map: reshape each item of a list with an FXL expression (usually an object
  // literal). Same source + per-item scope as Filter; mapping replaces predicate.
  'map': {
    label: 'Map',
    subtype: 'map',
    config: { source: '', mapping: '' },
  },
  // Aggregate: roll a list up to { count, sum, avg, min, max } over an optional
  // value expression, optionally grouped by an FXL key.
  'aggregate': {
    label: 'Aggregate',
    subtype: 'aggregate',
    config: { source: '', value: '', groupBy: '' },
  },
  // Approval: pauses the run until a workspace member approves or rejects,
  // then routes down the matching branch. timeoutMinutes bounds the wait;
  // onTimeout picks what an expired wait does ('reject' the branch, or 'fail'
  // the run).
  'approval': {
    label: 'Approval',
    subtype: 'approval',
    config: { message: '', timeoutMinutes: 60, onTimeout: 'reject' },
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
  'output-return': {
    label: 'Return Output',
    subtype: 'return',
    config: {},
  },
  // Sub-workflow: runs another deployed workflow as a step. workflowId is the
  // target (the only field the runner reads); workflowName is denormalized purely
  // for the canvas label and is refreshed from the live list in the config panel.
  'sub-workflow': {
    label: 'Sub-workflow',
    subtype: 'sub-workflow',
    config: { workflowId: '', workflowName: '' },
  },
  // For-each: runs a deployed workflow once per item of a list. items is a
  // template resolving to an array (or literal JSON); each iteration receives
  // { item, index, total } as its trigger payload.
  'for-each': {
    label: 'For Each',
    subtype: 'for-each',
    config: { items: '', workflowId: '', workflowName: '', continueOnError: false },
  },
}

export const TOOLBAR_BUTTONS = [
  { type: 'trigger-manual', label: 'Trigger', className: 'toolbar-btn--trigger' },
  { type: 'trigger-webhook', label: 'Webhook', className: 'toolbar-btn--trigger' },
  { type: 'trigger-schedule', label: 'Schedule', className: 'toolbar-btn--trigger' },
  { type: 'action-http', label: 'HTTP', className: 'toolbar-btn--action' },
  { type: 'action-delay', label: 'Delay', className: 'toolbar-btn--action' },
  { type: 'action-email', label: 'Email', className: 'toolbar-btn--action' },
  { type: 'action-slack', label: 'Slack', className: 'toolbar-btn--action' },
  { type: 'transform', label: 'Transform', className: 'toolbar-btn--action' },
  { type: 'filter', label: 'Filter', className: 'toolbar-btn--action' },
  { type: 'map', label: 'Map', className: 'toolbar-btn--action' },
  { type: 'aggregate', label: 'Aggregate', className: 'toolbar-btn--action' },
  { type: 'condition', label: 'Condition', className: 'toolbar-btn--condition' },
  { type: 'switch', label: 'Switch', className: 'toolbar-btn--condition' },
  { type: 'approval', label: 'Approval', className: 'toolbar-btn--approval' },
  { type: 'ai-prompt', label: 'AI', className: 'toolbar-btn--ai' },
  { type: 'ai-classify', label: 'Classify', className: 'toolbar-btn--ai' },
  { type: 'ai-extract', label: 'Extract', className: 'toolbar-btn--ai' },
  { type: 'output-log', label: 'Output', className: 'toolbar-btn--output' },
  { type: 'output-return', label: 'Return', className: 'toolbar-btn--output' },
  { type: 'sub-workflow', label: 'Sub-workflow', className: 'toolbar-btn--subworkflow' },
  { type: 'for-each', label: 'For Each', className: 'toolbar-btn--foreach' },
]
