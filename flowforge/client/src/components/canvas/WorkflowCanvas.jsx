import { useCallback } from 'react'
import ReactFlow, { useNodesState, useEdgesState, addEdge, Background, Controls } from 'reactflow'
import 'reactflow/dist/style.css'
import { useWorkflow } from '../../hooks/useWorkflow'
import TriggerNode from './nodes/TriggerNode'
import ActionNode from './nodes/ActionNode'
import ConditionNode from './nodes/ConditionNode'
import AINode from './nodes/AINode'
import OutputNode from './nodes/OutputNode'

const nodeTypes = {
  'trigger-manual': TriggerNode,
  'trigger-webhook': TriggerNode,
  'action-http': ActionNode,
  'action-delay': ActionNode,
  'action-email': ActionNode,
  'action-slack': ActionNode,
  'condition': ConditionNode,
  'ai-prompt': AINode,
  'ai-classify': AINode,
  'ai-extract': AINode,
  'output-log': OutputNode,
  'output-return': OutputNode,
}

export default function WorkflowCanvas({ workflowId }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const { saveGraph } = useWorkflow(workflowId, setNodes, setEdges)

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  )

  function handleNodesChange(changes) {
    onNodesChange(changes)
    saveGraph(nodes, edges)
  }

  function handleEdgesChange(changes) {
    onEdgesChange(changes)
    saveGraph(nodes, edges)
  }

  return (
    <div className="canvas-wrapper">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
