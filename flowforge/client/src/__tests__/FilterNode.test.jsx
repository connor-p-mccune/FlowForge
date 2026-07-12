import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from 'reactflow'

import ActionNode from '../components/canvas/nodes/ActionNode'
import { NODE_DEFS, TOOLBAR_BUTTONS } from '../components/canvas/nodeDefs'
import { nodeTypes } from '../components/canvas/nodeTypes'

function renderNode(ui) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>)
}

describe('Filter node wiring', () => {
  it('renders its subtype through the shared ActionNode', () => {
    renderNode(<ActionNode data={{ label: 'Only urgent', subtype: 'filter' }} selected={false} />)
    expect(screen.getByText('Only urgent')).toBeInTheDocument()
    expect(screen.getByText('filter')).toBeInTheDocument()
  })

  it('is registered in the node defs, toolbar, and type map', () => {
    expect(NODE_DEFS.filter).toMatchObject({
      label: 'Filter',
      subtype: 'filter',
      config: { source: '', predicate: '' },
    })
    expect(TOOLBAR_BUTTONS.some((b) => b.type === 'filter')).toBe(true)
    expect(nodeTypes.filter).toBe(ActionNode)
  })

  it('registers the Map node alongside it', () => {
    expect(NODE_DEFS.map).toMatchObject({
      label: 'Map',
      subtype: 'map',
      config: { source: '', mapping: '' },
    })
    expect(TOOLBAR_BUTTONS.some((b) => b.type === 'map')).toBe(true)
    expect(nodeTypes.map).toBe(ActionNode)
  })
})
