#!/usr/bin/env node
/**
 * observer-tap — CLI for the V0a capture tap.
 *
 *   node packages/capture/bin/tap.mjs \
 *     --listen-port 8787 \
 *     --upstream https://token-plan.ap-southeast-1.maas.aliyuncs.com \
 *     --out ./observer-data/captures
 *
 * Then point DSH at it — NOTE: the baseURL change does NOT redirect an
 * already-running session (falsified live 2026-11-10, task-17 pre-flight, despite
 * a docstring suggesting per-operation profile re-reads). Restart DSH or start a
 * NEW session after the change, and verify by watching captures appear:
 *
 *   llm-pi-ai.providers.<qwen-route>.baseURL: "http://127.0.0.1:8787/compatible-mode/v1"
 *
 * (keep the upstream path suffix the real provider expects; the tap forwards the
 * request target verbatim). Restore the original baseURL after the session.
 * The tap never sees or stores credentials beyond forwarding them byte-for-byte;
 * redaction happens at export time (@observer/capture redactCapture).
 */

import { startTap } from '../dist/index.js'

const DEFAULT_UPSTREAM = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const upstream = arg('upstream', DEFAULT_UPSTREAM)
const listenHost = arg('listen-host', '127.0.0.1')
const listenPort = Number(arg('listen-port', '8787'))
const outDir = arg('out', './observer-data/captures')

const tap = await startTap({
  upstreamOrigin: upstream,
  listenHost,
  listenPort,
  outDir,
  rewriteHost: !flag('no-rewrite-host'),
  tlsRejectUnauthorized: !flag('insecure-tls'),
})

console.log(`observer-tap listening on ${tap.origin} -> ${upstream}`)
console.log(`captures: ${tap.outDir}`)
console.log('point DSH at it:  llm-pi-ai.providers.<qwen-route>.baseURL = ' + `${tap.origin}/compatible-mode/v1`)
console.log('Ctrl-C to stop.')

let stopping = false
const shutdown = async (signal) => {
  if (stopping) return
  stopping = true
  console.log(`\n${signal}: stopping; ${tap.captureIds().length} capture(s) recorded.`)
  await tap.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
