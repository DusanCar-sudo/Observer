// SUT factory for the isolated conformance runner: the V1 gateway.
// capture ON (shipping configuration — lead's jurisdiction split: conformance
// suites run capture-on; the V4b gap loop runs capture-off to gate forwarding).
import { startGateway } from '@observer/gateway'

export default ({ captureOutDir }) => ({
  name: 'GatewayV1',
  async start(ctx) {
    const gw = await startGateway({
      upstreamOrigin: ctx.upstreamOrigin,
      rewriteHost: false,
      captureOutDir,
      listenPort: 0,
    })
    return { port: gw.port, stop: () => gw.stop() }
  },
})
