import { Link } from 'react-router-dom'
import { formatRelative } from '../analytics/format'
import { formatEvent, actorLabel, entityHref, initials, actorColor } from './format'

// A single activity row: actor avatar, "<actor> <action phrase>", relative time.
// The whole row links to the event's subject when there is one to open.
export default function ActivityEvent({ event }) {
  const actor = actorLabel(event)
  const href = entityHref(event)
  const className = `activity-event${event.__isNew ? ' activity-event--new' : ''}`

  const body = (
    <>
      <span
        className="activity-event__avatar"
        style={{ background: actorColor(event.actor_id || actor) }}
        aria-hidden="true"
      >
        {initials(actor)}
      </span>
      <span className="activity-event__body">
        <span className="activity-event__text">
          <span className="activity-event__actor">{actor}</span> {formatEvent(event)}
        </span>
        <time className="activity-event__time" dateTime={event.created_at}>
          {formatRelative(event.created_at)}
        </time>
      </span>
    </>
  )

  return href ? (
    <Link to={href} className={`${className} activity-event--link`}>{body}</Link>
  ) : (
    <div className={className}>{body}</div>
  )
}
