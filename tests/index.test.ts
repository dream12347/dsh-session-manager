import { describe, expect, it } from 'vitest'
import { openFolderCommand } from '../src/index.js'

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
