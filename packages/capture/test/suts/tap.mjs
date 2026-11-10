// SUT factory for the isolated conformance runner: the V0a capture tap.
import { startTap } from '@observer/capture'

export default ({ captureOutDir }) => ({
  name: 'CaptureTap',
  async start(ctx) {
    const tap = await startTap({
      upstreamOrigin: ctx.upstreamOrigin,
      outDir: captureOutDir,
      listenPort: 0,
      rewriteHost: false,
    })
    return { port: tap.port, stop: () => tap.stop() }
  },
})
