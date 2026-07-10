// Where the CLI finds its server URL and API token. Environment variables win
// (CI-friendly: set FLOWFORGE_URL / FLOWFORGE_TOKEN as job secrets); the
// config file written by `flowforge login` is the interactive fallback.
// FLOWFORGE_CONFIG overrides the file location — tests point it at a temp dir.

const fs = require('fs')
const os = require('os')
const path = require('path')

function configPath() {
  return process.env.FLOWFORGE_CONFIG || path.join(os.homedir(), '.flowforge.json')
}

function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

function resolveConfig() {
  const file = readFileConfig()
  return {
    baseUrl: String(process.env.FLOWFORGE_URL || file.url || '').replace(/\/+$/, ''),
    token: process.env.FLOWFORGE_TOKEN || file.token || '',
  }
}

// mode 0o600: the file holds a bearer token. (No-op on Windows; NTFS ACLs
// already scope the home directory to the user.)
function writeConfig({ url, token }) {
  fs.writeFileSync(configPath(), `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 })
  return configPath()
}

module.exports = { resolveConfig, writeConfig, configPath }
