// Sticky note: a canvas annotation, not a step. It renders without handles so
// nothing can be wired to it, and the engine/linter ignore it entirely — the
// note explains the graph to the next human, and that's its whole job.
const NOTE_COLORS = {
  yellow: 'note--yellow',
  pink: 'note--pink',
  blue: 'note--blue',
  green: 'note--green',
}

export default function NoteNode({ data, selected }) {
  const colorClass = NOTE_COLORS[data.config?.color] || NOTE_COLORS.yellow
  return (
    <div className={`node node--note ${colorClass}${selected ? ' node--selected' : ''}`}>
      <div className="node__note-text">
        {data.config?.text || 'Double-click to select, then edit the text in the panel.'}
      </div>
    </div>
  )
}
