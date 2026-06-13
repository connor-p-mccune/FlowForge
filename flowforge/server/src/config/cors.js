// Resolve the CORS allow-list from FRONTEND_URL. Supports a comma-separated
// list (e.g. a custom domain plus the *.vercel.app preview URL). Falls back to
// '*' when unset so local dev and docker-compose keep working with no config.
function allowedOrigins() {
  const raw = process.env.FRONTEND_URL
  if (!raw) return '*'
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : '*'
}

module.exports = { allowedOrigins }
