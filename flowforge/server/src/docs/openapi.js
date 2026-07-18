// OpenAPI 3.0 document for the public /api/v1 surface. Served at
// GET /api/v1/openapi.json so external consumers can import the API into
// Postman/Insomnia or generate typed clients. Kept as a plain object next to
// the routes it describes — update both together.

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'FlowForge public API',
    version: '1.0.0',
    description:
      'Token-authenticated REST API for integrating FlowForge workflows into ' +
      'external systems: trigger a run from CI or another service, poll it to ' +
      'completion, cancel it, or settle its approval gates. Tokens are created ' +
      'in the app under Settings → API tokens and carry scopes (`trigger`, ' +
      '`read`, `approve`).',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'workspaces', description: 'Workspaces and workflow import' },
    { name: 'workflows', description: 'Discover and trigger workflows' },
    { name: 'executions', description: 'Inspect and control runs' },
    { name: 'approvals', description: 'Human-in-the-loop approval gates' },
  ],
  paths: {
    '/workspaces': {
      get: {
        tags: ['workspaces'],
        summary: 'List workspaces',
        description:
          'The workspaces the token owner belongs to — the target ids for ' +
          'importing a workflow. Requires the `read` scope.',
        operationId: 'listWorkspaces',
        responses: {
          200: {
            description: 'The owner’s workspaces.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workspaces: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflows/import': {
      post: {
        tags: ['workspaces'],
        summary: 'Import a workflow from a portable document',
        description:
          'Creates a new draft workflow in the workspace from an exported ' +
          'document ({ name, graph_data }) — the write half of the ' +
          'workflows-as-code loop, so CI can promote a definition that lives ' +
          'in git into another environment. The workflow lands as a draft: ' +
          'deploying stays a deliberate act in the app. Requires the ' +
          'dedicated `manage` scope.',
        operationId: 'importWorkflow',
        parameters: [
          {
            name: 'workspaceId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'graph_data'],
                properties: {
                  name: { type: 'string', maxLength: 200 },
                  graph_data: {
                    type: 'object',
                    required: ['nodes', 'edges'],
                    properties: {
                      nodes: { type: 'array', items: { type: 'object' } },
                      edges: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'The created draft workflow.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { workflow: { $ref: '#/components/schemas/Workflow' } },
                },
              },
            },
          },
          400: {
            description: 'Missing name or malformed graph_data.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          413: {
            description: 'The graph exceeds the 500KB import cap.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows': {
      get: {
        tags: ['workflows'],
        summary: 'List workflows visible to the token owner',
        description:
          'Workflows across every workspace the token’s owner belongs to. ' +
          'Requires the `read` scope.',
        operationId: 'listWorkflows',
        responses: {
          200: {
            description: 'The visible workflows, most recently updated first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflows: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Workflow' },
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/search': {
      get: {
        tags: ['workflows'],
        summary: 'Full-text search across workflows',
        description:
          'Searches workflow names, descriptions, and graph contents — node ' +
          'labels, config strings, sticky-note text — across every workspace ' +
          'the token’s owner belongs to. The final term prefix-matches, so ' +
          '`stri` finds stripe. Each hit reports which field matched and a ' +
          'snippet with the matched terms in [brackets]. Requires the `read` ' +
          'scope.',
        operationId: 'searchWorkflows',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            description: 'Free-text query (1–200 chars).',
            schema: { type: 'string', maxLength: 200 },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Maximum hits to return (1–50, default 20).',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        ],
        responses: {
          200: {
            description: 'Ranked matches, best first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    results: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/SearchResult' },
                    },
                  },
                },
              },
            },
          },
          400: {
            description: 'Missing or over-long query.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/trigger': {
      post: {
        tags: ['workflows'],
        summary: 'Start a workflow run',
        description:
          'Enqueues a run. The JSON body (if any) becomes the trigger payload, ' +
          'flowing into the graph exactly like a webhook body — downstream ' +
          'nodes read it as `{{trigger-node-id.field}}`. Requires the ' +
          '`trigger` scope. Send an `Idempotency-Key` header to make retries ' +
          'safe: the same key returns the original run (`replayed: true`, ' +
          'plus an `Idempotent-Replay: true` header) for 24 hours, and ' +
          'reusing a key with a different body is rejected with 409.',
        operationId: 'triggerWorkflow',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description:
              'Any unique string (≤ 255 chars), e.g. a UUID per logical ' +
              'request. Scoped to the token owner and workflow.',
            schema: { type: 'string', maxLength: 255 },
          },
          {
            name: 'priority',
            in: 'query',
            required: false,
            description:
              'Queue lane for this run, overriding the workflow’s default. ' +
              'Priority orders pickup from the queue (high before normal ' +
              'before low); it never preempts runs already executing. A ' +
              'query parameter — not a body field — because the entire body ' +
              'is the trigger payload.',
            schema: { type: 'string', enum: ['high', 'normal', 'low'] },
          },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true,
                example: { orderId: 42, amount: 19.99 },
              },
            },
          },
        },
        responses: {
          202: {
            description: 'The run was enqueued; poll `statusUrl` for progress.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    execution: { $ref: '#/components/schemas/ExecutionRef' },
                    statusUrl: { type: 'string', example: '/api/v1/executions/e57a…' },
                  },
                },
              },
            },
          },
          400: {
            description: 'The workflow has no nodes to execute, or the Idempotency-Key is malformed.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: {
            description:
              'The Idempotency-Key was already used with a different request ' +
              'body — or the workflow caps concurrent runs with the reject ' +
              'policy and is at its cap.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/executions': {
      get: {
        tags: ['executions'],
        summary: 'List a workflow’s recent runs',
        description:
          'Run summaries (no step payloads), newest first. Poll ' +
          'GET /executions/{executionId} for step-level detail. Requires the ' +
          '`read` scope.',
        operationId: 'listExecutions',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            description: 'Page size (1–100).',
          },
        ],
        responses: {
          200: {
            description: 'The workflow’s recent runs.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    executions: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ExecutionSummary' },
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/insights': {
      get: {
        tags: ['workflows'],
        summary: 'Run insights for a workflow',
        description:
          'A statistical rollup of the workflow’s recent runs: duration ' +
          'percentiles over completed runs, success rate over settled runs, ' +
          'throughput, the slowest steps, and per-run anomaly flags (a robust ' +
          'modified z-score marks abnormally slow runs). Dry-runs are excluded. ' +
          'Requires the `read` scope.',
        operationId: 'getWorkflowInsights',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
            description: 'How many recent runs form the window (1–500).',
          },
        ],
        responses: {
          200: {
            description: 'The insight bundle.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Insights' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/forecast': {
      get: {
        tags: ['workflows'],
        summary: 'Forecast a workflow’s next-run duration',
        description:
          'A predictive estimate of how long the workflow’s next run will take, ' +
          'computed as the critical path (longest dependency chain) over each ' +
          'node’s historical step timing — typical (p50) and worst-case (p95) — ' +
          'plus the likely bottleneck node. `coverage` reports how much of the ' +
          'graph has history, so a thinly-exercised workflow’s estimate is ' +
          'marked as the guess it is. Requires the `read` scope.',
        operationId: 'getWorkflowForecast',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The forecast (or `available: false` for an empty or cyclic graph).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Forecast' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/schedule': {
      get: {
        tags: ['workflows'],
        summary: 'Preview a workflow’s upcoming scheduled runs',
        description:
          'The next fire times of the workflow’s schedule trigger, computed from ' +
          'its cron expression (UTC, ISO-8601). `scheduled: false` when the ' +
          'workflow has no schedule trigger; `active` reflects whether the ' +
          'schedule is live (the workflow is deployed). `?count` caps the number ' +
          'of upcoming runs returned (default 5, max 25). Requires the `read` scope.',
        operationId: 'getWorkflowSchedule',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'count',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
            description: 'How many upcoming fire times to return.',
          },
        ],
        responses: {
          200: {
            description: 'The workflow’s upcoming scheduled runs.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Schedule' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/export': {
      get: {
        tags: ['workflows'],
        summary: 'Export a workflow as a portable document',
        description:
          'The workflow in the same portable, self-contained shape the app’s ' +
          'Export button downloads (no internal ids or ownership) — pipe it to ' +
          'a file and check it into version control. The document round-trips ' +
          'through the app’s import. Requires the `read` scope.',
        operationId: 'exportWorkflow',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The portable workflow document.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    exportVersion: { type: 'string', example: '1.0' },
                    name: { type: 'string' },
                    description: { type: 'string', nullable: true },
                    graph_data: {
                      type: 'object',
                      properties: {
                        nodes: { type: 'array', items: { type: 'object' } },
                        edges: { type: 'array', items: { type: 'object' } },
                      },
                    },
                    exportedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/diff': {
      post: {
        tags: ['workflows'],
        summary: 'Diff the live workflow against a portable document (drift detection)',
        description:
          'Compares the workflow as deployed against an exported document ' +
          '(the same { graph_data } shape export produces), answering "is ' +
          'the live workflow still what the file in git says it is?". The ' +
          'diff reads from the document’s perspective: addedNodes exist ' +
          'live but not in the document. Nodes match by id (canvas position ' +
          'is ignored — moving a node is not drift), edges by their ' +
          '(source, target, sourceHandle) triple. Read-only; requires the ' +
          '`read` scope. `flowforge diff <id> <file>` wraps this and exits ' +
          'non-zero on drift.',
        operationId: 'diffWorkflow',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['graph_data'],
                properties: {
                  graph_data: {
                    type: 'object',
                    required: ['nodes', 'edges'],
                    properties: {
                      nodes: { type: 'array', items: { type: 'object' } },
                      edges: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'The drift report (`identical` is the gate).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DriftReport' },
              },
            },
          },
          400: {
            description: 'Malformed graph_data.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          413: {
            description: 'The graph exceeds the 500KB cap.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/tests/run': {
      post: {
        tags: ['workflows'],
        summary: 'Run the workflow’s test scenarios (CI gate)',
        description:
          'Run every test scenario defined for the workflow — each a trigger ' +
          'payload plus FXL assertions over the resulting run’s output — through ' +
          'the engine in dry-run mode (side-effecting nodes don’t fire, approvals ' +
          'auto-approve), and return a pass/fail rollup. `ok: false` means at ' +
          'least one scenario failed: fail the CI job on it. Requires the ' +
          '`trigger` scope (it executes the workflow).',
        operationId: 'runWorkflowTests',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The suite result (`ok` is the gate).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TestSuiteResult' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/executions/{executionId}': {
      get: {
        tags: ['executions'],
        summary: 'Poll a run',
        description:
          'The run’s status plus every step with its (secret-redacted) input ' +
          'and output. `status` progresses pending → running → completed | ' +
          'failed | cancelled. Requires the `read` scope.',
        operationId: 'getExecution',
        parameters: [{ $ref: '#/components/parameters/ExecutionId' }],
        responses: {
          200: {
            description: 'The execution and its steps.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    execution: { $ref: '#/components/schemas/Execution' },
                    steps: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ExecutionStep' },
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/executions/{executionId}/compare/{otherExecutionId}': {
      get: {
        tags: ['executions'],
        summary: 'Compare two runs',
        description:
          'Diffs two runs of the same workflow node by node: status changes, ' +
          'per-step duration deltas, and output differences (computed over ' +
          'the persisted, secret-redacted step rows; output equality is ' +
          'structural, ignoring key order). The summary names the slowest ' +
          'regression. Requires the `read` scope.',
        operationId: 'compareExecutions',
        parameters: [
          { $ref: '#/components/parameters/ExecutionId' },
          {
            name: 'otherExecutionId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'The node-by-node diff with a summary.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    base: { $ref: '#/components/schemas/ComparedRun' },
                    other: { $ref: '#/components/schemas/ComparedRun' },
                    nodes: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/NodeComparison' },
                    },
                    summary: { $ref: '#/components/schemas/ComparisonSummary' },
                  },
                },
              },
            },
          },
          400: {
            description: 'The executions belong to different workflows.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/approvals': {
      get: {
        tags: ['approvals'],
        summary: 'List approval requests',
        description:
          'Approval-gate requests across every workspace the token owner ' +
          'belongs to, newest first (100 max). Defaults to the pending inbox — ' +
          'what is waiting on a human right now. Requires the `read` scope.',
        operationId: 'listApprovals',
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['pending', 'approved', 'rejected', 'timed-out', 'cancelled'],
              default: 'pending',
            },
          },
        ],
        responses: {
          200: {
            description: 'Approval requests with the given status.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    approvals: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Approval' },
                    },
                  },
                },
              },
            },
          },
          400: {
            description: 'Unknown status filter.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/approvals/{approvalId}/respond': {
      post: {
        tags: ['approvals'],
        summary: 'Approve or reject a waiting run',
        description:
          'Settles a pending approval gate; the paused run then continues down ' +
          'the approved or rejected branch. Requires the dedicated `approve` ' +
          'scope — a token that can trigger runs cannot implicitly wave them ' +
          'through their own gates. Exactly one responder wins a race; the ' +
          'loser receives 409 with the verdict.',
        operationId: 'respondToApproval',
        parameters: [{ $ref: '#/components/parameters/ApprovalId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['decision'],
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                  note: { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'The settled approval.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { approval: { $ref: '#/components/schemas/Approval' } },
                },
              },
            },
          },
          400: {
            description: 'decision was not "approve" or "reject".',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: {
            description: 'The approval was already settled.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/executions/{executionId}/resume': {
      post: {
        tags: ['executions'],
        summary: 'Resume a failed or cancelled run',
        description:
          'Starts a fresh execution that continues the given run from where ' +
          'it stopped: steps that already succeeded are not re-executed — ' +
          'their recorded outputs are adopted (step status `reused`) — and ' +
          'only the failed remainder runs again. An approval gate that was ' +
          'already granted is not asked twice. Runs the workflow’s *current* ' +
          'definition: an edited node, and everything downstream of any node ' +
          'that re-executes, runs fresh. Requires the `trigger` scope.',
        operationId: 'resumeExecution',
        parameters: [{ $ref: '#/components/parameters/ExecutionId' }],
        responses: {
          202: {
            description: 'The resumed run was enqueued; poll `statusUrl` for progress.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    execution: { $ref: '#/components/schemas/ExecutionRef' },
                    statusUrl: { type: 'string', example: '/api/v1/executions/f81c…' },
                    resumedFrom: {
                      type: 'string',
                      description: 'The id of the failed/cancelled run this one continues.',
                    },
                  },
                },
              },
            },
          },
          400: {
            description: 'The workflow has no nodes to execute.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: {
            description: 'The run is not failed or cancelled, so there is nothing to resume.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/executions/{executionId}/cancel': {
      post: {
        tags: ['executions'],
        summary: 'Cancel a run',
        description:
          'Stops a queued or running execution. Queued runs finalize as ' +
          '`cancelled` immediately; running ones are wound down cooperatively — ' +
          'the node in flight finishes, the rest is skipped (`cancelling: true` ' +
          'in the response while that happens). Requires the `trigger` scope.',
        operationId: 'cancelExecution',
        parameters: [{ $ref: '#/components/parameters/ExecutionId' }],
        responses: {
          202: {
            description: 'Cancellation accepted.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    execution: { $ref: '#/components/schemas/ExecutionRef' },
                    cancelling: {
                      type: 'boolean',
                      description:
                        'True when the run was mid-flight and the engine is still winding it down.',
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: {
            description: 'The run already finished.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A personal access token (`ffp_…`) created under Settings → API tokens.',
      },
    },
    parameters: {
      WorkflowId: {
        name: 'workflowId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'A workflow id from GET /workflows.',
      },
      ExecutionId: {
        name: 'executionId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'An execution id from a trigger response.',
      },
      ApprovalId: {
        name: 'approvalId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'An approval id from GET /approvals.',
      },
    },
    schemas: {
      Workflow: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['draft', 'deployed', 'archived'] },
          workspace_id: { type: 'string' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      ExecutionRef: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workflowId: { type: 'string' },
          status: { $ref: '#/components/schemas/ExecutionStatus' },
        },
      },
      SearchResult: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'deployed', 'archived'] },
          workspaceId: { type: 'string' },
          field: {
            type: 'string',
            enum: ['name', 'description', 'nodes'],
            description: 'Which document field the best match landed in.',
          },
          snippet: {
            type: 'string',
            description: 'Match context with the matched terms in [brackets].',
            example: 'POST https://api.[stripe].com/v1/charges',
          },
        },
      },
      Execution: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workflowId: { type: 'string' },
          status: { $ref: '#/components/schemas/ExecutionStatus' },
          triggerType: { type: 'string', nullable: true, example: 'api' },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          finishedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      ExecutionSummary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workflowId: { type: 'string' },
          status: { $ref: '#/components/schemas/ExecutionStatus' },
          triggerType: { type: 'string', nullable: true, example: 'webhook' },
          priority: {
            type: 'string',
            enum: ['high', 'normal', 'low'],
            nullable: true,
            description: 'The queue lane the run took (null on runs predating lanes).',
          },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          finishedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      ExecutionStatus: {
        type: 'string',
        enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
      },
      Insights: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          window: {
            type: 'object',
            description: 'The run window these numbers cover.',
            properties: {
              limit: { type: 'integer' },
              runs: { type: 'integer' },
              since: { type: 'string', format: 'date-time', nullable: true },
              until: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          counts: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              completed: { type: 'integer' },
              failed: { type: 'integer' },
              cancelled: { type: 'integer' },
              running: { type: 'integer' },
            },
          },
          successRate: {
            type: 'number',
            nullable: true,
            description: 'completed / (completed + failed); null with no settled runs.',
          },
          sla: {
            type: 'object',
            nullable: true,
            description: 'Compliance against the workflow’s SLA targets; null when none are set.',
            properties: {
              maxDurationMs: { type: 'integer', nullable: true },
              minSuccessRate: { type: 'number', nullable: true },
              durationCompliant: { type: 'boolean', nullable: true },
              successRateCompliant: { type: 'boolean', nullable: true },
            },
          },
          throughput: {
            type: 'object',
            properties: {
              runs: { type: 'integer' },
              spanDays: { type: 'number', nullable: true },
              perDay: { type: 'number', nullable: true },
            },
          },
          duration: {
            type: 'object',
            description: 'Duration statistics (ms) over completed runs.',
            properties: {
              count: { type: 'integer' },
              min: { type: 'integer', nullable: true },
              max: { type: 'integer', nullable: true },
              mean: { type: 'integer', nullable: true },
              stdev: { type: 'integer', nullable: true },
              p50: { type: 'integer', nullable: true },
              p90: { type: 'integer', nullable: true },
              p95: { type: 'integer', nullable: true },
              p99: { type: 'integer', nullable: true },
            },
          },
          trend: {
            type: 'object',
            nullable: true,
            description:
              'Duration trend over completed runs (Mann-Kendall). Null until ' +
              'there are enough runs to judge.',
            properties: {
              direction: { type: 'string', enum: ['improving', 'degrading', 'flat'] },
              significant: { type: 'boolean' },
              tau: { type: 'number', nullable: true, description: 'Kendall’s τ effect size, [-1, 1].' },
              z: { type: 'number', nullable: true },
              samples: { type: 'integer' },
              method: { type: 'string', example: 'mann-kendall' },
            },
          },
          anomalyCount: { type: 'integer' },
          slowestSteps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string' },
                nodeType: { type: 'string', nullable: true },
                runs: { type: 'integer' },
                avgDurationMs: { type: 'integer', nullable: true },
                maxDurationMs: { type: 'integer', nullable: true },
              },
            },
          },
          recentRuns: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                status: { $ref: '#/components/schemas/ExecutionStatus' },
                triggerType: { type: 'string', nullable: true },
                startedAt: { type: 'string', format: 'date-time', nullable: true },
                finishedAt: { type: 'string', format: 'date-time', nullable: true },
                durationMs: { type: 'integer', nullable: true },
                anomalyScore: { type: 'number', nullable: true },
                severity: {
                  type: 'string',
                  enum: ['normal', 'slow', 'severe', 'unknown'],
                },
                isAnomaly: { type: 'boolean' },
              },
            },
          },
        },
      },
      Approval: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          executionId: { type: 'string' },
          workflowId: { type: 'string' },
          workflowName: { type: 'string', nullable: true },
          nodeId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected', 'timed-out', 'cancelled'],
          },
          message: { type: 'string', nullable: true },
          requestedAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          respondedAt: { type: 'string', format: 'date-time', nullable: true },
          respondedBy: { type: 'string', nullable: true },
          note: { type: 'string', nullable: true },
        },
      },
      ExecutionStep: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          node_id: { type: 'string' },
          node_type: { type: 'string', nullable: true, example: 'action-http' },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'succeeded', 'failed', 'skipped', 'reused', 'caught'],
            description:
              '`reused` appears in resumed runs: the step was not re-executed — ' +
              'its output was adopted from the run being resumed. `caught` marks ' +
              'a failure handled by the node’s on-error policy: the node failed ' +
              'after its retries, but the run continued (down the error branch ' +
              'or with the error object as the node’s output).',
          },
          input_json: { type: 'string', nullable: true },
          output_json: { type: 'string', nullable: true },
          error: { type: 'string', nullable: true },
          started_at: { type: 'string', format: 'date-time', nullable: true },
          finished_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      ComparedRun: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          triggerType: { type: 'string', nullable: true },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          finishedAt: { type: 'string', format: 'date-time', nullable: true },
          durationMs: { type: 'integer', nullable: true },
        },
      },
      NodeComparison: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          nodeType: { type: 'string', nullable: true },
          base: {
            $ref: '#/components/schemas/ComparisonSide',
          },
          other: {
            $ref: '#/components/schemas/ComparisonSide',
          },
          statusChanged: { type: 'boolean' },
          outputChanged: {
            type: 'boolean',
            description: 'Structural comparison of the parsed outputs — key order is ignored.',
          },
          durationDeltaMs: {
            type: 'integer',
            nullable: true,
            description: 'other − base; positive means the other run was slower here.',
          },
        },
      },
      ComparisonSide: {
        type: 'object',
        nullable: true,
        description: 'Null when the node ran in only one of the two runs.',
        properties: {
          status: { type: 'string' },
          durationMs: { type: 'integer', nullable: true },
          output: { nullable: true },
          error: { type: 'string', nullable: true },
        },
      },
      ComparisonSummary: {
        type: 'object',
        properties: {
          nodesCompared: { type: 'integer' },
          onlyInBase: { type: 'integer' },
          onlyInOther: { type: 'integer' },
          statusChanges: { type: 'integer' },
          outputChanges: { type: 'integer' },
          slowestRegression: {
            type: 'string',
            nullable: true,
            description: 'Node id with the largest positive duration delta.',
          },
        },
      },
      Forecast: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          available: {
            type: 'boolean',
            description: 'False for an empty or cyclic graph (see reason).',
          },
          reason: { type: 'string', enum: ['empty', 'cycle'], nullable: true },
          criticalPath: {
            type: 'array',
            items: { type: 'string' },
            description: 'Node ids on the estimated critical path, source → sink.',
          },
          estimatedMs: { type: 'integer', nullable: true, description: 'Typical (p50) makespan estimate.' },
          estimatedP95Ms: { type: 'integer', nullable: true, description: 'Worst-case (p95) makespan estimate.' },
          bottleneck: {
            type: 'object',
            nullable: true,
            properties: {
              nodeId: { type: 'string' },
              nodeType: { type: 'string', nullable: true },
              p50: { type: 'integer', nullable: true },
              p95: { type: 'integer', nullable: true },
            },
          },
          coverage: {
            type: 'object',
            description: 'How much of the graph has timing history — the confidence signal.',
            properties: {
              nodesWithHistory: { type: 'integer' },
              workNodes: { type: 'integer' },
              ratio: { type: 'number' },
            },
          },
        },
      },
      Schedule: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          scheduled: {
            type: 'boolean',
            description: 'False when the workflow has no schedule trigger.',
          },
          active: {
            type: 'boolean',
            description: 'True when the schedule is live (the workflow is deployed).',
          },
          cron: { type: 'string', description: 'The schedule trigger’s cron expression.' },
          reachable: {
            type: 'boolean',
            description: 'False for a valid but impossible schedule (e.g. Feb 30) that never fires.',
          },
          nextRuns: {
            type: 'array',
            items: { type: 'string', format: 'date-time' },
            description: 'Upcoming fire times, UTC ISO-8601, oldest first.',
          },
        },
      },
      DriftReport: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          identical: {
            type: 'boolean',
            description: 'True when the live workflow matches the document — the CI gate.',
          },
          addedNodes: {
            type: 'array',
            description: 'Nodes present live but not in the document.',
            items: { $ref: '#/components/schemas/DriftNode' },
          },
          removedNodes: {
            type: 'array',
            description: 'Nodes in the document that no longer exist live.',
            items: { $ref: '#/components/schemas/DriftNode' },
          },
          changedNodes: {
            type: 'array',
            items: {
              allOf: [
                { $ref: '#/components/schemas/DriftNode' },
                {
                  type: 'object',
                  properties: {
                    changes: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Dotted paths of what differs: label, type, config.url, …',
                    },
                  },
                },
              ],
            },
          },
          addedEdges: {
            type: 'array',
            items: { $ref: '#/components/schemas/DriftEdge' },
          },
          removedEdges: {
            type: 'array',
            items: { $ref: '#/components/schemas/DriftEdge' },
          },
          summary: {
            type: 'object',
            properties: {
              addedNodes: { type: 'integer' },
              removedNodes: { type: 'integer' },
              changedNodes: { type: 'integer' },
              addedEdges: { type: 'integer' },
              removedEdges: { type: 'integer' },
            },
          },
        },
      },
      DriftNode: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          label: { type: 'string' },
        },
      },
      DriftEdge: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          sourceHandle: { type: 'string', nullable: true },
          description: {
            type: 'string',
            example: 'Fetch orders → Notify (true branch)',
          },
        },
      },
      TestSuiteResult: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          ok: {
            type: 'boolean',
            description: 'True only when every scenario passed — the CI gate.',
          },
          total: { type: 'integer' },
          passed: { type: 'integer' },
          failed: { type: 'integer' },
          scenarios: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                executionId: { type: 'string' },
                runStatus: {
                  type: 'string',
                  description: 'The dry-run’s terminal status, or "timed-out".',
                },
                passed: { type: 'boolean' },
                timedOut: { type: 'boolean' },
                error: { type: 'string', nullable: true },
                assertions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      expression: { type: 'string' },
                      description: { type: 'string', nullable: true },
                      passed: { type: 'boolean' },
                      error: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
    },
    responses: {
      Unauthorized: {
        description: 'Missing, malformed, revoked, or expired token.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: {
        description: 'Token is valid but missing the required scope.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Resource missing, or not visible to the token owner.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      RateLimited: {
        description: 'Per-token rate limit exceeded (see RateLimit-* headers).',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
}

module.exports = spec
