/**
 * @observer/gateway — the V1 byte-faithful pass-through for DSH -> qwen.
 *
 * The gateway owns POLICY only: routing/refusals (route.ts), configuration
 * validation (config.ts), and counted statistics (stats.ts). Byte fidelity lives
 * once, in @observer/capture's proxy core, and is judged once by the rig.
 */

export { startGateway, POISONED_RECORDER, type GatewayHandle } from './server.js'
export { decideRoute } from './route.js'
export { validateGatewayConfig, type GatewayConfig } from './config.js'
export { StatsCollector, type GatewayStats } from './stats.js'
