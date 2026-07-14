// Built-in workflow templates for the gallery.
//
// Each template's graph uses the exact { nodes, edges } shape the canvas saves
// (see hooks/useWorkflow serializeGraph) so a cloned template is immediately
// usable: nodes are { id, type, position, data: { label, config } } and edges
// carry sourceHandle/targetHandle (condition branches use 'true'/'false').
// Configs are pre-filled with sensible defaults and {{node-id.field}} templates
// that the execution engine resolves from upstream node output at run time.
//
// Seeding is idempotent: on startup the table is populated only when empty (so
// admin edits/removals survive restarts). Run directly to force a refresh:
//   node src/db/templates.js

const { v4: uuidv4 } = require('uuid')

// Node ids are semantic and unique within a single template so the {{...}}
// references read clearly (e.g. {{classify.label}}). They only need to be unique
// per graph, and clone copies the graph verbatim, so reuse across templates is fine.
function n(id, type, label, x, y, config = {}) {
  return { id, type, position: { x, y }, data: { label, config } }
}

function e(source, target, sourceHandle = null) {
  return { id: `e-${source}-${target}`, source, target, sourceHandle, targetHandle: null }
}

const X = (i) => i * 240 // horizontal step between nodes in a linear flow
const Y = 120

function buildTemplates() {
  return [
    // 1 ---------------------------------------------------------------------
    {
      name: 'Webhook → AI Classify → Slack Alert',
      category: 'AI Automation',
      description:
        'Receive an event via webhook, classify its message with AI, and post a categorized alert to Slack.',
      graph: {
        nodes: [
          n('trigger', 'trigger-webhook', 'Incoming Event', X(0), Y),
          n('classify', 'ai-classify', 'Classify Message', X(1), Y, {
            text: '{{trigger.message}}',
            labels: 'urgent, normal, spam',
          }),
          n('alert', 'action-slack', 'Send Slack Alert', X(2), Y, {
            webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
            text: 'New event classified as *{{classify.label}}*:\n{{trigger.message}}',
          }),
        ],
        edges: [e('trigger', 'classify'), e('classify', 'alert')],
      },
    },

    // 2 ---------------------------------------------------------------------
    {
      name: 'Schedule → HTTP Fetch → Transform → Email Report',
      category: 'Reporting',
      description:
        'On a schedule, fetch metrics from an API, reshape them into a report, and email it to your team.',
      graph: {
        nodes: [
          n('trigger', 'trigger-manual', 'Daily Schedule', X(0), Y),
          n('fetch', 'action-http', 'Fetch Metrics', X(1), Y, {
            method: 'GET',
            url: 'https://api.example.com/metrics/daily',
            headers: '{}',
            body: '',
          }),
          n('shape', 'transform', 'Build Report', X(2), Y, {
            template:
              '{\n  "report": "Daily Metrics",\n  "totalUsers": "{{fetch.body.totalUsers}}",\n  "activeUsers": "{{fetch.body.activeUsers}}",\n  "revenue": "{{fetch.body.revenue}}"\n}',
          }),
          n('email', 'action-email', 'Email Report', X(3), Y, {
            to: 'team@example.com',
            subject: 'Daily Metrics Report',
            body:
              'Here is your daily metrics report.\n\nTotal users: {{shape.totalUsers}}\nActive users: {{shape.activeUsers}}\nRevenue: {{shape.revenue}}',
          }),
        ],
        edges: [e('trigger', 'fetch'), e('fetch', 'shape'), e('shape', 'email')],
      },
    },

    // 3 ---------------------------------------------------------------------
    {
      name: 'Webhook → Condition → Branch A: Email / Branch B: Slack',
      category: 'Notifications',
      description:
        'Route an incoming alert by priority: high-priority alerts email the on-call engineer, everything else posts to Slack.',
      graph: {
        nodes: [
          n('trigger', 'trigger-webhook', 'Incoming Alert', X(0), Y),
          n('check', 'condition', 'High Priority?', X(1), Y, {
            left: '{{trigger.priority}}',
            operator: 'equals',
            right: 'high',
          }),
          // Branch A (true): page the on-call engineer.
          n('email', 'action-email', 'Email On-Call (Branch A)', X(2), Y - 80, {
            to: 'oncall@example.com',
            subject: 'High priority alert',
            body: 'A high priority alert arrived:\n\n{{trigger.message}}',
          }),
          // Branch B (false): low-priority alerts go to a Slack channel.
          n('slack', 'action-slack', 'Post to Slack (Branch B)', X(2), Y + 80, {
            webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
            text: 'New alert ({{trigger.priority}}): {{trigger.message}}',
          }),
        ],
        edges: [
          e('trigger', 'check'),
          e('check', 'email', 'true'),
          e('check', 'slack', 'false'),
        ],
      },
    },

    // 4 ---------------------------------------------------------------------
    {
      name: 'Webhook → AI Extract → HTTP POST to API',
      category: 'Data Processing',
      description:
        'Take free-form text from a webhook, extract structured fields with AI, and POST them to an external API.',
      graph: {
        nodes: [
          n('trigger', 'trigger-webhook', 'Form Submission', X(0), Y),
          n('extract', 'ai-extract', 'Extract Fields', X(1), Y, {
            text: '{{trigger.text}}',
            fields: 'name, email, company, message',
          }),
          n('post', 'action-http', 'Send to CRM', X(2), Y, {
            method: 'POST',
            url: 'https://api.example.com/crm/contacts',
            headers: '{"Content-Type":"application/json"}',
            body:
              '{\n  "name": "{{extract.data.name}}",\n  "email": "{{extract.data.email}}",\n  "company": "{{extract.data.company}}",\n  "message": "{{extract.data.message}}"\n}',
          }),
        ],
        edges: [e('trigger', 'extract'), e('extract', 'post')],
      },
    },

    // 5 ---------------------------------------------------------------------
    {
      name: 'Webhook → Delay → HTTP Retry',
      category: 'Resilience',
      description:
        'Wait before calling a downstream API so it has time to settle. The HTTP step auto-retries with exponential backoff on failure.',
      graph: {
        nodes: [
          n('trigger', 'trigger-webhook', 'Trigger', X(0), Y),
          n('delay', 'action-delay', 'Wait 5s', X(1), Y, { durationMs: 5000 }),
          n('call', 'action-http', 'Call API (auto-retries)', X(2), Y, {
            method: 'POST',
            url: 'https://api.example.com/process',
            headers: '{"Content-Type":"application/json"}',
            body: '{\n  "event": "{{trigger.event}}",\n  "stage": "after-delay"\n}',
          }),
        ],
        edges: [e('trigger', 'delay'), e('delay', 'call')],
      },
    },

    // 6 ---------------------------------------------------------------------
    {
      name: 'Webhook → Approval Gate → Deploy Call',
      category: 'Human in the Loop',
      description:
        'Pause a deployment for sign-off: the run waits at an approval gate (every workspace member is notified), then calls the deploy API on approval or posts a rejection notice to Slack.',
      graph: {
        nodes: [
          n('trigger', 'trigger-webhook', 'Release Ready', X(0), Y),
          n('gate', 'approval', 'Deploy Approval', X(1), Y, {
            message: 'Deploy {{trigger.version}} to production?',
            timeoutMinutes: 240,
            onTimeout: 'reject',
          }),
          // Approved: fire the deployment.
          n('deploy', 'action-http', 'Trigger Deploy', X(2), Y - 80, {
            method: 'POST',
            url: 'https://api.example.com/deploy',
            headers: '{"Content-Type":"application/json"}',
            body: '{\n  "version": "{{trigger.version}}",\n  "approvedBy": "{{gate.respondedBy}}"\n}',
          }),
          // Rejected (or timed out): tell the channel why nothing shipped.
          n('slack', 'action-slack', 'Announce Rejection', X(2), Y + 80, {
            webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
            text: 'Deploy of {{trigger.version}} was not approved ({{gate.outcome}}).',
          }),
        ],
        edges: [
          e('trigger', 'gate'),
          e('gate', 'deploy', 'true'),
          e('gate', 'slack', 'false'),
        ],
      },
    },

    // 7 ---------------------------------------------------------------------
    {
      name: 'Schedule → AI Prompt → Log Output',
      category: 'AI Automation',
      description:
        'On a schedule, generate text with an AI prompt and record the result to the execution log.',
      graph: {
        nodes: [
          n('trigger', 'trigger-manual', 'Daily Schedule', X(0), Y),
          n('prompt', 'ai-prompt', 'Generate Message', X(1), Y, {
            prompt: 'Write a short, upbeat daily standup greeting for an engineering team.',
            system: 'You are a concise assistant that writes friendly team messages.',
          }),
          n('log', 'output-log', 'Log Result', X(2), Y, {
            message: '{{prompt.text}}',
          }),
        ],
        edges: [e('trigger', 'prompt'), e('prompt', 'log')],
      },
    },

    // 8 ---------------------------------------------------------------------
    {
      name: 'Webhook → Validate → Switch by Tier → Route',
      category: 'Validation & Routing',
      description:
        'Validate an incoming order against a JSON Schema (malformed payloads divert to an alert), then route valid orders by customer tier — enterprise, pro, or a default — to the right handler.',
      graph: {
        nodes: [
          n('trigger', 'trigger-webhook', 'Incoming Order', X(0), Y),
          n('validate', 'validate', 'Validate Order', X(1), Y, {
            schema:
              '{\n  "type": "object",\n  "required": ["orderId", "total", "tier"],\n  "properties": {\n    "orderId": { "type": "string" },\n    "total": { "type": "number", "minimum": 0 },\n    "tier": { "type": "string", "enum": ["enterprise", "pro", "basic"] }\n  }\n}',
            source: '',
          }),
          // Invalid branch: tell the channel the payload was rejected and why.
          n('malformed', 'action-slack', 'Malformed Payload', X(2), Y + 200, {
            webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
            text: 'Rejected an order with an invalid payload: {{validate.errors}}',
          }),
          // Valid branch: route by tier (reads validate.data, the checked payload).
          n('route', 'switch', 'Route by Tier', X(2), Y, {
            cases: [
              { label: 'enterprise', expression: 'data.tier == "enterprise"' },
              { label: 'pro', expression: 'data.tier == "pro"' },
            ],
          }),
          n('enterprise', 'action-email', 'Enterprise Handler', X(3), Y - 160, {
            to: 'enterprise-desk@example.com',
            subject: 'Enterprise order {{validate.data.orderId}}',
            body: 'A new enterprise order arrived: {{validate.data.orderId}} (total {{validate.data.total}}).',
          }),
          n('pro', 'action-slack', 'Pro Handler', X(3), Y, {
            webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
            text: 'Pro order {{validate.data.orderId}} — total {{validate.data.total}}.',
          }),
          n('basic', 'output-log', 'Basic Handler (default)', X(3), Y + 160, {
            message: 'Basic order {{validate.data.orderId}} logged.',
          }),
        ],
        edges: [
          e('trigger', 'validate'),
          e('validate', 'route', 'valid'),
          e('validate', 'malformed', 'invalid'),
          e('route', 'enterprise', 'enterprise'),
          e('route', 'pro', 'pro'),
          e('route', 'basic', 'default'),
        ],
      },
    },
  ]
}

// Idempotent seed. With { force: true } it wipes and reinserts; otherwise it
// inserts only when the table is empty (the startup path, so customizations
// aren't clobbered on every restart).
function seedTemplates(db, { force = false } = {}) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM templates').get()
  if (c > 0 && !force) return { inserted: 0, skipped: true }

  const templates = buildTemplates()
  const insertAll = db.transaction((rows) => {
    db.prepare('DELETE FROM templates').run()
    const stmt = db.prepare(
      'INSERT INTO templates (id, name, description, category, graph_data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const now = new Date().toISOString()
    for (const t of rows) {
      stmt.run(uuidv4(), t.name, t.description, t.category, JSON.stringify(t.graph), now)
    }
  })
  insertAll(templates)
  return { inserted: templates.length }
}

if (require.main === module) {
  const db = require('../config/database')
  const result = seedTemplates(db, { force: true })
  console.log(`Seeded ${result.inserted} workflow templates.`)
}

module.exports = { seedTemplates, buildTemplates }
