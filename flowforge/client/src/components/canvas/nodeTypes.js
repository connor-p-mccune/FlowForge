// Shared map of workflow node `type` → React component. Used by the live canvas
// (WorkflowCanvas) and the read-only version-history preview (HistoryPanel) so
// both render the same custom nodes. Keep new node types in sync here.
import TriggerNode from './nodes/TriggerNode'
import ActionNode from './nodes/ActionNode'
import ConditionNode from './nodes/ConditionNode'
import AINode from './nodes/AINode'
import OutputNode from './nodes/OutputNode'
import SubWorkflowNode from './nodes/SubWorkflowNode'
import ForEachNode from './nodes/ForEachNode'
import ApprovalNode from './nodes/ApprovalNode'

export const nodeTypes = {
  'trigger-manual': TriggerNode,
  'trigger-webhook': TriggerNode,
  'trigger-schedule': TriggerNode,
  'action-http': ActionNode,
  'action-delay': ActionNode,
  'action-email': ActionNode,
  'action-slack': ActionNode,
  'transform': ActionNode,
  'condition': ConditionNode,
  'approval': ApprovalNode,
  'ai-prompt': AINode,
  'ai-classify': AINode,
  'ai-extract': AINode,
  'output-log': OutputNode,
  'output-return': OutputNode,
  'sub-workflow': SubWorkflowNode,
  'for-each': ForEachNode,
}
