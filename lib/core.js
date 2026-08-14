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
