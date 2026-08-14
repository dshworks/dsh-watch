import { describe, expect, it } from 'vitest'
import { capBytes, chopFileWindow, compileFilter, createBacklog, createLineBuffer, formatNotice } from '../lib/core.js'

describe('createLineBuffer', () => {
  it('assembles lines split across chunks', () => {
    const buf = createLineBuffer()
    expect(buf.feed('hel')).toEqual([])
    expect(buf.feed('lo\nwor')).toEqual(['hello'])
    expect(buf.feed('ld\n')).toEqual(['world'])
  })

  it('handles several lines in one chunk and drops empties', () => {
    const buf = createLineBuffer()
    expect(buf.feed('a\n\nb\r\n\nc\n')).toEqual(['a', 'b', 'c'])
  })

  it('strips CR from CRLF endings', () => {
    const buf = createLineBuffer()
    expect(buf.feed('dos line\r\n')).toEqual(['dos line'])
  })

  it('carries a multibyte character split across chunk boundaries', () => {
    const buf = createLineBuffer()
    // '鲸' arrives whole inside a chunk but the line completes later.
    expect(buf.feed('深海鲸')).toEqual([])
    expect(buf.feed('鱼\n')).toEqual(['深海鲸鱼'])
  })

  it('flush surrenders the trailing fragment exactly once', () => {
    const buf = createLineBuffer()
    buf.feed('no newline yet')
    expect(buf.flush()).toEqual(['no newline yet'])
    expect(buf.flush()).toEqual([])
  })

  it('ignores empty and non-string chunks', () => {
    const buf = createLineBuffer()
    expect(buf.feed('')).toEqual([])
    expect(buf.feed(undefined)).toEqual([])
  })
})

describe('capBytes', () => {
  it('returns short text unchanged', () => {
    expect(capBytes('ok', 100, '[cut]')).toBe('ok')
  })

  it('returns text exactly at the limit unchanged', () => {
    expect(capBytes('abcd', 4, '[cut]')).toBe('abcd')
  })

  it('truncates with the marker inside the budget', () => {
    const out = capBytes('abcdefghij', 8, '~')
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(8)
    expect(out.endsWith('~')).toBe(true)
    expect(out).toBe('abcdefg~')
  })

  it('never splits a multibyte code point', () => {
    // Each '鲸' is 3 UTF-8 bytes; a 7-byte budget with a 1-byte marker leaves
    // 6 bytes of content = exactly two whales.
    const out = capBytes('鲸鲸鲸鲸', 7, '~')
    expect(out).toBe('鲸鲸~')
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(7)
  })

  it('survives a budget smaller than the marker', () => {
    const out = capBytes('abcdef', 2, '[truncated]')
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2)
  })
})

describe('compileFilter', () => {
  it('returns undefined for no pattern', () => {
    expect(compileFilter(undefined)).toBeUndefined()
    expect(compileFilter('')).toBeUndefined()
  })

  it('compiles a valid pattern', () => {
    expect(compileFilter('ERROR|WARN').test('an ERROR line')).toBe(true)
  })

  it('fails loud on an invalid pattern', () => {
    expect(() => compileFilter('(unclosed')).toThrow(/invalid pattern/)
  })
})

describe('chopFileWindow', () => {
  it('consumes only through the final newline', () => {
    const { lines, consumedBytes } = chopFileWindow(Buffer.from('a\nb\npartial'), false)
    expect(lines).toEqual(['a', 'b'])
    expect(consumedBytes).toBe(4)
  })

  it('consumes nothing when no newline arrived yet', () => {
    const { lines, consumedBytes } = chopFileWindow(Buffer.from('still going'), false)
    expect(lines).toEqual([])
    expect(consumedBytes).toBe(0)
  })

  it('force-consumes a full window with no newline', () => {
    const { lines, consumedBytes } = chopFileWindow(Buffer.from('oneenormousline'), true)
    expect(lines).toEqual(['oneenormousline'])
    expect(consumedBytes).toBe(15)
  })

  it('never decodes a multibyte tail early', () => {
    // '鲸' = e9 b2 b8; the window ends one byte into the character.
    const whale = Buffer.from('line\n鲸', 'utf8')
    const windowed = whale.subarray(0, whale.byteLength - 2)
    const { lines, consumedBytes } = chopFileWindow(windowed, false)
    expect(lines).toEqual(['line'])
    expect(consumedBytes).toBe(5)
  })

  it('handles an empty window', () => {
    expect(chopFileWindow(Buffer.alloc(0), true)).toEqual({ lines: [], consumedBytes: 0 })
  })
})

describe('formatNotice', () => {
  it('leads with the label, id, and line count', () => {
    const { text, summary } = formatNotice('dev', 'watch-1', ['boom'], 4096)
    expect(text).toBe('[watch dev · watch-1] 1 line:\nboom')
    expect(summary).toBe('dev: boom')
  })

  it('caps the complete notice, wrapper included', () => {
    const { text } = formatNotice('dev', 'watch-1', ['x'.repeat(9000)], 512)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(512)
    expect(text).toContain('[notice truncated')
  })

  it('pluralizes multi-line batches', () => {
    const { text } = formatNotice('dev', 'watch-2', ['a', 'b'], 4096)
    expect(text).toContain('2 lines:')
  })
})

describe('createBacklog', () => {
  it('drains what was pushed, once', () => {
    const backlog = createBacklog(1024)
    backlog.push('one')
    backlog.push('two')
    expect(backlog.drain()).toBe('one\ntwo')
    expect(backlog.drain()).toBe('')
  })

  it('drops oldest lines beyond the byte budget and says so', () => {
    const backlog = createBacklog(1024)
    // Cross the budget so early lines are evicted.
    for (let i = 0; i < 60; i++) backlog.push(`line-${i}-${'x'.repeat(30)}`)
    const out = backlog.drain()
    expect(out).toMatch(/^\[backlog trimmed: \d+ older line\(s\) dropped\]\n/)
    expect(out).not.toContain('line-0-')
    expect(out).toContain('line-59-')
  })

  it('always retains the newest line even when it alone exceeds the budget', () => {
    const backlog = createBacklog(1024)
    backlog.push('x'.repeat(5000))
    expect(backlog.drain()).toContain('x'.repeat(5000))
  })
})
