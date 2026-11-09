/**
 * ReferencePipe — the byte-faithful pass-through test double.
 *
 * ⚠ TEST DOUBLE, NOT OBSERVER PRODUCTION CODE. ⚠ The V1 gateway (packages/gateway)
 * is the real implementation; this exists so the rig can be verified end-to-end
 * before the gateway exists: zero diffs against ReferencePipe on every fixture means
 * "no false positives", and detection of the faulty doubles means "no false
 * negatives". A rig that has never passed anything proves nothing.
 *
 * Its forwarding discipline mirrors what V1 must do (and is what makes it a useful
 * conformance target): raw body pipe (never parse → re-serialise), header pairs
 * forwarded in received order minus the hop-by-hop set, response writes one-per-
 * arrival so chunk boundaries survive, upstream truncation propagated as truncation
 * (destroySoon — never a synthesised clean end), client abort propagated upstream.
 */

import { createProxySut } from './common.js'

export const ReferencePipe = createProxySut({ name: 'ReferencePipe' })
