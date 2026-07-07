import type { MapToken, RoomState } from './types'

export function clampTokenPosition(
  token: MapToken,
  width: number,
  height: number,
): MapToken {
  return {
    ...token,
    x: Math.min(Math.max(token.x, 1), width),
    y: Math.min(Math.max(token.y, 1), height),
  }
}

export function moveToken(
  room: RoomState,
  tokenId: string,
  x: number,
  y: number,
): RoomState {
  const tokens = room.scene.tokens.map((token) =>
    token.id === tokenId
      ? clampTokenPosition({ ...token, x, y }, room.scene.width, room.scene.height)
      : token,
  )

  return {
    ...room,
    scene: {
      ...room.scene,
      tokens,
    },
  }
}

export function updateCharacterVitals(
  room: RoomState,
  characterId: string,
  hp: number,
  sanity: number,
): RoomState {
  return {
    ...room,
    characters: room.characters.map((character) =>
      character.id === characterId
        ? {
            ...character,
            hp: Math.min(Math.max(hp, 0), character.maxHp),
            sanity: Math.min(Math.max(sanity, 0), character.maxSanity),
          }
        : character,
    ),
  }
}

export function estimateOpusRoomKbps(participants: number, kbpsPerStream = 64) {
  if (participants <= 1) {
    return 0
  }

  return participants * Math.max(participants - 1, 1) * kbpsPerStream
}

export function formatClock(iso?: string | null) {
  if (!iso) {
    return ''
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
