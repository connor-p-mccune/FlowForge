import { Handle, Position } from 'reactflow'

// Switch node: multi-way routing. It renders one source handle per case (its id
// is the case label — what the engine compares against each edge's sourceHandle)
// plus a trailing 'default' handle for the no-match branch. Handles are spaced
// evenly along the bottom edge, so a three-case switch shows four outlets.
//
// Only non-blank, unique case labels become handles: React Flow requires unique
// handle ids per node, and a blank label can't be a valid branch — the linter
// flags both, and skipping them here keeps the canvas from rendering a broken
// (colliding or empty) handle before the author fixes it.
export default function SwitchNode({ data, selected }) {
  const cases = Array.isArray(data.config?.cases) ? data.config.cases : []
  const seen = new Set()
  const labels = []
  for (const c of cases) {
    const label = typeof c?.label === 'string' ? c.label.trim() : ''
    if (label && label !== 'default' && !seen.has(label)) {
      seen.add(label)
      labels.push(label)
    }
  }
  const outlets = [...labels, 'default']
  // Evenly distribute k outlets across the bottom edge at (i+1)/(k+1).
  const positionFor = (i) => `${((i + 1) / (outlets.length + 1)) * 100}%`

  return (
    <div className={`node node--switch${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'Switch'}</div>
      <div className="node__switch-cases">
        {outlets.map((label) => (
          <span
            key={label}
            className={`node__switch-case${label === 'default' ? ' node__switch-case--default' : ''}`}
          >
            {label}
          </span>
        ))}
      </div>
      {outlets.map((label, i) => (
        <Handle
          key={label}
          type="source"
          position={Position.Bottom}
          id={label}
          style={{ left: positionFor(i) }}
        />
      ))}
    </div>
  )
}
