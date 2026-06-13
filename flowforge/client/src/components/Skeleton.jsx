// Shimmering placeholder block shown while data loads. Pass width/height to
// match the real content's footprint so the layout doesn't jump on load.
export default function Skeleton({ width = '100%', height = 14, radius = 6, style = {} }) {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  )
}

// Convenience: a vertical stack of `count` skeleton rows.
export function SkeletonRows({ count = 3, height = 32, gap = 8, style = {} }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} height={height} />
      ))}
    </div>
  )
}
