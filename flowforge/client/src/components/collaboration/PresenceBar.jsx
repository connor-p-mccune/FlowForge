function initials(name) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export default function PresenceBar({ users, selfId }) {
  // A user with two tabs open appears once
  const unique = []
  for (const u of users) {
    if (!unique.some((x) => x.userId === u.userId)) unique.push(u)
  }
  if (unique.length === 0) return null

  return (
    <div className="presence-bar">
      {unique.map((u) => (
        <span
          key={u.userId}
          className="presence-avatar"
          style={{ background: u.color }}
          title={u.userId === selfId ? `${u.displayName} (you)` : u.displayName}
        >
          {initials(u.displayName || '?')}
        </span>
      ))}
    </div>
  )
}
