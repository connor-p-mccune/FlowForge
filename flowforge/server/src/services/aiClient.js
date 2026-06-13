// Server-side client for the Python AI service. All LLM work goes through here
// (the frontend never calls the AI service directly). Used by the /api/ai/*
// proxy routes and by the AI node runners.

function aiServiceUrl() {
  return process.env.AI_SERVICE_URL || 'http://localhost:5000'
}

async function callAiService(path, payload) {
  let res
  try {
    res = await fetch(`${aiServiceUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    })
  } catch (err) {
    throw new Error(`AI service unavailable: ${err.message}`)
  }

  let data
  try {
    data = await res.json()
  } catch {
    data = {}
  }

  if (!res.ok) {
    throw new Error(data.error || `AI service error (HTTP ${res.status})`)
  }
  return data
}

module.exports = { callAiService, aiServiceUrl }
