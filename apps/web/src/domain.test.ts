import { describe, expect, it } from 'vitest'
import { clampTokenPosition, estimateOpusRoomKbps, moveToken } from './domain'
import { seedRoom } from './seed'
import { shouldForceMobileShell } from './shell'

describe('tabletop domain', () => {
  it('keeps tokens inside the scene grid', () => {
    const token = seedRoom.scene.tokens[0]

    expect(clampTokenPosition({ ...token, x: -4, y: 99 }, 12, 8)).toMatchObject({
      x: 1,
      y: 8,
    })
  })

  it('moves a selected token without mutating the original room', () => {
    const moved = moveToken(seedRoom, 'token-a', 6, 5)

    expect(moved.scene.tokens.find((token) => token.id === 'token-a')).toMatchObject({
      x: 6,
      y: 5,
    })
    expect(seedRoom.scene.tokens.find((token) => token.id === 'token-a')).toMatchObject({
      x: 3,
      y: 5,
    })
  })

  it('estimates SFU voice forwarding bandwidth for capacity planning', () => {
    expect(estimateOpusRoomKbps(10)).toBe(5760)
  })

  it('forces mobile layout for Android shells but not Windows paotuan protocol pages', () => {
    expect(shouldForceMobileShell({
      hostname: 'appassets.androidplatform.net',
      userAgent: 'Mozilla/5.0',
    })).toBe(true)
    expect(shouldForceMobileShell({
      hostname: 'app',
      userAgent: 'YehangPaotuanAndroid/1.0',
    })).toBe(true)
    expect(shouldForceMobileShell({
      hostname: 'app',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron',
    })).toBe(false)
  })
})
