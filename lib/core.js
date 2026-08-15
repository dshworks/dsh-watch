/**
 * Pure stream-listening logic for dsh-watch: line assembly over chunked
 * output, UTF-8-safe byte capping, and notice formatting. No harness imports —
 * everything here is unit-testable in isolation.
 * @module dsh-watch/core
 */

const NL = 0x0a

/**
 * Assemble complete lines from arbitrarily chunked text. A trailing fragment
 * is carried until its newline arrives; `flush()` surrenders it.
 * @returns {{ feed(chunk: string): string[], flush(): string[] }}
 */
export function createLineBuffer() {
  let partial = ''
  return {
    /**
     * Consume one chunk and return the complete lines it finishes.
     * @param {string} chunk - output delta in arrival order.
     * @returns {string[]} complete lines, `\r` stripped, empty lines dropped.
     */
    feed(chunk) {
      if (typeof chunk !== 'string' || chunk.length === 0) return []
      const text = partial + chunk
      const lines = text.split('\n')
      partial = lines.pop() ?? ''
      return lines.map(stripCr).filter(line => line.length > 0)
    },
    /**
     * Surrender the carried fragment as a final line (used when the source
     * settles and no newline will ever arrive).
     * @returns {string[]} zero or one line.
     */
    flush() {
      const rest = stripCr(partial)
      partial = ''
      return rest.length > 0 ? [rest] : []
    },
  }
}

function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Cap text to a UTF-8 byte budget without splitting a code point. The marker
 * is included inside the budget; a budget smaller than the marker returns the
 * marker truncated bytewise (the caller's Config floor makes that unreachable
 * in production).
 * @param {string} text - the complete candidate text.
 * @param {number} maxBytes - UTF-8 byte budget for the returned string.
 * @param {string} marker - appended when truncation occurred.
 * @returns {string} `text` unchanged, or a boundary-safe prefix plus marker.
 */
export function capBytes(text, maxBytes, marker) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const budget = maxBytes - markerBytes
  if (budget <= 0) return Buffer.from(marker, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8')
  let cut = budget
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--
  return buf.subarray(0, cut).toString('utf8') + marker
}

/**
 * Compile a caller-supplied line filter.
 * @param {string | undefined} pattern - JavaScript regular expression source.
 * @returns {RegExp | undefined} the compiled filter, or undefined for none.
 * @throws {Error} when the pattern does not compile — misconfiguration fails
 *   loud at the tool call, never silently matches nothing.
 */
