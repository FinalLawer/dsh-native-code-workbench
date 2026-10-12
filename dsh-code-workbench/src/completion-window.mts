/**
 * How much caret context a Tab completion request carries, in characters.
 *
 * Both halves read this file, for opposite reasons, and they must agree.
 * The client half reads it to decide how much of the file to ship: sending the
 * whole buffer would spend latency and bandwidth on context no completion can
 * use. The Host half reads it because it cannot trust a client: it re-caps what
 * arrives, so a request from anything else cannot make the Host build a prompt
 * out of an unbounded prefix.
 *
 * One number, not two. If the client's window were ever the larger of the pair,
 * the Host would trim it in silence — and the model would then answer from less
 * context than the request claimed, which is invisible from the outside and
 * shows up only as completions that look oddly uninformed.
 */

/** Characters of the file before the caret, ending at it. */
export const COMPLETION_PREFIX_CHARS = 3200
/** Characters after the caret, used to tell the model where it is going. */
export const COMPLETION_SUFFIX_CHARS = 900
