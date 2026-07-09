// Small pure helpers for canvas node operations.

// A duplicate of `node`: fresh id, slight offset so it doesn't sit exactly on
// top of the original, and a deep-copied data/config so editing the copy can
// never mutate the original through a shared reference.
export function makeDuplicate(node) {
  return {
    id: crypto.randomUUID(),
    type: node.type,
    position: { x: node.position.x + 40, y: node.position.y + 40 },
    data: JSON.parse(JSON.stringify(node.data || {})),
  }
}
