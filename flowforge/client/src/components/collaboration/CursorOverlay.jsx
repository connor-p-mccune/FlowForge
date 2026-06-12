import { useViewport } from 'reactflow'

// Renders remote user cursors. Positions arrive in flow coordinates, so we
// map them to screen space with the current viewport transform — cursors stay
// glued to the canvas through pan and zoom.
export default function CursorOverlay({ cursors, users }) {
  const { x: vx, y: vy, zoom } = useViewport()

  const entries = Object.entries(cursors)
  if (entries.length === 0) return null

  return (
    <div className="cursor-overlay">
      {entries.map(([userId, c]) => {
        const left = c.x * zoom + vx
        const top = c.y * zoom + vy
        const name = users.find((u) => u.userId === userId)?.displayName || ''
        return (
          <div key={userId} className="remote-cursor" style={{ left, top }}>
            <svg width="16" height="20" viewBox="0 0 16 20">
              <path
                d="M0 0 L16 12 L8.5 13 L5 20 Z"
                fill={c.color}
                stroke="#fff"
                strokeWidth="1"
              />
            </svg>
            {name && (
              <span className="remote-cursor__name" style={{ background: c.color }}>
                {name}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
