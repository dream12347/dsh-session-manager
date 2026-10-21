import { describe, expect, it } from 'vitest'
import { encodeTrashSegment, openFolderCommand } from '../src/index.js'

describe('openFolderCommand', () => {
  it('uses Finder on macOS', () => {
    expect(openFolderCommand('darwin')).toBe('open')
  })

  it('uses Explorer on Windows', () => {
    expect(openFolderCommand('win32')).toBe('explorer')
  })

  it('uses xdg-open on Linux', () => {
    expect(openFolderCommand('linux')).toBe('xdg-open')
  })
})

describe('encodeTrashSegment', () => {
  it('keeps safe characters as-is', () => {
    expect(encodeTrashSegment('session-41f4a971-4279-45aa-9f3f-97799c282968'))
      .toBe('session-41f4a971-4279-45aa-9f3f-97799c282968')
  })

  it('escapes colons the same way the host persistence layer does', () => {
    expect(encodeTrashSegment('im:qq_cf0690c0ddbc:dm:1792490748079:51DF1E2C0699A46D92E38E00E84DADF9'))
      .toBe('im~003Aqq_cf0690c0ddbc~003Adm~003A1792490748079~003A51DF1E2C0699A46D92E38E00E84DADF9')
  })

  it('escapes dot and dot-dot to avoid path traversal', () => {
    expect(encodeTrashSegment('.')).toBe('~002E')
    expect(encodeTrashSegment('..')).toBe('~002E~002E')
  })

  it('escapes tilde', () => {
    expect(encodeTrashSegment('a~b')).toBe('a~007Eb')
  })

  it('rejects an empty id', () => {
    expect(() => encodeTrashSegment('')).toThrow('cannot encode an empty path segment')
  })
})
