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
    { name: 'workflows', description: 'Discover and trigger workflows' },
    { name: 'executions', description: 'Inspect and control runs' },
    { name: 'approvals', description: 'Human-in-the-loop approval gates' },
  ],
  paths: {
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
            description: 'The Idempotency-Key was already used with a different request body.',
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
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          finishedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      ExecutionStatus: {
        type: 'string',
        enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
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
            enum: ['pending', 'running', 'succeeded', 'failed', 'skipped', 'reused'],
            description:
              '`reused` appears in resumed runs: the step was not re-executed — ' +
              'its output was adopted from the run being resumed.',
          },
          input_json: { type: 'string', nullable: true },
          output_json: { type: 'string', nullable: true },
          error: { type: 'string', nullable: true },
          started_at: { type: 'string', format: 'date-time', nullable: true },
          finished_at: { type: 'string', format: 'date-time', nullable: true },
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