export function compileFilter(pattern) {
  if (pattern === undefined || pattern === '') return undefined
  try {
    return new RegExp(pattern)
  } catch (error) {
    throw new Error(`watch: invalid pattern ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Split a byte range of a file buffer into consumable complete lines. Only
 * bytes up to and including the final newline are consumed, so a partial
 * trailing line (or a multibyte character split by the read window) is never
 * decoded early — `\n` cannot occur inside a UTF-8 sequence, making the cut
 * boundary-safe. A window with no newline consumes nothing until `force`.
 * @param {Buffer} buf - freshly read bytes after the cursor.
 * @param {boolean} force - consume everything even without a trailing newline
 *   (used when the window is full, so one enormous line cannot stall the tail).
 * @returns {{ lines: string[], consumedBytes: number }}
 */
export function chopFileWindow(buf, force) {
  const lastNl = buf.lastIndexOf(NL)
  if (lastNl === -1) {
    if (!force || buf.byteLength === 0) return { lines: [], consumedBytes: 0 }
    return { lines: [stripCr(buf.toString('utf8'))].filter(l => l.length > 0), consumedBytes: buf.byteLength }
  }
  const consumed = buf.subarray(0, lastNl + 1).toString('utf8')
  const lines = consumed.split('\n').map(stripCr).filter(line => line.length > 0)
  return { lines, consumedBytes: lastNl + 1 }
}

/**
 * Format one wake-up notice from a batch of heard lines.
 * @param {string} label - the listener's short display name.
 * @param {string} jobId - the registry-issued job id (the disarm handle).
 * @param {string[]} lines - the batch, in arrival order.
 * @param {number} maxBytes - byte cap applied to the complete notice text.
 * @returns {{ text: string, summary: string }} model-facing body and a
 *   one-line account for the collapsed transcript row.
 */
export function formatNotice(label, jobId, lines, maxBytes) {
  const head = `[watch ${label} · ${jobId}] ${lines.length === 1 ? '1 line' : `${lines.length} lines`}:`
  const text = capBytes(`${head}\n${lines.join('\n')}`, maxBytes, '\n[notice truncated — job_output has the backlog]')
  return { text, summary: `${label}: ${lines[0]}` }
}

/**
 * A per-owner budget for opening turns on an idle agent.
 *
 * Waking is bursty by nature and expensive by the request it opens, so the
 * budget is a token bucket rather than a plain counter: `capacity` wakes may
 * happen back to back, after which credits return one per `refillMs`. A
 * counter alone (the `dsh-tool-jobs` rule, reproduced by `refillMs: 0`) is
 * right for a session a human keeps feeding — their next message refills it —
 * and wrong for an unattended one, which would go permanently deaf after its
 * capacity-th wake.
 * @param {{ capacity: number, refillMs: number }} bounds - burst size and the
 *   period that restores one credit; `refillMs: 0` disables time refill.
 * @returns {{ take(owner: object, now: number): boolean, refill(owner: object): void }}
 */
export function createWakeBudget({ capacity, refillMs }) {
  /** @type {WeakMap<object, { credits: number, since: number }>} */
  const state = new WeakMap()
  function read(owner, now) {
    let entry = state.get(owner)
    if (entry === undefined) {
      entry = { credits: capacity, since: now }
      state.set(owner, entry)
      return entry
    }
    if (refillMs > 0 && entry.credits < capacity) {
      const restored = Math.floor((now - entry.since) / refillMs)
      if (restored > 0) {
        entry.credits = Math.min(capacity, entry.credits + restored)
        // A full bucket has no refill clock running; a partial one keeps the
        // remainder so credits do not drift later with each read.
        entry.since = entry.credits >= capacity ? now : entry.since + restored * refillMs
      }
    }
    return entry
  }
  return {
    /**
     * Spend one credit.
     * @param {object} owner - the agent the wake would target.
     * @param {number} now - current epoch ms.
     * @returns {boolean} whether a credit was available and spent.
     */
    take(owner, now) {
      const entry = read(owner, now)
      if (entry.credits <= 0) return false
      if (entry.credits === capacity) entry.since = now // the clock starts on the first spend
      entry.credits -= 1
      return true
    },
    /**
     * Restore the bucket to full — the owner did something that proves the
     * wakes are landing (a human spoke).
     * @param {object} owner - the agent whose budget refills.
     */
    refill(owner) {
      state.delete(owner)
    },
  }
}

/**
 * A bounded, consuming backlog of heard lines backing the job's `readOutput`.
 * Oldest lines are dropped first once the byte budget is exceeded, and a drop
 * is recorded as one synthetic marker line so silence never masquerades as
 * completeness.
 * @param {number} maxBytes - retained-bytes budget across buffered lines.
 * @returns {{ push(line: string): void, drain(): string }}
 */
export function createBacklog(maxBytes) {
  /** @type {string[]} */
  let lines = []
  let bytes = 0
  let dropped = 0
  return {
    /** @param {string} line - one heard line to retain for job_output. */
    push(line) {
      lines.push(line)
      bytes += Buffer.byteLength(line, 'utf8') + 1
      while (bytes > maxBytes && lines.length > 1) {
        const evicted = lines.shift()
        bytes -= Buffer.byteLength(evicted, 'utf8') + 1
        dropped++
      }
    },
    /** @returns {string} everything retained since the previous drain. */
    drain() {
      const parts = dropped > 0 ? [`[backlog trimmed: ${dropped} older line(s) dropped]`, ...lines] : lines
      lines = []
      bytes = 0
      dropped = 0
      return parts.join('\n')
    },
  }
}
