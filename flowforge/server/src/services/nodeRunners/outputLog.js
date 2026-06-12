module.exports = async function runOutputLog(config, input) {
  const message = config.message || JSON.stringify(input)
  console.log('[output-log]', message)
  return { message }
}
