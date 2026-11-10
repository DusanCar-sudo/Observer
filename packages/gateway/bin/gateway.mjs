#!/usr/bin/env node
/**
 * observer-gateway — CLI for the V1 byte-faithful pass-through gateway.
 *
 *   node packages/gateway/bin/gateway.mjs \
 *     --listen-port 8788 \
 *     --upstream https://token-plan.ap-southeast-1.maas.aliyuncs.com \
 *     --capture-out ./observer-data/captures
 *
 * Then point DSH at it — the baseURL change does NOT redirect an already-running
 * session (falsified live 2026-11-10, task-17 pre-flight): restart DSH or start a
 * NEW session after the change, and verify by watching captures/stats appear:
 *
 *   llm-pi-ai.providers.<qwen-route>.baseURL: "http://127.0.0.1:8788/compatible-mode/v1"
 *
 * Milestone 1 is OBSERVE-ONLY: the gateway forwards bytes, records bytes, refuses
 * what it does not support, and mutates nothing. Restore the original baseURL to
 * remove Observer from the path — reversibility without code changes (I4; the
 * restore, like the install, takes effect on restart/new session).
 *
 * Stats are printed periodically (default 30s) because a number nobody reads
 * protects nobody (§9.1 condition 1).
 */

import { startGateway } from '../dist/index.js'

const DEFAULT_UPSTREAM = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const gw = await startGateway({
  upstreamOrigin: arg('upstream', DEFAULT_UPSTREAM),
  listenHost: arg('listen-host', '127.0.0.1'),
  listenPort: Number(arg('listen-port', '8788')),
  captureOutDir: arg('capture-out', './observer-data/captures'),
  capture: !flag('no-capture'),
  rewriteHost: !flag('no-rewrite-host'),
  tlsRejectUnauthorized: !flag('insecure-tls'),
})

console.log(`observer-gateway listening on ${gw.origin} -> ${arg('upstream', DEFAULT_UPSTREAM)}`)
console.log(`captures: ${gw.outDir ?? '(capture disabled)'}`)
console.log('serve: POST /v1/chat/completions only; everything else is refused 501 (spec §9.1).')
console.log('Ctrl-C to stop.')

const statsInterval = setInterval(() => {
  console.log(`[stats] ${JSON.stringify(gw.stats())}`)
}, Number(arg('stats-interval-ms', '30000')))

let stopping = false
const shutdown = async (signal) => {
  if (stopping) return
  stopping = true
  clearInterval(statsInterval)
  console.log(`\n${signal}: stopping. final stats: ${JSON.stringify(gw.stats())}`)
  console.log(`captures recorded: ${gw.captureIds().length}`)
  await gw.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
