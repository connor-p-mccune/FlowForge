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
    '/workspaces/{workspaceId}/audit': {
      get: {
        tags: ['workspaces'],
        summary: 'Read the audit log',
        description:
          'The workspace’s tamper-evident governance trail: changes to secrets, ' +
          'variables, membership, API tokens, and what is deployed. Each entry ' +
          'carries its position in the hash chain (`seq`, `prevHash`, `hash`), so ' +
          'a caller can verify the record independently of this server. ' +
          'Newest first, keyset-paginated on `seq`. Requires the `read` scope, ' +
          'and the token owner must be a workspace **owner**.',
        operationId: 'listAuditEntries',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'limit',
            in: 'query',
            description: 'Entries per page (1–200, default 50).',
            schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
          {
            name: 'before',
            in: 'query',
            description: 'Return entries with a sequence number below this one.',
            schema: { type: 'integer' },
          },
          {
            name: 'action',
            in: 'query',
            description:
              'Filter to one action, or to a family with a trailing wildcard ' +
              '(`secret.*`).',
            schema: { type: 'string', example: 'secret.*' },
          },
        ],
        responses: {
          200: {
            description: 'A page of audit entries.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entries: { type: 'array', items: { $ref: '#/components/schemas/AuditEntry' } },
                    hasMore: { type: 'boolean' },
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
    '/workspaces/{workspaceId}/audit/verify': {
      get: {
        tags: ['workspaces'],
        summary: 'Verify the audit log’s hash chain',
        description:
          'Recomputes the whole chain and reports the first divergence, if any. ' +
          'A broken chain is reported as `200` with `ok: false` — not an error ' +
          'status — so a monitoring probe can distinguish a compromised log from ' +
          'an unreachable endpoint. `head` is the newest hash: anchoring it ' +
          'outside this system is what detects a wholesale rewrite. Requires the ' +
          '`read` scope and workspace ownership.',
        operationId: 'verifyAuditChain',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'The verification verdict (whether or not the chain is intact).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    entries: { type: 'integer' },
                    head: {
                      type: 'string',
                      nullable: true,
                      description: 'The newest entry’s hash; null when the chain is broken.',
                    },
                    brokenAt: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        seq: { type: 'integer' },
                        id: { type: 'string' },
                        reason: {
                          type: 'string',
                          enum: ['sequence-gap', 'chain-mismatch', 'hash-mismatch'],
                        },
                        detail: { type: 'string' },
                      },
                    },
                    verifiedAt: { type: 'string', format: 'date-time' },
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
          {
            name: 'breakAt',
            in: 'query',
            required: false,
            description:
              'Start the run as a **debug session**: it pauses before each ' +
              'named node runs, exposing the resolved config and input via ' +
              '`GET /executions/{id}/breaks`. A comma-separated list of node ' +
              'ids, or `all` to stop at every node.\n\n' +
              'Polled, printed and immediately resumed, a breakpoint becomes a ' +
              '**trace point** — the run reports exactly what each node was ' +
              'about to send, with templates substituted and secrets redacted, ' +
              'without changing the graph to add logging.\n\n' +
              'Attached to *this* submission, never to the workflow, so a ' +
              'schedule tick or webhook delivery of the same workflow has ' +
              'nowhere to read a breakpoint from. Debug runs take the high lane.',
            schema: { type: 'string', example: 'charge-card,send-receipt' },
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
              'The run could not be admitted — the Idempotency-Key was already ' +
              'used with a different request body, the workflow is paused, it is ' +
              'at its rate limit, or it caps concurrent runs with the reject ' +
              'policy and is at its cap. The error message says which.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/pause': {
      post: {
        tags: ['workflows'],
        summary: 'Pause a workflow (operational kill switch)',
        description:
          'While paused, no new real run starts at any entry point — manual ' +
          'and API triggers, webhook deliveries, schedule ticks, and ' +
          'error-handler escalations are all held. In-flight runs settle ' +
          'normally and dry runs stay allowed, so an incident responder can ' +
          'still test a fix. Idempotent: pausing an already-paused workflow ' +
          'is a safe no-op that keeps the original pause. Requires the ' +
          '`manage` scope — pausing changes durable workflow state, like ' +
          'importing, and is deliberately not the `trigger` scope.',
        operationId: 'pauseWorkflow',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The workflow is paused.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string' },
                    paused: { type: 'boolean', example: true },
                    pausedAt: { type: 'string', format: 'date-time' },
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
    '/workflows/{workflowId}/resume': {
      post: {
        tags: ['workflows'],
        summary: 'Resume a paused workflow',
        description:
          'Releases the kill switch so new runs are accepted again. Nothing ' +
          'skipped while paused is retroactively fired — the next natural ' +
          'trigger just works. Idempotent, like pause. Requires the `manage` ' +
          'scope.',
        operationId: 'resumeWorkflow',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The workflow is active.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string' },
                    paused: { type: 'boolean', example: false },
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
          'marked as the guess it is. `concurrency` reports what the engine’s ' +
          'parallelism cap does to that estimate — the simulated makespan under ' +
          'the cap, how much of it is queueing rather than work, the ceiling on ' +
          'any speedup, and the cap past which more slots buy nothing. ' +
          'Requires the `read` scope.',
        operationId: 'getWorkflowForecast',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'cap',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 64 },
            description:
              'Model a different parallelism cap than the server’s ' +
              'EXEC_MAX_PARALLEL — "what would six slots buy?" without ' +
              'changing anything.',
          },
        ],
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
    '/workflows/{workflowId}/drift': {
      get: {
        tags: ['workflows'],
        summary: 'Detect drift in what the workflow’s nodes produce',
        description:
          '**Output** drift, not definition drift — `/diff` answers whether the ' +
          'graph still matches the document in git; this answers whether the ' +
          'data still looks like the data. ' +
          'Compares the last N runs’ recorded step outputs against the N before ' +
          'them, field by field, and reports what changed: a field that ' +
          'vanished or appeared, a null rate that moved, a type that changed ' +
          'under it, a numeric distribution that shifted (two-sample ' +
          'Kolmogorov-Smirnov), a category mix that shifted (population ' +
          'stability index). The failure mode it exists for is the one every ' +
          'other check is blind to — every run completes, every step succeeds, ' +
          'the durations are unchanged, and an upstream API has quietly started ' +
          'returning nulls. `available: false` with `reason: ' +
          '"insufficient-history"` until both windows have enough runs. ' +
          'Requires the `read` scope.',
        operationId: 'getWorkflowDrift',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'recent',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 200 },
            description: 'Runs in the recent window (default 50).',
          },
          {
            name: 'baseline',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 500 },
            description: 'Runs in the baseline window behind it (default 200).',
          },
        ],
        responses: {
          200: {
            description: 'The output-drift report.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DataDriftReport' },
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
    '/workflows/{workflowId}/dependencies': {
      get: {
        tags: ['workflows'],
        summary: 'Cross-workflow dependencies & impact analysis',
        description:
          'The workflows this one references (sub-workflow / for-each nodes and ' +
          'its error handler) as `dependsOn`, the workflows that reference it as ' +
          '`dependedOnBy`, and any stale cross-workflow reference cycle it sits ' +
          'on as `cycle`. Lets a deploy pipeline refuse to undeploy a workflow ' +
          'others still call, or map the blast radius of a change before making ' +
          'it. Requires the `read` scope.',
        operationId: 'getWorkflowDependencies',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The dependency picture for the workflow.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Dependencies' },
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
    '/workflows/{workflowId}/backfill': {
      post: {
        tags: ['workflows'],
        summary: 'Backfill a schedule over a historical window',
        description:
          'Creates one run per scheduled occurrence in `(from, to]`, each ' +
          'carrying the instant it represents as `logicalDate` in its trigger ' +
          'payload — so a workflow that processes "yesterday" processes the ' +
          'right yesterday. Occurrences are computed with the same cron engine ' +
          'and time zone the live scheduler fires on, so a backfill across a ' +
          'daylight-saving change reproduces what would actually have run.\n\n' +
          'Send `preview: true` to get the plan without creating anything. ' +
          'Occurrences that already have a run are skipped unless ' +
          '`skipExisting` is `false`, so re-submitting an overlapping range is ' +
          'safe. Runs ride the `low` lane by default so a backfill cannot ' +
          'starve live traffic. A paused or undeployed workflow is refused. ' +
          'Requires the `trigger` scope.',
        operationId: 'backfillWorkflow',
        parameters: [
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['from', 'to'],
                properties: {
                  from: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Start of the window (exclusive).',
                  },
                  to: {
                    type: 'string',
                    format: 'date-time',
                    description:
                      'End of the window (inclusive). Clamped to now — a backfill ' +
                      'never creates runs for occurrences that have yet to fire.',
                  },
                  skipExisting: {
                    type: 'boolean',
                    default: true,
                    description: 'Skip occurrences whose logical date already has a run.',
                  },
                  priority: {
                    type: 'string',
                    enum: ['high', 'normal', 'low'],
                    description: 'Queue lane for the generated runs (default `low`).',
                  },
                  preview: {
                    type: 'boolean',
                    description: 'Return the plan without creating any runs.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'The plan (preview mode only) — nothing was created.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    cron: { type: 'string' },
                    timeZone: { type: 'string' },
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                    total: { type: 'integer', description: 'Occurrences in the window.' },
                    skipped: { type: 'integer', description: 'Already covered by a run.' },
                    willRun: { type: 'integer' },
                    occurrences: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          logicalDate: { type: 'string', format: 'date-time' },
                          alreadyRan: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          202: {
            description: 'The batch was created and queued.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    backfillId: { type: 'string' },
                    created: { type: 'integer' },
                    skipped: { type: 'integer' },
                    priority: { type: 'string' },
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                    timeZone: { type: 'string' },
                  },
                },
              },
            },
          },
          400: {
            description:
              'An invalid window, a workflow with no schedule trigger, a range ' +
              'over the occurrence cap, or a range already fully covered.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: {
            description:
              'The workflow is paused — a backfill is exactly the traffic pause holds.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/backfills': {
      get: {
        tags: ['workflows'],
        summary: 'List backfill batches and their progress',
        description:
          'Progress is derived from the runs themselves, so a script that ' +
          'submitted a batch can poll it to completion the way it would poll a ' +
          'single run. Requires the `read` scope.',
        operationId: 'listBackfills',
        parameters: [
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          200: {
            description: 'Batches, newest first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    backfills: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          backfillId: { type: 'string' },
                          total: { type: 'integer' },
                          completed: { type: 'integer' },
                          failed: { type: 'integer' },
                          cancelled: { type: 'integer' },
                          active: { type: 'integer' },
                          firstLogicalDate: { type: 'string', format: 'date-time' },
                          lastLogicalDate: { type: 'string', format: 'date-time' },
                          submittedAt: { type: 'string', format: 'date-time' },
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
          'through the app’s import.\n\n' +
          '`?format=flow` returns the same definition as `text/plain` in the ' +
          '**reviewable text form** instead: nodes sorted by id with their ' +
          'config beneath them, connections gathered at the end, and no ' +
          '`exportedAt` — the field that makes `git diff` on an unchanged ' +
          'workflow non-empty. Its emit order is the signing canonical order, ' +
          'so re-formatting cannot break a signature and two exports of one ' +
          'workflow are byte-identical.\n\n' +
          'Requires the `read` scope.',
        operationId: 'exportWorkflow',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'format',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['json', 'flow'] },
            description: '`flow` serves the reviewable text form as text/plain.',
          },
        ],
        responses: {
          200: {
            description: 'The portable workflow document, as JSON or as `.flow` text.',
            content: {
              'text/plain': {
                schema: { type: 'string' },
                example:
                  'workflow "Order pipeline"\n\nnode hook: trigger-webhook @ 100,200\n' +
                  '  label: "Order webhook"\n\nhook -> charge\n',
              },
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
    '/workflows/{workflowId}/lint': {
      post: {
        tags: ['workflows'],
        summary: 'Lint a workflow (CI gate)',
        description:
          'Static analysis with the same rules and severity contract as the ' +
          'app’s Issues panel: cycles, dangling edges, missing required ' +
          'config, broken FXL expressions, references to unknown ' +
          '`{{secrets.*}}` / `{{vars.*}}` names, undeployed sub-workflow ' +
          'targets. With an empty body the stored graph is linted; with ' +
          '`{ graph_data }` that document is linted instead — against the ' +
          'workspace’s *real* context, so a pipeline can vet an exported ' +
          'file before importing it. `ok` (no errors) is the gate; ' +
          'warnings ride along. Requires the `read` scope. ' +
          '`flowforge lint <id> [file]` wraps this.',
        operationId: 'lintWorkflow',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
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
            description: 'The lint report (`ok` is the gate).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LintReport' },
              },
            },
          },
          400: {
            description: 'Malformed or oversized graph_data.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/canary': {
      get: {
        tags: ['workflows'],
        summary: 'Canary release status and comparison',
        description:
          'The running canary and how it compares against the baseline: run ' +
          'counts, failure rates with Wilson intervals, and the two ' +
          'significance tests (a one-sided two-proportion z-test on failures, ' +
          'Mann-Whitney U on durations). `recommendation` is `promote`, ' +
          '`rollback`, or `wait` — the value a pipeline branches on. Requires ' +
          'the `read` scope.',
        operationId: 'getCanary',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The canary status (`active: false` when none is running).',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CanaryReport' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/canary/promote': {
      post: {
        tags: ['workflows'],
        summary: 'Promote the canary',
        description:
          'The canary definition becomes the deployed one — an ordinary deploy, ' +
          'snapshotting a new version. Requires the `manage` scope (the same one ' +
          'importing a definition needs), so a token that starts runs can never ' +
          'change what runs. Refused with 422 if a workspace policy blocks it.',
        operationId: 'promoteCanary',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'Promoted; the new version number is returned.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    promoted: { type: 'boolean' },
                    version: { type: 'integer' },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          422: {
            description: 'Blocked by a workspace policy.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/canary/rollback': {
      post: {
        tags: ['workflows'],
        summary: 'Roll the canary back',
        description:
          'Traffic goes to 0% and every run takes the baseline version. Nothing ' +
          'is restored and nothing is overwritten — the canary definition is ' +
          'still on the canvas, so it can be fixed and the release resumed. ' +
          'Requires the `manage` scope.',
        operationId: 'rollbackCanary',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { reason: { type: 'string', maxLength: 500 } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Rolled back.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    rolledBack: { type: 'boolean' },
                    reason: { type: 'string' },
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
    '/workflows/{workflowId}/types': {
      get: {
        tags: ['workflows'],
        summary: 'Inferred data schema of the workflow',
        description:
          'The static type of the data flowing through the stored graph: what ' +
          'each node receives, what it produces, and the flattened ' +
          '`{{node.path}}` references it offers. Derived from each runner’s ' +
          'output contract and propagated across the DAG — no run history is ' +
          'consulted, so a workflow that has never executed still reports a ' +
          'schema. Types are `unknown` where nothing can honestly be claimed ' +
          '(a parsed HTTP body, a sub-workflow’s return). Requires the `read` ' +
          'scope.',
        operationId: 'getWorkflowTypes',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The inferred schema, keyed by node id.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TypeReport' },
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
    '/workflows/{workflowId}/merge': {
      post: {
        tags: ['workflows'],
        summary: 'Three-way merge a document into the live workflow',
        description:
          '`diff` detects that git and production have diverged; this resolves ' +
          'it. Merging is per **config field**, so two people editing different ' +
          'fields of the same node combine cleanly — the case that justifies a ' +
          'real three-way merge rather than picking a side. Node position is ' +
          'ignored (dragging is not a semantic change) and identical edits on ' +
          'both sides are agreement, not conflict.\n\n' +
          'The base defaults to the workflow’s latest version snapshot — a ' +
          'deploy is where the exported document came from, so it is the last ' +
          'point the two provably agreed. `baseVersion` (a version number or ' +
          'snapshot id) overrides it.\n\n' +
          'A conflicted merge **produces no graph**: a graph with conflict ' +
          'markers is not a graph, and writing a half-merged definition into a ' +
          'workflow that may be deployed is not an acceptable failure mode. ' +
          'Resolve by hand, or pass `strategy: "ours" | "theirs"` — the ' +
          'equivalent of git’s `-X` options.\n\n' +
          'Previews unless `apply` is true. Requires the `manage` scope.',
        operationId: 'mergeWorkflow',
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
                    description: 'The document to merge in — what `export` produces.',
                    properties: {
                      nodes: { type: 'array', items: { type: 'object' } },
                      edges: { type: 'array', items: { type: 'object' } },
                    },
                  },
                  baseVersion: {
                    oneOf: [{ type: 'integer' }, { type: 'string' }],
                    description: 'Version number or snapshot id to merge against. Defaults to the latest.',
                  },
                  strategy: {
                    type: 'string',
                    enum: ['manual', 'ours', 'theirs'],
                    default: 'manual',
                    description:
                      '`ours` keeps the live value on a conflicted field, `theirs` ' +
                      'takes the document’s. Both are deliberate choices, never defaults.',
                  },
                  apply: {
                    type: 'boolean',
                    default: false,
                    description: 'Write the merged graph. Ignored when the merge conflicts.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'The merge result. `clean` is the gate; `applied` says whether it was written.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string' },
                    clean: { type: 'boolean' },
                    applied: { type: 'boolean' },
                    base: {
                      type: 'object',
                      properties: {
                        versionId: { type: 'string', nullable: true },
                        version: { type: 'integer', nullable: true },
                        createdAt: { type: 'string', format: 'date-time' },
                        note: { type: 'string' },
                      },
                    },
                    conflicts: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/MergeConflict' },
                    },
                    droppedEdges: {
                      type: 'array',
                      description:
                        'Connections removed because the merge deleted an endpoint. ' +
                        'Not a conflict — debris — but reported, because silently ' +
                        'deleting a connection somebody drew is what a merge must not do.',
                      items: {
                        type: 'object',
                        properties: {
                          source: { type: 'string' },
                          target: { type: 'string' },
                          sourceHandle: { type: 'string', nullable: true },
                          reason: { type: 'string' },
                        },
                      },
                    },
                    summary: {
                      type: 'object',
                      properties: {
                        added: { type: 'integer' },
                        removed: { type: 'integer' },
                        changed: { type: 'integer' },
                        unchanged: { type: 'integer' },
                        conflicts: { type: 'integer' },
                        nodes: { type: 'integer' },
                        edges: { type: 'integer' },
                      },
                    },
                    lint: {
                      type: 'object',
                      nullable: true,
                      description:
                        'The linter run against the *merged* graph. Two individually ' +
                        'valid graphs can merge into one that won’t run — a reference ' +
                        'to a node the other side deleted — and after applying is the ' +
                        'worst possible time to find out. Null when the merge conflicted.',
                      properties: {
                        errors: { type: 'integer' },
                        warnings: { type: 'integer' },
                        issues: { type: 'array', items: { $ref: '#/components/schemas/LintIssue' } },
                      },
                    },
                  },
                },
              },
            },
          },
          400: {
            description: 'Malformed graph_data, an unknown strategy, or an unknown baseVersion.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          413: {
            description: 'The graph is larger than 500KB.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/effects': {
      get: {
        tags: ['workflows'],
        summary: 'What a run can do, and what has to be true first',
        description:
          'Every node that reaches outside FlowForge or costs money — an HTTP ' +
          'call, an email, a Slack post, a sub-workflow, a model call — with ' +
          'the **decisions it is control-dependent on**. An effect requires ' +
          'outcome `o` of decision `D` when `D` dominates it *and* exactly one ' +
          'of `D`’s outcomes leads to it; anything ambiguous yields fewer ' +
          'conditions rather than more, because a precondition claimed and not ' +
          'real is a review that concluded the wrong thing.\n\n' +
          'The question a promotion review opens with, and the one neither the ' +
          'linter (a node’s config), lineage (where a value came from) nor the ' +
          'declared guarantees (a property somebody thought to write down) ' +
          'answers. An effect with no conditions happens on every run — ' +
          'including one whose gate a second trigger routes around, which is ' +
          'exactly the case somebody assumes is covered.\n\n' +
          '`decisions` is the same analysis read backwards: for each outcome, ' +
          'which effects it gates — *if this approval rejects, what can still ' +
          'happen?* Requires the `read` scope.',
        operationId: 'getWorkflowEffects',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The effect report, or `available: false` for an empty or cyclic graph.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EffectReport' },
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
    '/workflows/{workflowId}/capacity': {
      get: {
        tags: ['workflows'],
        summary: 'Is the concurrency cap the right number?',
        description:
          '`max_concurrent_runs` is a number somebody typed once. This answers ' +
          'it from three measurements already in the database: how often runs ' +
          'arrive (`created_at`), how long each occupies a slot ' +
          '(`finished_at − started_at`), and how many slots there are.\n\n' +
          'The model is **Allen–Cunneen G/G/c**, not M/M/c. M/M/c assumes ' +
          'exponential service times, and a run that waits on a human approval ' +
          'or retries three times is nothing of the sort — squared coefficients ' +
          'of variation in the tens are ordinary. Allen–Cunneen scales the wait ' +
          'by `(CV²ₐ + CV²ₛ)/2`, which is exactly 1 under the M/M assumptions ' +
          'and 2.5× at a measured service CV² of 4. `model.mmcWaitMeanMs` is ' +
          'what M/M/c would have said, so the cost of the assumption is visible ' +
          'rather than argued about.\n\n' +
          'Read `calibration` first. The wait this model predicts is also ' +
          '*recorded* — `started_at − created_at` is the queueing delay per run ' +
          '— so the report compares its own prediction at the current cap ' +
          'against what actually happened, and publishes the gap. A model that ' +
          'agrees with history has earned the counterfactual it is really being ' +
          'asked for; one that does not still answers, with ' +
          '`recommendation.confident: false`.\n\n' +
          'Past saturation `current.stable` is false and the waits are null: ' +
          'the backlog grows without bound, and a large finite number there ' +
          'would be describing a transient on the way to infinity. ' +
          'Requires the `read` scope.',
        operationId: 'getWorkflowCapacity',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'target',
            in: 'query',
            schema: { type: 'integer', minimum: 0 },
            description:
              'Target mean queue wait in ms. Sizes `recommendation`; omit and no ' +
              'recommendation is made, but `curve` is still returned.',
          },
          {
            name: 'cap',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 512 },
            description:
              'Price a hypothetical cap instead of the stored one. Changes nothing.',
          },
          {
            name: 'days',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
            description: 'Measurement window.',
          },
        ],
        responses: {
          200: {
            description:
              'The capacity report, or `available: false` with a reason ' +
              '(`not-found`, `no-cap`, `not-enough-runs`, `no-service-time`).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CapacityReport' },
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
    '/workflows/{workflowId}/contract': {
      get: {
        tags: ['workflows'],
        summary: 'What this workflow promises its callers',
        description:
          'A workflow’s return type is a promise to the workflows that call ' +
          'it as a sub-workflow. This reports that shape and who depends on ' +
          'it.\n\nThe read form compares the deployed graph with itself, so ' +
          '`change.verdict` is always `compatible`; the value is `before.fields` ' +
          'and the `callers` list. Requires the `read` scope.',
        operationId: 'getWorkflowContract',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'The contract report.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ContractReport' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
      post: {
        tags: ['workflows'],
        summary: 'Would this definition break anybody?',
        description:
          'The promotion gate. Judges a candidate definition against the ' +
          '**target** workspace, so the callers it names are the real ones.\n\n' +
          'The rule is covariance of return types: a change keeps the promise ' +
          'when every value the workflow can now return is one its callers were ' +
          'already prepared to handle. So **narrowing a type is safe and ' +
          'widening it is breaking** — the opposite of the intuition from ' +
          'function arguments, because a return value is something the caller ' +
          'consumes rather than supplies. Optionality flips with it: required → ' +
          'optional breaks a caller that read the field unconditionally.\n\n' +
          'Two levels, and only one is a gate. `change.verdict` describes the ' +
          'shape: `breaking`, `additive` or `compatible`. `summary.broken` ' +
          'counts callers that have a reference which **stops resolving** — a ' +
          'contract that narrowed with nobody currently relying on the part ' +
          'that went is worth knowing and is not a deployment to stop. Gate on ' +
          '`summary.broken`.\n\nBody is `graph_data` or a `flow` string, the ' +
          'same document contract as lint and preview. Requires the `read` ' +
          'scope: it reads graphs and returns an analysis.',
        operationId: 'checkWorkflowContract',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  graph_data: {
                    type: 'object',
                    properties: {
                      nodes: { type: 'array', items: { type: 'object' } },
                      edges: { type: 'array', items: { type: 'object' } },
                    },
                  },
                  flow: {
                    type: 'string',
                    description: 'The `.flow` text form, parsed server-side.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'The contract report for the candidate.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ContractReport' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/workflows/{workflowId}/convergence': {
      get: {
        tags: ['workflows'],
        summary: 'Where parallel branches collide',
        description:
          'When several edges arrive at one node, the engine builds that ' +
          'node’s input by assigning the upstream outputs over each other — so ' +
          'if two branches both produce a `status`, exactly one survives.\n\n' +
          'The merge order is derived from the graph rather than from how it ' +
          'was stored: contributors are ranked by longest-path depth, so a node ' +
          'downstream of another overrides it, and no storage layer can change ' +
          'the answer. What this reports is the part no order can fix. Two ' +
          'contributors at *different* depths are settled — `resolution: ' +
          '"dataflow"` — because the deeper one ran later and saw the ' +
          'shallower one’s value, which a reader can predict from the canvas. ' +
          'Two at the *same* depth are genuinely concurrent, the graph is ' +
          'silent, and the canonical edge sort breaks the tie alphabetically: ' +
          '`resolution: "tie-break"`, and only a human can resolve it.\n\n' +
          'Gate a pipeline on `summary.tieBroken`. Branches that can never both ' +
          'run — a condition’s `true` and `false` handles wired into one join — ' +
          'are not collisions and are never reported. Requires the `read` scope.',
        operationId: 'getWorkflowConvergence',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description:
              'The convergence report, or `available: false` for an empty or cyclic graph.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ConvergenceReport' },
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
    '/workflows/{workflowId}/lineage': {
      get: {
        tags: ['workflows'],
        summary: 'Trace the workflow’s dataflow',
        description:
          'Where each node’s data comes from, what reads it, and which config ' +
          'fields let data leave the system. `?node=<id>` narrows to one ' +
          'node’s **provenance** (what feeds it, back to the trigger field or ' +
          'API response it started as) and **impact** (what breaks if it ' +
          'changes). Origins carry a `trust` level — `untrusted` for a webhook ' +
          'body or callback payload, `external` for a third party’s response, ' +
          '`internal` for authored config, variables and secrets — which is ' +
          'what the taint findings in `lint` are computed from. Read-only and ' +
          'pure; requires the `read` scope.',
        operationId: 'getWorkflowLineage',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'node',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Narrow to one node’s provenance and impact.',
          },
        ],
        responses: {
          200: {
            description: 'The dataflow, or one node’s provenance and impact.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string' },
                    ok: {
                      type: 'boolean',
                      description:
                        'false when the graph has a cycle — there is no dataflow ' +
                        'to report, and inventing an order would produce ' +
                        'confident nonsense.',
                    },
                    nodes: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/LineageNode' },
                    },
                    sinks: {
                      type: 'array',
                      description: 'Config fields where data leaves, and the origins reaching them.',
                      items: { $ref: '#/components/schemas/LineageSink' },
                    },
                    secretReach: {
                      type: 'object',
                      additionalProperties: true,
                      description: 'Secret name → the nodes that can read it.',
                    },
                    findings: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/LintIssue' },
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
    '/workflows/{workflowId}/guarantees': {
      get: {
        tags: ['workflows'],
        summary: 'Verify the workflow’s path invariants',
        description:
          'Checks the invariants the workflow’s author declared about their ' +
          'own graph against **every execution the graph admits** — not ' +
          'against the runs that happened. Three kinds: `requires` (B never ' +
          'runs unless A ran first — A dominates B), `ensures` (if A runs, B ' +
          'runs too — B post-dominates A), and `exclusive` (some decision ' +
          'separates them, so no run reaches both).\n\n' +
          'A different gate from `lint`: lint asks whether the workflow will ' +
          'run, this asks whether it still does what its author swore it did. ' +
          '`ok` is false when any declaration is **violated** *or* has become ' +
          '**uncheckable** (a node it names was deleted), because a guarantee ' +
          'that quietly stopped being verified is the failure this exists to ' +
          'prevent. Violations carry a counterexample — the path that reaches ' +
          'the node without the gate. Read-only; requires the `read` scope.',
        operationId: 'getWorkflowGuarantees',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'One verdict per declaration, plus derived facts and suggestions.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string' },
                    ok: {
                      type: 'boolean',
                      description: 'Every declaration holds. The CI gate.',
                    },
                    results: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/GuaranteeResult' },
                    },
                    facts: {
                      type: 'object',
                      nullable: true,
                      description:
                        'True of the graph regardless of what anyone declared: ' +
                        'which nodes every run executes, and where the ' +
                        'decisions are. Null when the graph cannot be analysed.',
                      properties: {
                        alwaysRuns: { type: 'array', items: { type: 'object' } },
                        decisions: { type: 'array', items: { type: 'object' } },
                      },
                    },
                    suggestions: {
                      type: 'array',
                      description:
                        'Invariants that hold today and look deliberate — a ' +
                        'gate standing in front of something consequential. ' +
                        'Worth pinning before an edit removes them.',
                      items: { $ref: '#/components/schemas/Guarantee' },
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
    '/workflows/{workflowId}/preview': {
      post: {
        tags: ['workflows'],
        summary: 'What would this change have done to the runs we already had?',
        description:
          'Replays the last N real runs against a candidate definition and ' +
          'reports which of them would behave differently — a different ' +
          'branch, a different terminal status, a node that starts or stops ' +
          'running.\n\n' +
          'Every other deploy check is static: `lint` asks whether the graph ' +
          'is well-formed, `verify` whether it still keeps its promises, ' +
          '`paths` whether every branch is live, `diff` whether it changed at ' +
          'all. This asks what the change *does*, which is the question a ' +
          'reviewer has.\n\n' +
          'During each replay every node whose work reaches outside FlowForge ' +
          'is settled from **that run’s own recorded output**, so what ' +
          'executes is the graph’s decision logic and a routing ' +
          'difference is attributable to the edit rather than to test mode ' +
          'simulating a response. The corollary is the scope: it answers what ' +
          'the graph does with the same data, not what a different API ' +
          'returns.\n\n' +
          'Nothing survives the call — the replays are dry runs against a ' +
          'definition the workflow does not hold, and their execution rows are ' +
          'deleted once read — which is why `read` is enough. `ok` means no ' +
          'run behaved differently; that is not a pass/fail on its own, since ' +
          'most changes are meant to change something.',
        operationId: 'previewWorkflowDeploy',
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
                    description: 'The candidate definition, as `export` produces it.',
                    properties: {
                      nodes: { type: 'array', items: { type: 'object' } },
                      edges: { type: 'array', items: { type: 'object' } },
                    },
                  },
                  runs: {
                    type: 'integer',
                    default: 20,
                    maximum: 50,
                    description: 'How many recent runs to replay.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Which runs would behave differently, and how.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string' },
                    ok: { type: 'boolean', description: 'No replayed run behaved differently.' },
                    analysed: {
                      type: 'boolean',
                      description: 'False when the workflow has no run history to replay.',
                    },
                    truncated: {
                      type: 'boolean',
                      description:
                        'The preview ran out of time and saw fewer runs than asked for — ' +
                        'the difference between "nothing changed" and "we did not finish looking".',
                    },
                    runs: { type: 'integer' },
                    identical: { type: 'integer' },
                    changed: { type: 'array', items: { type: 'object' } },
                    summary: { type: 'object' },
                  },
                },
              },
            },
          },
          400: {
            description: 'graph_data is missing, malformed, or has no nodes.',
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
    '/workflows/{workflowId}/regressions': {
      get: {
        tags: ['workflows'],
        summary: 'When this workflow’s duration changed, and what changed with it',
        description:
          'The insights trend says *degrading*, which is true and leaves the ' +
          'whole window to search. This answers the question behind it: **when** ' +
          'the duration stepped, by how much, **which step** moved, and **which ' +
          'deploy** landed in the gap.\n\n' +
          'Detection is Pettitt’s test — the Mann-Whitney statistic evaluated at ' +
          'every split point — under binary segmentation, so it is rank-based ' +
          'like the trend and canary tests already here and makes no assumption ' +
          'about a distribution that is always right-skewed. Attribution joins ' +
          'each change against `workflow_versions`: exactly one deploy in the ' +
          'window is a suspect and comes with its semantic diff, several are a ' +
          'list, and **none is a finding of its own** — the cause is outside ' +
          'this workflow.\n\n' +
          'The CI shape is a release gate: `ok` is false only when a change *for ' +
          'the worse* was detected, so a pipeline running it after a promotion ' +
          'fails on the regression its own deploy caused, and the response names ' +
          'the version. A history too short to analyse is `ok`. Requires `read`.',
        operationId: 'getWorkflowRegressions',
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 300, maximum: 1000 },
            description: 'How many recent completed runs to analyse.',
          },
        ],
        responses: {
          200: {
            description: 'Detected change points, each with its cause.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string' },
                    ok: {
                      type: 'boolean',
                      description: 'No change for the worse was detected.',
                    },
                    analysed: {
                      type: 'boolean',
                      description:
                        'False when the history is too short for a rank test to ' +
                        'mean anything — which is not the same as "nothing found".',
                    },
                    runs: { type: 'integer' },
                    changePoints: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/RegressionChangePoint' },
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
    '/workflows/{workflowId}/paths': {
      get: {
        tags: ['workflows'],
        summary: 'Which branches an input can take, and what payload takes them',
        description:
          'Path feasibility. Every other static check reasons about the ' +
          '*graph*; this one reasons about the **data**, and it answers the ' +
          'question the others structurally cannot: is the conjunction of the ' +
          'branch conditions along a path satisfiable, and if so, by what?\n\n' +
          'That yields two things. **Dead branches** — a `case "refund"` ' +
          'downstream of a condition that already required `kind == "order"` ' +
          'is wired, typed, reachable in the graph, and can never run — each ' +
          'reported with the decision it contradicts. And a **witness** per ' +
          'live branch: the concrete trigger payload that drives it, separated ' +
          'from the assumptions it rests on, which is what lets ' +
          '`scenarios` be a generated test suite rather than a list of ' +
          'guesses.\n\n' +
          'Every approximation is on the satisfiable side. A comparison outside ' +
          'the solver’s fragment, a field two nodes could have written, or a ' +
          'search that hit its bound all report `unknown` — so the failure mode ' +
          'is a missing finding, never a live branch reported dead. `ok` is ' +
          'false only when a branch is provably unreachable. Requires `read`.',
        operationId: 'getWorkflowPaths',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          200: {
            description: 'Per-branch feasibility, findings, and generated scenarios.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string' },
                    ok: {
                      type: 'boolean',
                      description: 'No branch was found unreachable. The CI gate.',
                    },
                    analysed: {
                      type: 'boolean',
                      description:
                        'False for a graph that admits no execution — a cycle, ' +
                        'or no nodes. Nothing is reported against one.',
                    },
                    truncated: {
                      type: 'boolean',
                      description:
                        'The search hit its bound. A truncated report never ' +
                        'claims a branch is dead: an unexplored path is not a ' +
                        'non-existent one.',
                    },
                    branches: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/PathBranch' },
                    },
                    findings: {
                      type: 'array',
                      description: 'The subset the linter also reports.',
                      items: { $ref: '#/components/schemas/LintIssue' },
                    },
                    scenarios: {
                      type: 'array',
                      description:
                        'A ready-to-save test scenario per branch a payload can ' +
                        'drive: the trigger data, and an assertion that the run ' +
                        'really took the branch it was written for.',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string', example: 'Route → refund' },
                          triggerData: { type: 'object' },
                          assertions: { type: 'array', items: { type: 'object' } },
                          covers: { type: 'object' },
                        },
                      },
                    },
                    coverage: {
                      type: 'object',
                      description:
                        'Branch coverage a generated suite could reach. ' +
                        '`generatable` below `reachable` is not a defect — an ' +
                        'approval’s rejected side is real and untestable in ' +
                        'dry-run mode, and each branch says which it is.',
                      properties: {
                        branches: { type: 'integer' },
                        reachable: { type: 'integer' },
                        generatable: { type: 'integer' },
                      },
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
    '/executions/{executionId}/breaks': {
      get: {
        tags: ['executions'],
        summary: 'Every pause a debug run has taken',
        description:
          'For a run started with `?breakAt=…`, each pause with the ' +
          '**resolved** config and input the node was about to use — templates ' +
          'substituted, secrets redacted, before the runner fired. `status` is ' +
          '`paused` (waiting on a resume), `resumed`, `expired` (nobody ' +
          'resumed it in time, which fails the run) or `cancelled`.\n\n' +
          'Poll, print, resume: that turns a breakpoint into a trace point and ' +
          'answers "why did this run send *that*?" without adding logging ' +
          'nodes to the graph. `flowforge debug` is this loop. Requires `read`.',
        operationId: 'listExecutionBreaks',
        parameters: [{ $ref: '#/components/parameters/ExecutionId' }],
        responses: {
          200: {
            description: 'The run’s pauses, oldest first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    executionId: { type: 'string' },
                    breaks: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ExecutionBreak' },
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
    '/executions/{executionId}/breaks/{breakId}/resume': {
      post: {
        tags: ['executions'],
        summary: 'Let a paused node run',
        description:
          '`action` is `continue` (run to the next breakpoint), `step` (stop ' +
          'again at the very next node), or `abort` (cancel the run from ' +
          'here). An optional `override` of `{ config, input }` is **merged** ' +
          'over what the node was about to use — change the amount and watch ' +
          'the condition below it take the other branch. An overridden input ' +
          'also rewrites the step’s recorded input, so the run’s history says ' +
          'what actually happened.\n\n' +
          'Requires `trigger`, not `read`: resuming decides whether a real ' +
          'call happens and with what, which is the same category of act as ' +
          'starting the run. Two callers racing resolve to one winner; the ' +
          'loser gets a `409` naming the settled state.',
        operationId: 'resumeExecutionBreak',
        parameters: [
          { $ref: '#/components/parameters/ExecutionId' },
          {
            name: 'breakId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    enum: ['continue', 'step', 'abort'],
                    default: 'continue',
                  },
                  override: {
                    type: 'object',
                    description: 'Shallow `{ config, input }` patches merged before the node runs.',
                    properties: {
                      config: { type: 'object', additionalProperties: true },
                      input: { type: 'object', additionalProperties: true },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          202: {
            description: 'Accepted — the node runs on the engine’s next poll.',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
              },
            },
          },
          400: {
            description: 'Unknown action.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: {
            description: 'The break was already resumed, expired, or cancelled.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
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
                    compensations: {
                      type: 'array',
                      description:
                        'Compensating actions run to unwind this run’s side ' +
                        'effects, in unwind order (newest effect first). Empty ' +
                        'unless the run failed and its workflow declares ' +
                        'compensations.',
                      items: { $ref: '#/components/schemas/Compensation' },
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
    '/executions/{executionId}/schedule': {
      get: {
        tags: ['executions'],
        summary: 'Where a run’s time went — work versus waiting for a slot',
        description:
          'The engine runs at most `EXEC_MAX_PARALLEL` nodes at once, so part ' +
          'of a run’s wall time can be nodes sitting *ready* with no free slot. ' +
          'The critical path cannot report that — the node holding the slot is ' +
          'often on an unrelated branch, with no edge to the node it delayed. ' +
          'This measures it from the recorded step timestamps: `observed` ' +
          'splits the run into `workMs` and `queuedMs` and names the blocker ' +
          'for each wait, `idealMakespanMs` is the floor the same work could ' +
          'not have gone below at any capacity, and `atCap` is what the run ' +
          'would have taken at other caps. Requires the `read` scope.',
        operationId: 'getExecutionSchedule',
        parameters: [{ $ref: '#/components/parameters/ExecutionId' }],
        responses: {
          200: {
            description:
              'The schedule analysis, or `available: false` for a run with no ' +
              'recorded steps.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScheduleAnalysis' },
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
    '/executions/{executionId}/rollback': {
      post: {
        tags: ['executions'],
        summary: 'Roll back a failed or cancelled run',
        description:
          'Runs the compensating actions for a settled run, newest side ' +
          'effect first. A failed run unwinds automatically; this exists for ' +
          'the case that could not — the compensating endpoint was itself ' +
          'broken, so the run landed `partial` and someone has since fixed ' +
          'it. Only compensations that have **not already succeeded** are ' +
          'run, so retrying is safe and never double-undoes. Requires the ' +
          '`trigger` scope: this fires real side effects at real systems.',
        operationId: 'rollbackExecution',
        parameters: [{ $ref: '#/components/parameters/ExecutionId' }],
        responses: {
          200: {
            description: 'The rollback ran. `outcome` is `completed` or `partial`.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    executionId: { type: 'string' },
                    outcome: { type: 'string', enum: ['completed', 'partial'] },
                    compensations: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Compensation' },
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
            description:
              'The run is still going or succeeded, or every compensation has ' +
              'already succeeded so there is nothing outstanding.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
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
          'Records a response on a pending approval gate. Requires the ' +
          'dedicated `approve` scope — a token that can trigger runs cannot ' +
          'implicitly wave them through its own gates.\n\n' +
          '**Do not infer the decision from a 2xx.** A gate that declares a ' +
          'quorum may not settle on this response: `200` means it settled ' +
          '(`progress.status` is the verdict, and the run has continued down ' +
          'that branch), `202` means the response was recorded and the gate is ' +
          'still open. A client treating every 2xx as "approved" would ' +
          'otherwise act on a half-met quorum.\n\n' +
          'A single **rejection** settles the gate whatever the quorum, and one ' +
          'person counts once — a second response from the same account is a ' +
          '409 with `reason: "already-responded"`. A 403 carries which rule ' +
          'refused: `viewer`, `role`, or `separation-of-duties`.',
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
            description: 'The gate settled — `progress.status` is the verdict.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    approval: { $ref: '#/components/schemas/Approval' },
                    progress: { $ref: '#/components/schemas/ApprovalProgress' },
                  },
                },
              },
            },
          },
          202: {
            description:
              'Recorded, and the gate is still open — more approvals are needed.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    approval: { $ref: '#/components/schemas/Approval' },
                    progress: { $ref: '#/components/schemas/ApprovalProgress' },
                  },
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
      AuditEntry: {
        type: 'object',
        description:
          'One entry in a workspace’s hash-chained audit log. `seq` is a ' +
          'contiguous per-workspace counter (a gap means an entry was removed) ' +
          'and `hash` covers the entry’s fields plus `prevHash`, so any edit ' +
          'invalidates every entry after it.',
        properties: {
          id: { type: 'string' },
          seq: { type: 'integer' },
          action: {
            type: 'string',
            example: 'secret.updated',
            description: 'The governed operation, from a fixed allow-list.',
          },
          actor: {
            type: 'string',
            nullable: true,
            description:
              'The actor’s display name at the time of the action, or "system" ' +
              'when the platform acted with no user behind it.',
          },
          targetType: { type: 'string', nullable: true },
          targetId: { type: 'string', nullable: true },
          targetName: { type: 'string', nullable: true },
          metadata: { type: 'object', nullable: true, additionalProperties: true },
          createdAt: { type: 'string', format: 'date-time' },
          prevHash: { type: 'string', description: 'The previous entry’s hash (SHA-256, hex).' },
          hash: { type: 'string', description: 'This entry’s hash (SHA-256, hex).' },
        },
      },
      Workflow: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['draft', 'deployed', 'archived'] },
          workspace_id: { type: 'string' },
          updated_at: { type: 'string', format: 'date-time' },
          paused_at: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'When the workflow was paused, or null if it is active.',
          },
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
          rollbackStatus: {
            type: 'string',
            enum: ['completed', 'partial'],
            nullable: true,
            description:
              'Whether this run’s side effects were unwound by compensating ' +
              'actions. `null` on every run that was never rolled back. ' +
              '`partial` means at least one compensation failed after its ' +
              'retries — the inconsistency is known and enumerated in ' +
              '`compensations`, and a rollback can be retried for just those.',
          },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          finishedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Compensation: {
        type: 'object',
        description:
          'One compensating action executed during a rollback. Compensations ' +
          'are not steps — they run after the run reached a terminal state, ' +
          'follow no edges, and are ordered by when their target *completed* ' +
          'rather than by the graph’s topology.',
        properties: {
          node_id: {
            type: 'string',
            description: 'The compensating node that ran.',
          },
          target_node_id: {
            type: 'string',
            description: 'The node whose effect it undid.',
          },
          node_type: { type: 'string', nullable: true, example: 'action-http' },
          seq: {
            type: 'integer',
            description: 'Position in the unwind order — 0 is the last thing the run did.',
          },
          status: { type: 'string', enum: ['succeeded', 'failed'] },
          attempts: { type: 'integer', description: 'How many tries it took.' },
          error: { type: 'string', nullable: true },
          started_at: { type: 'string', format: 'date-time', nullable: true },
          finished_at: { type: 'string', format: 'date-time', nullable: true },
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
          respondedBy: {
            type: 'string',
            nullable: true,
            description:
              'Whoever settled it. Under a quorum this is the *last* approver — ' +
              'the full list of votes lives on the run detail.',
          },
          note: { type: 'string', nullable: true },
          // Present only when the gate declares something beyond the default,
          // so an ordinary approval's payload is what it always was.
          quorum: {
            type: 'integer',
            description: 'Distinct approvals required. Absent when the gate needs only one.',
          },
          requiredRole: {
            type: 'string',
            enum: ['owner'],
            description: 'Present when only workspace owners may settle this gate.',
          },
          separationOfDuties: {
            type: 'boolean',
            description: 'Present when whoever triggered the run may not approve it.',
          },
        },
      },
      ApprovalProgress: {
        type: 'object',
        description:
          'Where the gate stands after this response. Read `settled` rather than ' +
          'inferring the decision from the status code.',
        properties: {
          settled: { type: 'boolean' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          approvals: { type: 'integer', description: 'Distinct approvals gathered so far.' },
          needed: { type: 'integer', description: 'The gate’s quorum.' },
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
          concurrency: {
            type: 'object',
            nullable: true,
            description:
              'What the engine’s parallelism cap does to the estimate above, ' +
              'which assumes a slot is always free.',
            properties: {
              cap: { type: 'integer', description: 'Slots modelled (EXEC_MAX_PARALLEL, or ?cap).' },
              makespanMs: { type: 'integer', nullable: true, description: 'Simulated duration under the cap.' },
              makespanP95Ms: { type: 'integer', nullable: true },
              queuedMs: { type: 'integer', nullable: true, description: 'Of that, time spent waiting for a slot.' },
              contention: {
                type: 'number',
                nullable: true,
                description: 'makespanMs ÷ critical path. 1.0 means the cap costs nothing.',
              },
              averageParallelism: {
                type: 'number',
                nullable: true,
                description:
                  'Total work ÷ critical path — the ceiling on any speedup. 1.2 ' +
                  'means the workflow is mostly a chain and capacity will not help it.',
              },
              knee: {
                type: 'object',
                nullable: true,
                description: 'The smallest cap within 5% of the unbounded floor.',
                properties: {
                  cap: { type: 'integer' },
                  makespanMs: { type: 'integer' },
                  idealMakespanMs: { type: 'integer' },
                },
              },
              curve: {
                type: 'array',
                description: 'Makespan at each cap, the shape behind the knee.',
                items: {
                  type: 'object',
                  properties: { cap: { type: 'integer' }, makespanMs: { type: 'integer' } },
                },
              },
              chain: {
                type: 'array',
                description:
                  'The makespan-determining back-chain, source → sink, each link ' +
                  'labelled with what the node was waiting for.',
                items: { $ref: '#/components/schemas/ScheduleChainLink' },
              },
            },
          },
        },
      },
      ScheduleChainLink: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          waitedFor: {
            type: 'string',
            nullable: true,
            enum: ['data', 'slot', null],
            description:
              '`data` — a predecessor had not finished. `slot` — it had, and the ' +
              'node waited for capacity. Null for the node that started the run.',
          },
          blockedBy: { type: 'string', nullable: true, description: 'The node it waited on.' },
          queuedMs: { type: 'integer' },
          durationMs: { type: 'integer' },
        },
      },
      ScheduleAnalysis: {
        type: 'object',
        properties: {
          executionId: { type: 'string' },
          available: { type: 'boolean', description: 'False for a run with no recorded steps.' },
          cap: { type: 'integer', description: 'The parallelism cap in force.' },
          observed: {
            type: 'object',
            description: 'Measured from the run’s own step timestamps.',
            properties: {
              makespanMs: { type: 'integer', description: 'First step starting to last finishing.' },
              workMs: { type: 'integer', description: 'Time execution slots were occupied.' },
              queuedMs: {
                type: 'integer',
                description: 'Time nodes sat ready with no free slot. Not in the graph anywhere.',
              },
              utilisation: {
                type: 'number',
                nullable: true,
                description: 'workMs ÷ (makespanMs × cap).',
              },
              chain: {
                type: 'array',
                items: { $ref: '#/components/schemas/ScheduleChainLink' },
              },
            },
          },
          idealMakespanMs: {
            type: 'integer',
            nullable: true,
            description: 'The same work with unlimited capacity — the floor the cap kept it from.',
          },
          atCap: {
            type: 'array',
            description: 'What this run would have taken at other caps.',
            items: {
              type: 'object',
              properties: { cap: { type: 'integer' }, makespanMs: { type: 'integer' } },
            },
          },
        },
      },
      DataDriftFinding: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          nodeLabel: { type: 'string', description: 'The node’s label on the canvas.' },
          path: { type: 'string', description: 'Dotted path within the output, e.g. `orders[].amount`.' },
          kind: {
            type: 'string',
            enum: ['field-missing', 'field-added', 'presence', 'null-rate', 'type-changed', 'distribution', 'categories'],
          },
          severity: { type: 'string', enum: ['major', 'minor'] },
          summary: { type: 'string', description: 'One sentence naming the change and both sides of it.' },
          detail: {
            type: 'object',
            description: 'The evidence — rates, p-value, KS statistic or PSI, and which test produced it.',
            additionalProperties: true,
          },
        },
      },
      DataDriftReport: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          available: { type: 'boolean' },
          reason: {
            type: 'string',
            enum: ['not-found', 'insufficient-history'],
            nullable: true,
          },
          monitoring: { type: 'boolean', description: 'Whether this workflow opted into drift *alerting*.' },
          window: {
            type: 'object',
            properties: {
              recent: {
                type: 'object',
                properties: {
                  runs: { type: 'integer' },
                  from: { type: 'string', nullable: true },
                  to: { type: 'string', nullable: true },
                },
              },
              baseline: {
                type: 'object',
                properties: {
                  runs: { type: 'integer' },
                  from: { type: 'string', nullable: true },
                  to: { type: 'string', nullable: true },
                },
              },
            },
          },
          summary: {
            type: 'object',
            properties: {
              major: { type: 'integer' },
              minor: { type: 'integer' },
              nodesCompared: { type: 'integer' },
              nodesSkipped: { type: 'integer' },
              fieldsCompared: { type: 'integer' },
              fieldsSkipped: {
                type: 'integer',
                description:
                  'Fields that could not be compared — too few samples, an ' +
                  'identifier rather than a category, or redacted. Reported ' +
                  'rather than omitted, because a report that hides its skips ' +
                  'is claiming coverage it does not have.',
              },
            },
          },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string' },
                nodeLabel: { type: 'string' },
                nodeType: { type: 'string', nullable: true },
                compared: { type: 'integer' },
                findings: { type: 'array', items: { $ref: '#/components/schemas/DataDriftFinding' } },
              },
            },
          },
        },
      },
      CapacityPrediction: {
        type: 'object',
        description: 'What the model says at one cap.',
        properties: {
          servers: { type: 'integer' },
          stable: {
            type: 'boolean',
            description: 'False past saturation, where the backlog grows without bound.',
          },
          utilisation: { type: 'number', description: 'Offered load ÷ servers (ρ).' },
          headroom: {
            type: 'number',
            description:
              'The multiple of today’s arrival rate at which this cap saturates. ' +
              'Below 1 the queue is already diverging.',
          },
          waitMeanMs: { type: 'number', nullable: true },
          waitP95Ms: {
            type: 'number',
            nullable: true,
            description:
              'Approximate: M/M/c has an exact wait tail and G/G/c does not, so the ' +
              'exponential shape is kept and stretched to the corrected mean.',
          },
        },
      },
      CapacityReport: {
        type: 'object',
        properties: {
          available: { type: 'boolean' },
          reason: {
            type: 'string',
            nullable: true,
            enum: ['not-found', 'no-cap', 'not-enough-runs', 'no-service-time'],
          },
          workflowId: { type: 'string' },
          name: { type: 'string' },
          cap: { type: 'integer', description: 'The cap the report was computed for.' },
          measured: {
            type: 'object',
            description: 'What history says, before any model touches it.',
            properties: {
              runs: { type: 'integer' },
              windowDays: { type: 'integer' },
              arrivalsPerHour: { type: 'number' },
              serviceMeanMs: { type: 'number', nullable: true },
              serviceP50Ms: { type: 'number', nullable: true },
              serviceP95Ms: { type: 'number', nullable: true },
              cvSquaredService: {
                type: 'number',
                nullable: true,
                description:
                  'Var(S)/E[S]². 1 is exponential; higher is what makes M/M/c wrong ' +
                  'here. Null rather than a default, so a missing measurement never ' +
                  'becomes the assumption it is meant to test.',
              },
              cvSquaredArrival: { type: 'number', nullable: true },
              observedWaitMeanMs: { type: 'number', nullable: true },
              observedWaitP50Ms: { type: 'number', nullable: true },
              observedWaitP95Ms: { type: 'number', nullable: true },
              sampled: {
                type: 'object',
                properties: { service: { type: 'integer' }, wait: { type: 'integer' } },
              },
            },
          },
          current: { $ref: '#/components/schemas/CapacityPrediction' },
          calibration: {
            type: 'object',
            description: 'The model checked against the window it was measured from.',
            properties: {
              comparable: { type: 'boolean' },
              ratio: {
                type: 'number',
                nullable: true,
                description: 'Predicted ÷ observed mean wait.',
              },
              verdict: {
                type: 'string',
                enum: [
                  'agrees',
                  'over-predicts',
                  'under-predicts',
                  'no-queue-to-check',
                  'not-enough-history',
                ],
              },
              observedMs: { type: 'number', nullable: true },
              predictedMs: { type: 'number', nullable: true },
            },
          },
          curve: {
            type: 'array',
            description: 'The same prediction across caps around the current one.',
            items: { $ref: '#/components/schemas/CapacityPrediction' },
          },
          recommendation: {
            type: 'object',
            nullable: true,
            description: 'Present only when `target` was given.',
            properties: {
              targetWaitMs: { type: 'integer' },
              servers: {
                type: 'integer',
                nullable: true,
                description: 'Null when no cap can meet the target.',
              },
              change: { type: 'integer', nullable: true },
              confident: {
                type: 'boolean',
                description:
                  'False when the model does not describe the measured window. Same ' +
                  'number, weaker claim.',
              },
            },
          },
          model: {
            type: 'object',
            properties: {
              name: { type: 'string', example: 'Allen–Cunneen G/G/c' },
              variabilityFactor: { type: 'number', description: '(CV²ₐ + CV²ₛ)/2.' },
              mmcWaitMeanMs: {
                type: 'number',
                nullable: true,
                description: 'What M/M/c would have said, for comparison.',
              },
            },
          },
        },
      },
      ContractReport: {
        type: 'object',
        properties: {
          available: { type: 'boolean' },
          reason: { type: 'string', nullable: true, enum: ['not-found', 'unreadable'] },
          workflowId: { type: 'string' },
          name: { type: 'string' },
          before: {
            type: 'object',
            description: 'The promise the deployed graph makes today.',
            properties: {
              describe: { type: 'string', example: '{ orderId: string, total: number }' },
              fields: { type: 'array', items: { type: 'string' } },
            },
          },
          after: {
            type: 'object',
            description: 'The promise the candidate would make. Identical to `before` on a GET.',
            properties: {
              describe: { type: 'string' },
              fields: { type: 'array', items: { type: 'string' } },
            },
          },
          change: {
            type: 'object',
            properties: {
              verdict: {
                type: 'string',
                enum: ['breaking', 'additive', 'compatible'],
                description: 'Semantic versioning for the shape: major, minor, patch.',
              },
              removed: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { path: { type: 'string' }, was: { type: 'string' } },
                },
              },
              widened: {
                type: 'array',
                description:
                  'Types that grew past what callers were written against — breaking, ' +
                  'because a return value is consumed rather than supplied.',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    was: { type: 'string' },
                    now: { type: 'string' },
                  },
                },
              },
              weakened: {
                type: 'array',
                description: 'Required fields that became optional.',
                items: { type: 'object', properties: { path: { type: 'string' } } },
              },
              added: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { path: { type: 'string' }, now: { type: 'string' } },
                },
              },
            },
          },
          callers: {
            type: 'array',
            description:
              'Workflows in the same workspace that call this one. A `for-each` caller is ' +
              'listed with no breaks: its output wraps the contract in an array, which a ' +
              'template path cannot index, so no specific reference can be named.',
            items: {
              type: 'object',
              properties: {
                workflowId: { type: 'string' },
                name: { type: 'string' },
                status: { type: 'string' },
                breaks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      nodeId: { type: 'string' },
                      label: { type: 'string' },
                      reference: { type: 'string', example: 'call.orderId' },
                      path: { type: 'string' },
                      missing: { type: 'string' },
                      reason: { type: 'string', enum: ['removed'] },
                      suggestion: {
                        type: 'string',
                        nullable: true,
                        description: 'The field they probably meant, if one is close enough.',
                      },
                    },
                  },
                },
              },
            },
          },
          summary: {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['breaking', 'additive', 'compatible'] },
              callers: { type: 'integer' },
              broken: {
                type: 'integer',
                description: 'Callers with a reference that stops resolving. Gate on this.',
              },
              references: { type: 'integer' },
            },
          },
        },
      },
      ConvergenceReport: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          available: { type: 'boolean' },
          reason: { type: 'string', enum: ['empty', 'cycle'], nullable: true },
          joins: {
            type: 'array',
            description: 'Nodes where two or more branches supply the same field.',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string', description: 'The node type.' },
                arity: { type: 'integer', description: 'How many edges arrive here.' },
                mergeOrder: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'The contributing node ids in the order the engine assigns them. ' +
                    'Last wins.',
                },
                collisions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string', description: 'The field two branches both supply.' },
                      resolution: {
                        type: 'string',
                        enum: ['dataflow', 'tie-break'],
                        description:
                          '`dataflow` — the contributors sit at different depths, so the ' +
                          'deeper one wins predictably. `tie-break` — they are concurrent, ' +
                          'the graph does not decide, and the canonical edge sort does.',
                      },
                      decidedBy: {
                        type: 'string',
                        nullable: true,
                        description:
                          'The contributor whose value survives. Null when that itself ' +
                          'depends on which branch ran.',
                      },
                      sameType: {
                        type: 'boolean',
                        description:
                          'False when the contributors are differently shaped, which can ' +
                          'change what a downstream expression is allowed to do.',
                      },
                      contributors: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            nodeId: { type: 'string' },
                            label: { type: 'string' },
                            handle: { type: 'string', nullable: true },
                            depth: {
                              type: 'integer',
                              description: 'Longest-path depth — the merge rank.',
                            },
                            type: { type: 'string', description: 'The inferred field type.' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          summary: {
            type: 'object',
            properties: {
              joins: { type: 'integer' },
              collisions: { type: 'integer' },
              tieBroken: {
                type: 'integer',
                description: 'The ones nobody can resolve by reading the canvas. Gate on this.',
              },
              dataflow: { type: 'integer', description: 'The ones the graph settles.' },
              typeChanging: { type: 'integer' },
            },
          },
        },
      },
      EffectReport: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          available: { type: 'boolean' },
          reason: { type: 'string', enum: ['empty', 'cycle'], nullable: true },
          effects: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string', description: 'The node type.' },
                kind: {
                  type: 'string',
                  enum: ['http', 'email', 'slack', 'sub-workflow', 'model'],
                },
                target: {
                  type: 'string',
                  nullable: true,
                  description:
                    'The host, address, workflow or model it reaches. Null when the ' +
                    'graph does not determine it — a templated *authority* rather ' +
                    'than a templated path.',
                },
                always: {
                  type: 'boolean',
                  description: 'True when no decision gates it: it happens on every run that gets there.',
                },
                conditions: {
                  type: 'array',
                  description: 'Every decision that must go a particular way for this effect to run.',
                  items: {
                    type: 'object',
                    properties: {
                      nodeId: { type: 'string' },
                      label: { type: 'string' },
                      type: { type: 'string', nullable: true },
                      outcome: { type: 'string', description: 'e.g. `true`, `valid`, `refund`, `error`.' },
                    },
                  },
                },
              },
            },
          },
          decisions: {
            type: 'array',
            description: 'The same analysis backwards: which effects each outcome gates.',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string', nullable: true },
                outcomes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      gates: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          summary: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              unconditional: { type: 'integer' },
              gated: { type: 'integer' },
              dynamicTargets: { type: 'integer' },
            },
          },
        },
      },
      Dependencies: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          dependsOn: {
            type: 'array',
            description: 'Workflows this one references.',
            items: { $ref: '#/components/schemas/DependencyEdge' },
          },
          dependedOnBy: {
            type: 'array',
            description: 'Workflows that reference this one.',
            items: { $ref: '#/components/schemas/DependencyEdge' },
          },
          cycle: {
            type: 'array',
            nullable: true,
            items: { type: 'string' },
            description:
              'A stale cross-workflow reference cycle this workflow sits on ' +
              '(workflow ids, start → … → start), or null if none.',
          },
        },
      },
      DependencyEdge: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'deployed', 'archived'] },
          via: {
            type: 'array',
            description: 'How the reference is made.',
            items: { type: 'string', enum: ['sub-workflow', 'for-each', 'error-handler'] },
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
      LintReport: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          ok: {
            type: 'boolean',
            description: 'True when the graph has no error-severity issues — the CI gate.',
          },
          issues: {
            type: 'array',
            description: 'Errors first, then warnings.',
            items: { $ref: '#/components/schemas/LintIssue' },
          },
          summary: {
            type: 'object',
            properties: {
              errors: { type: 'integer' },
              warnings: { type: 'integer' },
            },
          },
        },
      },
      LintIssue: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['error', 'warning'] },
          code: { type: 'string', example: 'unknown-secret' },
          message: { type: 'string' },
          nodeId: {
            type: 'string',
            nullable: true,
            description: 'Null for graph-level problems (cycles, dangling edges).',
          },
        },
      },
      MergeConflict: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['field', 'modify-delete', 'delete-modify'],
            description:
              '`field` — both sides changed the same config field to different ' +
              'values. `modify-delete` — the document deleted a node the live ' +
              'workflow edited. `delete-modify` — the reverse.',
          },
          nodeId: { type: 'string' },
          label: { type: 'string' },
          field: {
            type: 'string',
            nullable: true,
            example: 'config.url',
            description: 'Dotted path; null for whole-node conflicts.',
          },
          base: { description: 'The common ancestor’s value.' },
          ours: { description: 'The live workflow’s value.' },
          theirs: { description: 'The document’s value.' },
          detail: { type: 'string' },
          description: { type: 'string', description: 'One-line human-readable rendering.' },
        },
      },
      LineageNode: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          label: { type: 'string' },
          nodeType: { type: 'string' },
          origins: {
            type: 'array',
            description:
              'Where this node’s *output* data can have come from. A node whose ' +
              'output is written by something outside the graph — an HTTP ' +
              'response, a model, a callback payload — carries that one origin ' +
              'and not the origins of anything it read, because the far side ' +
              'wrote the value.',
            items: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: [
                    'webhook', 'callback', 'response', 'model',
                    'manual', 'schedule', 'secret', 'variable', 'config', 'unknown',
                  ],
                },
                trust: { type: 'string', enum: ['untrusted', 'external', 'internal', 'unknown'] },
                label: { type: 'string', example: 'the webhook payload' },
              },
            },
          },
          reads: {
            type: 'array',
            description: 'The `{{node.path}}` references this node’s config makes.',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string' },
                reference: { type: 'string', example: 'http-1.body.email' },
                where: { type: 'string', description: 'The config key carrying it.', example: 'url' },
              },
            },
          },
          readBy: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nodes that reference this node’s output.',
          },
          secrets: { type: 'array', items: { type: 'string' } },
          variables: { type: 'array', items: { type: 'string' } },
        },
      },
      LineageSink: {
        type: 'object',
        description: 'A config field where data leaves FlowForge.',
        properties: {
          nodeId: { type: 'string' },
          label: { type: 'string' },
          key: { type: 'string', example: 'url' },
          kind: {
            type: 'string',
            enum: [
              'http-url', 'http-headers', 'http-body',
              'email-recipient', 'email-body', 'email-subject',
              'slack-webhook', 'slack-message', 'workflow-target', 'log',
            ],
          },
          sensitivity: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description:
              'What an attacker gains by controlling it, not how secret the data ' +
              'is. An HTTP URL whose *authority* is pinned by the author drops to ' +
              '`medium`: the destination cannot be redirected, only the path or ' +
              'query varies.',
          },
          what: { type: 'string', example: 'the address this request is sent to' },
          via: { type: 'array', items: { type: 'string' } },
          origins: { type: 'array', items: { type: 'string' } },
        },
      },
      ExecutionBreak: {
        type: 'object',
        description:
          'One pause in a debug run — taken *after* the node’s config was ' +
          'resolved and *before* its runner was called, the only moment where ' +
          'both what it received and what it is about to do exist at once.',
        properties: {
          id: { type: 'string' },
          nodeId: { type: 'string' },
          nodeLabel: { type: 'string' },
          status: {
            type: 'string',
            enum: ['paused', 'resumed', 'expired', 'cancelled'],
            description:
              '`expired` means nobody resumed it within the timeout, which ' +
              'fails the run rather than letting the node go with nobody ' +
              'watching.',
          },
          action: { type: 'string', enum: ['continue', 'step', 'abort'], nullable: true },
          input: {
            type: 'object',
            nullable: true,
            additionalProperties: true,
            description: 'The merged upstream output the node received.',
          },
          config: {
            type: 'object',
            nullable: true,
            additionalProperties: true,
            description:
              'The node’s config with every `{{…}}` already resolved and every ' +
              'secret redacted — the value that exists nowhere else.',
          },
          override: {
            type: 'object',
            nullable: true,
            additionalProperties: true,
            description: 'The patch a caller applied before letting it run.',
          },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          resolvedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Guarantee: {
        type: 'object',
        description:
          'A path invariant declared about this graph. Each reads left to ' +
          'right: `requires` — <node> never runs unless <other> ran first; ' +
          '`ensures` — if <node> runs, <other> runs too; `exclusive` — <node> ' +
          'and <other> never both run.',
        properties: {
          kind: { type: 'string', enum: ['requires', 'ensures', 'exclusive'] },
          node: { type: 'string', description: 'The node the statement is about.' },
          other: { type: 'string', description: 'The node it is related to.' },
          note: { type: 'string', description: 'Why it matters, in the author’s words.' },
          statement: {
            type: 'string',
            example: 'Charge card never runs unless Approve ran first',
          },
        },
      },
      RegressionChangePoint: {
        type: 'object',
        description: 'One detected step in the workflow’s duration, with its cause.',
        properties: {
          at: {
            type: 'string',
            format: 'date-time',
            description: 'The first run that behaved differently.',
          },
          previousAt: {
            type: 'string',
            format: 'date-time',
            description:
              'The last run that behaved as before. Together with `at` this is ' +
              'the window a deploy has to fall inside to be a suspect.',
          },
          direction: { type: 'string', enum: ['worse', 'better'] },
          pValue: { type: 'number' },
          before: {
            type: 'object',
            properties: { median: { type: 'number' }, runs: { type: 'integer' } },
          },
          after: {
            type: 'object',
            properties: { median: { type: 'number' }, runs: { type: 'integer' } },
          },
          delta: { type: 'number', description: 'Median shift in milliseconds.' },
          ratio: {
            type: 'number',
            nullable: true,
            description: 'Null rather than infinite when the earlier median was zero.',
          },
          cause: {
            type: 'string',
            enum: ['deploy', 'ambiguous', 'external'],
            description:
              '`external` means nothing was deployed in the window — a finding ' +
              'in its own right, and the one that stops somebody re-reading ' +
              'their own diff.',
          },
          deploys: {
            type: 'array',
            description:
              'Versions that landed in the window. A single suspect carries its ' +
              'semantic diff; with several, the list is the answer.',
            items: { type: 'object' },
          },
          steps: {
            type: 'array',
            description:
              'Steps whose own timing moved at the same moment, largest ' +
              'absolute shift first — so the finding names a node on the canvas.',
            items: { type: 'object' },
          },
        },
      },
      PathBranch: {
        type: 'object',
        description:
          'One outcome of one decision — a condition’s `true`, a switch case, ' +
          'a schema gate’s `invalid`, a node’s caught-failure branch.',
        properties: {
          nodeId: { type: 'string' },
          label: { type: 'string', example: 'Route' },
          nodeType: { type: 'string', example: 'switch' },
          outcome: { type: 'string', example: 'refund' },
          wired: {
            type: 'integer',
            description:
              'How many edges leave this outcome. Zero means the run simply ' +
              'ends here, which is a linter concern rather than a dead branch.',
          },
          status: {
            type: 'string',
            enum: ['reachable', 'unreachable', 'unknown'],
            description:
              '`unknown` is never a defect: it means the fragment could not ' +
              'decide, which is the safe direction.',
          },
          witness: {
            type: 'object',
            nullable: true,
            description:
              'How to get here. `triggerData` is the payload; `assumptions` are ' +
              'the values it could *not* set — an upstream response, a gate’s ' +
              'verdict — kept separate so a generated test never rests on one ' +
              'silently.',
            properties: {
              triggerData: { type: 'object' },
              assumptions: { type: 'array', items: { type: 'object' } },
            },
          },
          generatable: {
            type: 'boolean',
            description: 'A dry-run payload can drive this branch on its own.',
          },
          blockers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Why not, in words — “test mode always takes the other side of ' +
              'Approve”, “depends on Fetch.status”.',
          },
          conflict: {
            type: 'array',
            nullable: true,
            items: { type: 'string' },
            description:
              'For an unreachable branch: the decisions it contradicts, from a ' +
              'minimal unsatisfiable subset. The finding nobody has to ' +
              'investigate.',
          },
        },
      },
      GuaranteeResult: {
        allOf: [
          { $ref: '#/components/schemas/Guarantee' },
          {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['holds', 'violated', 'unknown'],
                description:
                  '`unknown` is never a pass: it means the declaration could ' +
                  'not be checked — a node it names was deleted, or the graph ' +
                  'has a cycle and admits no execution at all.',
              },
              message: {
                type: 'string',
                description: 'Why it failed, naming the specific nodes.',
                example: 'Run by hand → Charge card reaches Charge card without Approve',
              },
              counterexample: {
                type: 'array',
                nullable: true,
                items: { type: 'string' },
                description:
                  'The path that breaks the invariant, as node ids. The finding ' +
                  'nobody has to investigate: this is the route around the gate.',
              },
              evidence: {
                type: 'string',
                description: 'For a holding `exclusive`: which decision separates them.',
              },
            },
          },
        ],
      },
      CanaryReport: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          active: { type: 'boolean' },
          state: { type: 'string', enum: ['running', 'rolled_back'], nullable: true },
          percent: { type: 'integer', description: 'Share of runs going to the canary.' },
          auto: { type: 'boolean', description: 'Whether the sweep may act on the verdict.' },
          verdict: {
            type: 'string',
            enum: ['healthy', 'degraded', 'failing', 'pending'],
          },
          recommendation: { type: 'string', enum: ['promote', 'rollback', 'wait'] },
          reason: { type: 'string' },
          canary: { $ref: '#/components/schemas/CanaryArm' },
          stable: { $ref: '#/components/schemas/CanaryArm' },
          successTest: {
            type: 'object',
            nullable: true,
            description: 'One-sided two-proportion z-test on failure rates.',
            properties: {
              z: { type: 'number' },
              pValue: { type: 'number' },
              significant: { type: 'boolean' },
            },
          },
          durationTest: {
            type: 'object',
            nullable: true,
            description: 'Tie-corrected Mann-Whitney U on completed-run durations.',
            properties: {
              z: { type: 'number' },
              pValue: { type: 'number' },
              significant: { type: 'boolean' },
              effect: {
                type: 'number',
                description: 'P(a random canary run is slower than a random stable one). 0.5 = no difference.',
              },
            },
          },
        },
      },
      CanaryArm: {
        type: 'object',
        properties: {
          runs: { type: 'integer' },
          failures: { type: 'integer' },
          failureRate: { type: 'number', nullable: true },
          failureRateInterval: {
            type: 'object',
            nullable: true,
            description: '95% Wilson score interval — never zero-width, even at 0 failures.',
            properties: {
              point: { type: 'number' },
              lower: { type: 'number' },
              upper: { type: 'number' },
            },
          },
          durations: {
            type: 'array',
            description: 'Completed-run durations in milliseconds.',
            items: { type: 'integer' },
          },
        },
      },
      TypeReport: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          order: {
            type: 'array',
            description: 'Node ids in topological order. Empty when the graph has a cycle.',
            items: { type: 'string' },
          },
          nodes: {
            type: 'object',
            description:
              'Keyed by node id. `described` is the human rendering (e.g. ' +
              '`{ status: number, body: any }`); `type` is the machine-readable ' +
              'lattice value; `fields` flattens the pickable `{{node.path}}` ' +
              'references the output offers.',
            additionalProperties: {
              type: 'object',
              properties: {
                input: {
                  type: 'object',
                  properties: {
                    type: { type: 'object' },
                    described: { type: 'string' },
                  },
                },
                output: {
                  type: 'object',
                  properties: {
                    type: { type: 'object' },
                    described: { type: 'string' },
                    fields: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          path: { type: 'string', example: 'body.total' },
                          type: { type: 'string', example: 'number' },
                          optional: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          diagnostics: {
            type: 'array',
            description:
              'Type findings, the same ones the lint report carries as ' +
              '`unknown-field` and `type-error`.',
            items: {
              type: 'object',
              properties: {
                severity: { type: 'string', enum: ['error', 'warning'] },
                code: { type: 'string', example: 'unknown-field' },
                message: { type: 'string' },
                nodeId: { type: 'string' },
              },
            },
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
