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
      'completion, or cancel it. Tokens are created in the app under ' +
      'Settings → API tokens and carry scopes (`trigger`, `read`).',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'workflows', description: 'Discover and trigger workflows' },
    { name: 'executions', description: 'Inspect and control runs' },
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
          '`trigger` scope.',
        operationId: 'triggerWorkflow',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
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
            description: 'The workflow has no nodes to execute.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
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
      ExecutionStep: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          node_id: { type: 'string' },
          node_type: { type: 'string', nullable: true, example: 'action-http' },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'succeeded', 'failed', 'skipped'],
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
