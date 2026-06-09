function requireFields(...fields) {
  return (req, res, next) => {
    for (const field of fields) {
      if (!req.body[field]) {
        return res.status(400).json({ error: `${field} is required` })
      }
    }
    next()
  }
}

module.exports = { requireFields }
