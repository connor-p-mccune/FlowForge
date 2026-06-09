# client/

React frontend for FlowForge. Vite dev server on port 5173.

---

## Commands

```bash
# Install deps (inside container or locally with Node 20+)
npm install

# Dev server
npm run dev

# Build for production
npm run build

# Lint
npm run lint
```

---

## Folder structure

```
src/
├── main.jsx                  # Entry point, mounts App
├── App.jsx                   # Router setup (React Router v6)
├── components/
│   ├── auth/
│   │   ├── LoginPage.jsx
│   │   └── RegisterPage.jsx
│   ├── canvas/
│   │   ├── WorkflowCanvas.jsx     # Main React Flow instance
│   │   ├── CanvasToolbar.jsx      # Add-node buttons, Run button
│   │   ├── NodeConfigPanel.jsx    # Side panel for selected node config
│   │   └── nodes/                 # One file per custom node type
│   │       ├── TriggerNode.jsx
│   │       ├── ActionNode.jsx
│   │       ├── ConditionNode.jsx
│   │       ├── AINode.jsx
│   │       └── OutputNode.jsx
│   ├── collaboration/
│   │   ├── CursorOverlay.jsx      # Renders remote cursors on canvas
│   │   └── PresenceBar.jsx        # Shows who is currently editing
│   ├── execution/
│   │   ├── ExecutionPanel.jsx     # Slides up during/after a run
│   │   └── ExecutionHistory.jsx   # List of past runs
│   └── layout/
│       ├── Sidebar.jsx            # Workspace/workflow nav
│       └── Header.jsx
├── hooks/
│   ├── useAuth.js                 # JWT storage, current user, login/logout
│   ├── useWorkflow.js             # Load/save workflow, manage graph state
│   └── useSocket.js               # Socket.io connection, event handlers
├── services/
│   ├── api.js                     # fetch wrapper — ALL HTTP calls go through here
│   └── socket.js                  # Socket.io singleton — import this everywhere
└── styles/
    └── global.css
```

---

## API calls — always use `services/api.js`

Never use raw `fetch` in components. Always import from `services/api.js`.

```javascript
// services/api.js
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token')
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}

// Usage in a component or hook:
const { workflow } = await apiFetch(`/api/workflows/${id}`)
const { workflow } = await apiFetch(`/api/workflows/${id}/graph`, {
  method: 'PUT',
  body: { nodes, edges },
})
```

---

## Socket.io — always use `services/socket.js`

Never create a new `io()` connection in a component. Use the singleton.

```javascript
// services/socket.js
import { io } from 'socket.io-client'

const socket = io(import.meta.env.VITE_API_URL || 'http://localhost:3001', {
  autoConnect: false,
})

export default socket
```

```javascript
// In useSocket.js hook — connect after login, disconnect on logout
import socket from '../services/socket'

export function useSocket(workflowId) {
  useEffect(() => {
    socket.auth = { token: localStorage.getItem('token') }
    socket.connect()
    socket.emit('join-workflow', { workflowId })

    socket.on('remote-node', handleRemoteNode)
    socket.on('remote-cursor', handleRemoteCursor)
    socket.on('exec-update', handleExecUpdate)

    return () => {
      socket.emit('leave-workflow', { workflowId })
      socket.off('remote-node', handleRemoteNode)
      socket.off('remote-cursor', handleRemoteCursor)
      socket.off('exec-update', handleExecUpdate)
      socket.disconnect()
    }
  }, [workflowId])
}
```

---

## React Flow patterns

Use `useNodesState` and `useEdgesState` for graph state. Save to backend with a debounce.

```javascript
// WorkflowCanvas.jsx skeleton
import ReactFlow, { useNodesState, useEdgesState, addEdge } from 'reactflow'
import 'reactflow/dist/style.css'
import TriggerNode from './nodes/TriggerNode'
import ActionNode from './nodes/ActionNode'

const nodeTypes = {
  'trigger-manual': TriggerNode,
  'trigger-webhook': TriggerNode,
  'action-http': ActionNode,
  'action-delay': ActionNode,
  'condition': ConditionNode,
  'ai-prompt': AINode,
  'output-log': OutputNode,
}

export default function WorkflowCanvas({ workflowId }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  // Save on change (debounced — see useWorkflow hook)
  const { saveGraph } = useWorkflow(workflowId, setNodes, setEdges)

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      nodeTypes={nodeTypes}
      fitView
    />
  )
}
```

---

## Adding a new node type (step by step)

1. Create `src/components/canvas/nodes/MyNode.jsx` — use an existing node as a template
2. Add it to the `nodeTypes` object in `WorkflowCanvas.jsx`
3. Add a config form for it in `NodeConfigPanel.jsx` (switch on `selectedNode.type`)
4. Add a button in `CanvasToolbar.jsx` that creates a new instance of this node
5. Add the corresponding runner in `server/src/services/nodeRunners/` (see server/CLAUDE.md)

Every node component receives `data` and `selected` as props from React Flow:

```javascript
// nodes/ActionNode.jsx
import { Handle, Position } from 'reactflow'

export default function ActionNode({ data, selected }) {
  return (
    <div className={`node node--action ${selected ? 'node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label}</div>
      <div className="node__type">{data.config?.method || 'HTTP Request'}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
```

Condition nodes need two source handles (true/false):

```javascript
<Handle type="source" position={Position.Bottom} id="true"  style={{ left: '30%' }} />
<Handle type="source" position={Position.Bottom} id="false" style={{ left: '70%' }} />
```

---

## Auth pattern

```javascript
// hooks/useAuth.js
import { useState, useContext, createContext } from 'react'
import { apiFetch } from '../services/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user')
    return stored ? JSON.parse(stored) : null
  })

  async function login(email, password) {
    const { token, user } = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    })
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(user))
    setUser(user)
  }

  function logout() {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
  }

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
```

Wrap `<App>` in `<AuthProvider>`. Protect routes with a guard component that checks `useAuth().user` and redirects to `/login` if null.

---

## CSS conventions

- Use plain CSS with class names, no inline styles except dynamic values (colors, positions from JS)
- Class naming: `block__element--modifier` (BEM-style)
- Node styles: `.node`, `.node--trigger`, `.node--action`, `.node--selected`
- Keep component styles in `styles/` or co-located `.module.css` files
- Canvas background, handles, and edges: override via React Flow CSS variables in `global.css`

---

## Error handling in components

Show errors inline, not in console-only:

```javascript
const [error, setError] = useState(null)
const [loading, setLoading] = useState(false)

async function handleSave() {
  setLoading(true)
  setError(null)
  try {
    await apiFetch(...)
  } catch (err) {
    setError(err.message)
  } finally {
    setLoading(false)
  }
}
```
