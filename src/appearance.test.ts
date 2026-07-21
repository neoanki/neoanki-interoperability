import { describe, expect, it } from 'vitest'
import { onPrimaryColor } from './appearance.js'

describe('extension appearance', () => {
  it('uses the host on-primary token with a legacy fallback', () => {
    expect(onPrimaryColor).toBe('var(--neo-on-primary,#fff)')
  })
})
