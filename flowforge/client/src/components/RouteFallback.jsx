import { SkeletonRows } from './Skeleton'

// What shows while a lazily-loaded route's chunk is in flight.
//
// Skeleton rows rather than a spinner, matching what every page in the app
// already does while its data loads — the two waits are indistinguishable to
// whoever is looking at them, and using a different indicator for each would
// imply a difference that doesn't exist.
//
// `role="status"` with a polite live region, because the visual is decorative:
// a screen reader gets told the page is loading, once, instead of nothing at
// all.
export default function RouteFallback() {
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <SkeletonRows count={4} height={40} />
    </div>
  )
}
