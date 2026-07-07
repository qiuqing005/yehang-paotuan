import type {
  Account,
  AuthSession,
  Character,
  CharacterSheet,
  ChatMessage,
  Coc7Attributes,
  Coc7Background,
  Coc7Derived,
  Coc7SkillPoint,
  DirectMessage,
  DiceRollResponse,
  DiceRollResult,
  DiceProfile,
  FriendSummary,
  FriendStatus,
  MapFeature,
  MapToken,
  RoomMember,
  RoomProgress,
  RoomPublicContent,
  RoomState,
  RoomSummary,
  RoomPhase,
  RoomVisibility,
  SceneState,
  ScriptBlock,
  ScriptCharacter,
  ScriptChapter,
  ScriptMap,
  ScriptVisibility,
  TrpgScript,
  TrpgScriptSummary,
  VoiceTokenResponse,
  VoiceParticipant,
  UserRole,
} from './types'

declare global {
  interface Window {
    __PAOTUAN_API_BASE__?: string
  }
}

export const apiBaseStorageKey = 'paotuan.apiBase'

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function configuredNativeApiBase() {
  const configured = window.__PAOTUAN_API_BASE__ ?? import.meta.env.VITE_PAOTUAN_API_BASE ?? ''
  return configured ? normalizeApiBase(configured) : ''
}

function builtinApiBase() {
  if (
    window.location.hostname === 'appassets.androidplatform.net' ||
    window.location.protocol === 'file:' ||
    window.location.protocol === 'paotuan:'
  ) {
    return configuredNativeApiBase()
  }
  const configured = configuredNativeApiBase()
  if (configured) {
    return configured
  }
  return ''
}

export const defaultApiBase = builtinApiBase()

export function normalizeApiBase(value: string) {
  const trimmed = stripTrailingSlash(value.trim())
  if (!trimmed) {
    return ''
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  url.search = ''
  url.hash = ''
  return stripTrailingSlash(url.toString())
}

export function getApiBase() {
  try {
    const stored = localStorage.getItem(apiBaseStorageKey)
    return stored ? normalizeApiBase(stored) : defaultApiBase
  } catch {
    return defaultApiBase
  }
}

export function setApiBase(value: string) {
  const normalized = normalizeApiBase(value)
  try {
    if (!normalized || normalized === defaultApiBase) {
      localStorage.removeItem(apiBaseStorageKey)
    } else {
      localStorage.setItem(apiBaseStorageKey, normalized)
    }
  } catch {
    // Ignore storage failures; requests will still use the in-memory normalized value.
  }
  return normalized || defaultApiBase
}

export function resetApiBase() {
  try {
    localStorage.removeItem(apiBaseStorageKey)
  } catch {
    // Ignore storage failures.
  }
  return defaultApiBase
}

export const apiBase = getApiBase()

export function apiUrl(path: string) {
  const currentApiBase = getApiBase()
  return currentApiBase ? new URL(path, currentApiBase).toString() : path
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

export type ApiRequestError = Error & {
  body?: unknown
  retryAfterSeconds?: number
  status?: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  const forwardAbort = () => controller.abort()
  init?.signal?.addEventListener('abort', forwardAbort, { once: true })
  let response: Response
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...init?.headers,
      },
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Request timed out', { cause: error })
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
    init?.signal?.removeEventListener('abort', forwardAbort)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let body: Record<string, unknown> | undefined
    try {
      const parsed = text ? (JSON.parse(text) as unknown) : undefined
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
    } catch {
      body = undefined
    }
    const message = typeof body?.error === 'string'
      ? body.error
      : typeof body?.message === 'string'
        ? body.message
        : `Request failed: ${response.status}`
    const error = new Error(message) as ApiRequestError
    error.status = response.status
    error.body = body
    if (typeof body?.retryAfterSeconds === 'number') {
      error.retryAfterSeconds = body.retryAfterSeconds
    }
    throw error
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function asOptionalString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function asNullableString(value: unknown) {
  return typeof value === 'string' || value === null ? value : undefined
}

function normalizeRole(value: unknown): UserRole {
  return value === 'keeper' ? 'keeper' : 'player'
}

function normalizeVisibility(value: unknown): RoomVisibility {
  return value === 'private' ? 'private' : 'public'
}

function normalizeScriptVisibility(value: unknown): ScriptVisibility {
  return value === 'private' ? 'private' : 'public'
}

function normalizePhase(value: unknown): RoomPhase {
  const phases: RoomPhase[] = ['module_locked', 'module_editing', 'recruiting', 'chargen', 'review', 'casting', 'playing', 'closed']
  return phases.includes(value as RoomPhase) ? (value as RoomPhase) : 'module_locked'
}

function normalizeFriendDirection(value: unknown): FriendSummary['direction'] {
  return value === 'incoming' || value === 'outgoing' || value === 'friend' ? value : 'friend'
}

function normalizeFriendStatus(value: unknown): FriendStatus {
  return value === 'pending' ? 'pending' : 'accepted'
}

function normalizeReplyTo(value: unknown) {
  if (!isRecord(value)) {
    return undefined
  }
  const id = asString(value.id)
  if (!id) {
    return undefined
  }
  return {
    id,
    author: asString(value.author, '未知'),
    text: asString(value.text),
  }
}

function normalizeAccount(value: unknown): Account {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, 'unknown-account'),
    email: asString(record.email),
    displayName: asString(record.displayName, asString(record.email, '用户')),
    avatar: asString(record.avatar),
    role: normalizeRole(record.role),
    createdAt: asString(record.createdAt),
    lastSeenAt: asString(record.lastSeenAt),
  }
}

function normalizeAuthSession(value: unknown): AuthSession {
  const record = isRecord(value) ? value : {}
  return {
    token: asString(record.token),
    account: normalizeAccount(record.account),
  }
}

function normalizeDirectMessage(value: unknown, index = 0): DirectMessage {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, asString(record.clientMessageId, `direct-message-${index}`)),
    clientMessageId: asOptionalString(record.clientMessageId),
    fromId: asString(record.fromId),
    toId: asString(record.toId),
    text: asString(record.text),
    replyTo: normalizeReplyTo(record.replyTo),
    createdAt: asString(record.createdAt),
  }
}

function normalizeFriend(value: unknown): FriendSummary {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, asString(record.email, 'unknown-friend')),
    email: asString(record.email),
    displayName: asString(record.displayName, asString(record.email, '好友')),
    avatar: asString(record.avatar),
    role: normalizeRole(record.role),
    status: normalizeFriendStatus(record.status),
    direction: normalizeFriendDirection(record.direction),
    lastSeenAt: asString(record.lastSeenAt),
    unreadCount: asNumber(record.unreadCount, 0),
    lastReadAt: asOptionalString(record.lastReadAt),
    lastReadMessageId: asOptionalString(record.lastReadMessageId),
    lastMessage: isRecord(record.lastMessage) ? normalizeDirectMessage(record.lastMessage) : undefined,
  }
}

function normalizeMapFeature(value: unknown, index = 0): MapFeature {
  const record = isRecord(value) ? value : {}
  const type = record.type === 'door' || record.type === 'cover' || record.type === 'hazard' ? record.type : 'wall'
  return {
    id: asString(record.id, `feature-${index}`),
    type,
    label: asString(record.label, '地形'),
    x: Math.max(1, Math.round(asNumber(record.x, 1))),
    y: Math.max(1, Math.round(asNumber(record.y, 1))),
    w: Math.max(1, Math.round(asNumber(record.w, 1))),
    h: Math.max(1, Math.round(asNumber(record.h, 1))),
  }
}

function normalizeMapToken(value: unknown, index = 0): MapToken {
  const record = isRecord(value) ? value : {}
  const status = record.status === 'wounded' || record.status === 'hidden' || record.status === 'npc' ? record.status : 'ready'
  return {
    id: asString(record.id, `token-${index}`),
    characterId: asString(record.characterId),
    label: asString(record.label, '棋'),
    color: asString(record.color, '#187a6d'),
    x: Math.max(1, Math.round(asNumber(record.x, 1))),
    y: Math.max(1, Math.round(asNumber(record.y, 1))),
    status,
  }
}

function normalizeScene(value: unknown): SceneState {
  const record = isRecord(value) ? value : {}
  return {
    mapId: asOptionalString(record.mapId),
    name: asString(record.name, '地图'),
    width: Math.max(4, Math.round(asNumber(record.width, 12))),
    height: Math.max(4, Math.round(asNumber(record.height, 8))),
    features: asArray(record.features).map(normalizeMapFeature),
    tokens: asArray(record.tokens).map(normalizeMapToken),
  }
}

function normalizeDiceRoll(value: unknown): DiceRollResult | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const comparator = value.comparator === '<=' || value.comparator === '>=' || value.comparator === '<' || value.comparator === '>' || value.comparator === '='
    ? value.comparator
    : undefined
  const outcome = value.outcome === 'success' || value.outcome === 'failure' ? value.outcome : undefined
  const successLevel = value.successLevel === 'critical' || value.successLevel === 'extreme' || value.successLevel === 'hard' || value.successLevel === 'regular' || value.successLevel === 'failure' || value.successLevel === 'fumble'
    ? value.successLevel
    : undefined
  return {
    formula: asString(value.formula, '1d100'),
    total: asNumber(value.total, 0),
    rolls: asArray(value.rolls).map((roll) => asNumber(roll, 0)),
    modifier: asNumber(value.modifier, 0),
    target: typeof value.target === 'number' ? value.target : undefined,
    comparator,
    outcome,
    successLevel,
    text: asString(value.text),
  }
}

function normalizeChatMessage(value: unknown, index = 0): ChatMessage {
  const record = isRecord(value) ? value : {}
  const messageType = record.messageType === 'dice' ? 'dice' : record.messageType === 'chat' ? 'chat' : undefined
  return {
    id: asString(record.id, asString(record.clientMessageId, `room-message-${index}`)),
    roomId: asOptionalString(record.roomId),
    clientMessageId: asOptionalString(record.clientMessageId),
    senderId: asOptionalString(record.senderId),
    messageType,
    author: asString(record.author, '未知'),
    role: normalizeRole(record.role),
    text: asString(record.text),
    replyTo: normalizeReplyTo(record.replyTo),
    roll: normalizeDiceRoll(record.roll),
    createdAt: asString(record.createdAt),
  }
}

function normalizeRoomMember(value: unknown): RoomMember {
  const record = isRecord(value) ? value : {}
  return {
    accountId: asString(record.accountId),
    displayName: asString(record.displayName, '玩家'),
    avatar: asString(record.avatar),
    role: normalizeRole(record.role),
    joinedAt: asString(record.joinedAt),
    lastSeenAt: asString(record.lastSeenAt),
    leftAt: asOptionalString(record.leftAt),
  }
}

function normalizeScriptCharacter(value: unknown, index = 0): ScriptCharacter {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, `script-character-${index}`),
    name: asString(record.name, '未命名人物'),
    count: Math.max(1, Math.round(asNumber(record.count, 1))),
    parameters: asString(record.parameters),
    story: asString(record.story),
    occupation: asOptionalString(record.occupation),
    publicSummary: asOptionalString(record.publicSummary),
    privateBrief: asOptionalString(record.privateBrief),
    recommendedSkills: asArray(record.recommendedSkills)
      .filter(isRecord)
      .map((skill) => ({ name: asString(skill.name), base: asNumber(skill.base, 0) }))
      .filter((skill) => skill.name),
  }
}

function normalizeDiceProfile(value: unknown, index = 0): DiceProfile {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, `dice-${index}`),
    label: asString(record.label, '默认骰子'),
    formula: asString(record.formula, '1d100'),
    probability: asNumber(record.probability, 0.5),
  }
}

function normalizeRoomPublicContent(value: unknown, index = 0): RoomPublicContent {
  const record = isRecord(value) ? value : {}
  const type = record.type === 'map' || record.type === 'character' || record.type === 'check' ? record.type : 'narrative'
  const source = isRecord(record.source)
    ? {
        scriptId: asOptionalString(record.source.scriptId),
        scriptVersion: typeof record.source.scriptVersion === 'number' ? record.source.scriptVersion : undefined,
        chapterId: asOptionalString(record.source.chapterId),
        blockId: asOptionalString(record.source.blockId),
        mapId: asOptionalString(record.source.mapId),
        characterId: asOptionalString(record.source.characterId),
        diceId: asOptionalString(record.source.diceId),
      }
    : undefined
  return {
    id: asString(record.id, `public-content-${index}`),
    type,
    title: asString(record.title, '公开内容'),
    markdown: asString(record.markdown),
    source,
    createdBy: asString(record.createdBy),
    createdByName: asString(record.createdByName, 'KP'),
    createdAt: asString(record.createdAt),
  }
}

function normalizeRoomProgress(value: unknown): RoomProgress {
  const record = isRecord(value) ? value : {}
  return {
    scriptId: asOptionalString(record.scriptId),
    scriptVersion: typeof record.scriptVersion === 'number' ? record.scriptVersion : undefined,
    currentChapterId: asOptionalString(record.currentChapterId),
    currentBlockId: asOptionalString(record.currentBlockId),
    currentParagraphIndex: typeof record.currentParagraphIndex === 'number' ? record.currentParagraphIndex : undefined,
    activeMapId: asOptionalString(record.activeMapId),
    updatedBy: asOptionalString(record.updatedBy),
    updatedAt: asOptionalString(record.updatedAt),
  }
}

function normalizeCoc7Attributes(value: unknown): Coc7Attributes {
  const record = isRecord(value) ? value : {}
  return {
    str: asNumber(record.str, 50),
    con: asNumber(record.con, 50),
    siz: asNumber(record.siz, 50),
    dex: asNumber(record.dex, 50),
    app: asNumber(record.app, 50),
    int: asNumber(record.int, 50),
    pow: asNumber(record.pow, 50),
    edu: asNumber(record.edu, 50),
    luck: asNumber(record.luck, 50),
  }
}

function normalizeCoc7Derived(value: unknown): Coc7Derived {
  const record = isRecord(value) ? value : {}
  return {
    hp: asNumber(record.hp, 10),
    maxHp: asNumber(record.maxHp, 10),
    mp: asNumber(record.mp, 10),
    maxMp: asNumber(record.maxMp, 10),
    san: asNumber(record.san, 50),
    maxSan: asNumber(record.maxSan, 50),
    mov: asNumber(record.mov, 8),
    db: asString(record.db, '0'),
    build: asNumber(record.build, 0),
  }
}

function normalizeCoc7Skill(value: unknown, index = 0): Coc7SkillPoint {
  const record = isRecord(value) ? value : {}
  return {
    key: asString(record.key, `skill-${index}`),
    name: asString(record.name, '技能'),
    base: asNumber(record.base, 0),
    occupation: asNumber(record.occupation, 0),
    interest: asNumber(record.interest, 0),
    growth: asNumber(record.growth, 0),
  }
}

function normalizeCoc7Background(value: unknown): Coc7Background {
  const record = isRecord(value) ? value : {}
  return {
    description: asString(record.description),
    ideology: asString(record.ideology),
    significantPeople: asString(record.significantPeople),
    locations: asString(record.locations),
    possessions: asString(record.possessions),
    traits: asString(record.traits),
  }
}

function normalizeCharacterSheet(value: unknown, index = 0): CharacterSheet {
  const record = isRecord(value) ? value : {}
  const status = record.status === 'submitted' || record.status === 'approved' || record.status === 'rejected' ? record.status : 'draft'
  return {
    id: asString(record.id, `sheet-${index}`),
    ownerId: asString(record.ownerId),
    ownerName: asString(record.ownerName, '玩家'),
    scriptCharacterId: asOptionalString(record.scriptCharacterId),
    status,
    name: asString(record.name, '未命名角色'),
    occupation: asString(record.occupation),
    age: asNumber(record.age, 30),
    sex: asString(record.sex),
    residence: asString(record.residence),
    birthplace: asString(record.birthplace),
    attributes: normalizeCoc7Attributes(record.attributes),
    derived: normalizeCoc7Derived(record.derived),
    skills: asArray(record.skills).map(normalizeCoc7Skill),
    background: normalizeCoc7Background(record.background),
    reviewerNotes: asOptionalString(record.reviewerNotes),
    reviewedAt: asOptionalString(record.reviewedAt),
    reviewedBy: asOptionalString(record.reviewedBy),
    confirmedAt: asOptionalString(record.confirmedAt),
    createdAt: asString(record.createdAt),
    updatedAt: asString(record.updatedAt),
  }
}

function normalizeCharacter(value: unknown, index = 0): Character {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, `character-${index}`),
    accountId: asOptionalString(record.accountId),
    sheetId: asOptionalString(record.sheetId),
    scriptCharacterId: asOptionalString(record.scriptCharacterId),
    name: asString(record.name, '未命名角色'),
    player: asString(record.player, '玩家'),
    avatar: asString(record.avatar),
    hp: asNumber(record.hp, 10),
    maxHp: asNumber(record.maxHp, 10),
    sanity: asNumber(record.sanity, 50),
    maxSanity: asNumber(record.maxSanity, 50),
    initiative: asNumber(record.initiative, 50),
    tags: asArray(record.tags).map((tag) => asString(tag)).filter(Boolean),
    notes: asString(record.notes),
    statBlock: isRecord(record.statBlock)
      ? {
          ...normalizeCoc7Derived(record.statBlock),
          accountId: asString(record.statBlock.accountId),
          attributes: normalizeCoc7Attributes(record.statBlock.attributes),
          skills: isRecord(record.statBlock.skills) ? Object.fromEntries(Object.entries(record.statBlock.skills).map(([key, value]) => [key, asNumber(value, 0)])) : {},
          skillNames: isRecord(record.statBlock.skillNames) ? Object.fromEntries(Object.entries(record.statBlock.skillNames).map(([key, value]) => [key, asString(value)])) : {},
        }
      : undefined,
  }
}

function normalizeVoiceParticipant(value: unknown, index = 0): VoiceParticipant {
  const record = isRecord(value) ? value : {}
  const quality = record.quality === 'excellent' || record.quality === 'good' || record.quality === 'relay' ? record.quality : 'offline'
  return {
    id: asString(record.id, `voice-${index}`),
    name: asString(record.name, '玩家'),
    muted: asBoolean(record.muted),
    speaking: asBoolean(record.speaking),
    quality,
  }
}

function normalizeScriptMap(value: unknown, index = 0): ScriptMap {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, `map-${index}`),
    name: asString(record.name, '未命名地图'),
    width: Math.max(4, Math.round(asNumber(record.width, 12))),
    height: Math.max(4, Math.round(asNumber(record.height, 8))),
    notes: asString(record.notes),
    features: asArray(record.features).map(normalizeMapFeature),
    tokens: asArray(record.tokens).map(normalizeMapToken),
  }
}

function normalizeScriptBlock(value: unknown, index = 0): ScriptBlock {
  const record = isRecord(value) ? value : {}
  const id = asString(record.id, `block-${index}`)
  const title = asString(record.title, '未命名内容')
  if (record.type === 'map') {
    return { id, type: 'map', title, mapId: asString(record.mapId), notes: asString(record.notes) }
  }
  if (record.type === 'character') {
    return { id, type: 'character', title, characterId: asString(record.characterId), notes: asString(record.notes) }
  }
  if (record.type === 'check') {
    return {
      id,
      type: 'check',
      title,
      diceId: asString(record.diceId),
      difficulty: asNumber(record.difficulty, 50),
      onPass: asString(record.onPass),
      onFail: asString(record.onFail),
    }
  }
  return { id, type: 'narrative', title, markdown: asString(record.markdown) }
}

function normalizeScriptChapter(value: unknown, index = 0): ScriptChapter {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, `chapter-${index}`),
    title: asString(record.title, '未命名章节'),
    blocks: asArray(record.blocks).map(normalizeScriptBlock),
  }
}

function normalizeScriptSummary(value: unknown): TrpgScriptSummary {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, 'unknown-script'),
    title: asString(record.title, '未命名剧本'),
    system: asString(record.system, 'COC 7th'),
    visibility: normalizeScriptVisibility(record.visibility),
    ownerId: asString(record.ownerId),
    ownerName: asString(record.ownerName, '未知作者'),
    summary: asString(record.summary),
    tags: asArray(record.tags).map((tag) => asString(tag)).filter(Boolean),
    updatedAt: asString(record.updatedAt),
    version: asNumber(record.version, 1),
    canEdit: asBoolean(record.canEdit),
  }
}

function normalizeScript(value: unknown): TrpgScript {
  const record = isRecord(value) ? value : {}
  return {
    ...normalizeScriptSummary(record),
    coverUrl: asString(record.coverUrl),
    maps: asArray(record.maps).map(normalizeScriptMap),
    characters: asArray(record.characters).map(normalizeScriptCharacter),
    diceProfiles: asArray(record.diceProfiles).map(normalizeDiceProfile),
    chapters: asArray(record.chapters).map(normalizeScriptChapter),
    createdAt: asString(record.createdAt),
  }
}

function normalizeRoomSummary(value: unknown): RoomSummary {
  const record = isRecord(value) ? value : {}
  return {
    id: asString(record.id, 'unknown-room'),
    name: asString(record.name, '未命名房间'),
    system: asString(record.system, 'COC 7th'),
    phase: normalizePhase(record.phase),
    visibility: normalizeVisibility(record.visibility),
    ownerId: asString(record.ownerId),
    ownerName: asString(record.ownerName, '未知房主'),
    players: asNumber(record.players, 0),
    updatedAt: asString(record.updatedAt),
    scriptId: asOptionalString(record.scriptId),
    summary: asString(record.summary),
    scriptCharacterPreviews: asArray(record.scriptCharacterPreviews).map((preview, index) => {
      const item = isRecord(preview) ? preview : {}
      return {
        id: asString(item.id, `preview-${index}`),
        name: asString(item.name, '未命名人设'),
        count: Math.max(1, Math.round(asNumber(item.count, 1))),
        occupation: asOptionalString(item.occupation),
        publicSummary: asString(item.publicSummary),
      }
    }),
    online: asBoolean(record.online, true),
    closedAt: asNullableString(record.closedAt),
    closeAt: asNullableString(record.closeAt),
    canJoin: asBoolean(record.canJoin, true),
  }
}

function normalizeRoomState(value: unknown): RoomState {
  const record = isRecord(value) ? value : {}
  const summary = normalizeRoomSummary(record)
  const voice = isRecord(record.voice) ? record.voice : {}
  return {
    ...summary,
    keeper: asString(record.keeper, summary.ownerName),
    memberIds: asArray(record.memberIds).map((id) => asString(id)).filter(Boolean),
    members: asArray(record.members).map(normalizeRoomMember),
    participantIds: asArray(record.participantIds).map((id) => asString(id)).filter(Boolean),
    participants: asArray(record.participants).map(normalizeRoomMember),
    rosterIds: asArray(record.rosterIds).map((id) => asString(id)).filter(Boolean),
    roster: asArray(record.roster).map(normalizeRoomMember),
    rosterHistoryIds: asArray(record.rosterHistoryIds).map((id) => asString(id)).filter(Boolean),
    invitedAccountIds: asArray(record.invitedAccountIds).map((id) => asString(id)).filter(Boolean),
    scene: normalizeScene(record.scene),
    scriptSnapshot: isRecord(record.scriptSnapshot) ? normalizeScript(record.scriptSnapshot) : undefined,
    scriptCharacters: asArray(record.scriptCharacters).map(normalizeScriptCharacter),
    diceProfiles: asArray(record.diceProfiles).map(normalizeDiceProfile),
    progress: normalizeRoomProgress(record.progress),
    publicContent: asArray(record.publicContent).map(normalizeRoomPublicContent),
    characterSheets: asArray(record.characterSheets).map(normalizeCharacterSheet),
    characters: asArray(record.characters).map(normalizeCharacter),
    messages: asArray(record.messages).map(normalizeChatMessage),
    voice: {
      epoch: asOptionalString(voice.epoch),
      livekitConfigured: asBoolean(voice.livekitConfigured),
      participants: asArray(voice.participants).map(normalizeVoiceParticipant),
    },
  }
}

function normalizeDiceRollResponse(value: unknown): DiceRollResponse {
  const record = isRecord(value) ? value : {}
  return {
    message: normalizeChatMessage(record.message),
    roll: normalizeDiceRoll(record.roll) ?? {
      formula: '1d100',
      total: 0,
      rolls: [],
      modifier: 0,
      text: '',
    },
  }
}

export async function registerAccount(input: {
  email: string
  displayName: string
  password: string
  verificationCode: string
  avatar?: string
}) {
  return normalizeAuthSession(await request<unknown>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  }))
}

export async function requestRegistrationCode(email: string) {
  return request<{ ok: true; expiresInSeconds: number; cooldownSeconds: number; debugCode?: string }>(
    '/api/auth/verification-code',
    {
      method: 'POST',
      body: JSON.stringify({ email }),
    },
  )
}

export async function requestPasswordResetCode(email: string) {
  return request<{ ok: true; expiresInSeconds: number; cooldownSeconds: number; debugCode?: string }>(
    '/api/auth/password-reset-code',
    {
      method: 'POST',
      body: JSON.stringify({ email }),
    },
  )
}

export async function resetPassword(input: { email: string; password: string; verificationCode: string }) {
  return request<void>('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function loginAccount(input: { email: string; password: string }) {
  return normalizeAuthSession(await request<unknown>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  }))
}

export async function loadAccountSession(token: string) {
  return normalizeAccount(await request<unknown>('/api/auth/session', {
    headers: authHeaders(token),
  }))
}

export async function logoutAccount(token: string) {
  return request<void>('/api/auth/logout', {
    method: 'POST',
    headers: authHeaders(token),
  })
}

export async function updateProfile(
  token: string,
  input: { displayName?: string; avatar?: string; password?: string; currentPassword?: string },
) {
  return normalizeAccount(await request<unknown>('/api/profile', {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(input),
  }))
}

export async function loadFriends(token: string) {
  return asArray(await request<unknown>('/api/friends', {
    headers: authHeaders(token),
  })).map(normalizeFriend)
}

export async function requestFriend(token: string, email: string) {
  return normalizeFriend(await request<unknown>('/api/friends', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ email }),
  }))
}

export async function acceptFriend(token: string, friendId: string) {
  return normalizeFriend(await request<unknown>(`/api/friends/${friendId}/accept`, {
    method: 'POST',
    headers: authHeaders(token),
  }))
}

export async function removeFriend(token: string, friendId: string) {
  return request<void>(`/api/friends/${friendId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
}

export async function loadDirectMessages(
  token: string,
  friendId: string,
  options: { limit?: number; before?: string } = {},
) {
  const search = new URLSearchParams()
  if (options.limit) {
    search.set('limit', String(options.limit))
  }
  if (options.before) {
    search.set('before', options.before)
  }
  const query = search.toString()
  const result = await request<unknown>(
    `/api/friends/${friendId}/messages${query ? `?${query}` : '?limit=20'}`,
    {
      headers: authHeaders(token),
    },
  )
  if (Array.isArray(result)) {
    const limit = options.limit ?? 20
    const messages = result.slice(-limit).map(normalizeDirectMessage)
    return {
      messages,
      hasMore: result.length > messages.length,
      nextBefore: messages[0]?.id,
    }
  }
  const page = isRecord(result) ? result : {}
  return {
    messages: asArray(page.messages).map(normalizeDirectMessage),
    hasMore: Boolean(page.hasMore),
  }
}

export async function markDirectMessagesRead(token: string, friendId: string, lastReadMessageId?: string) {
  return normalizeFriend(await request<unknown>(`/api/friends/${friendId}/messages/read`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ lastReadMessageId }),
  }))
}

export async function sendDirectMessage(
  token: string,
  friendId: string,
  text: string,
  options: { clientMessageId?: string; replyToId?: string } = {},
) {
  return normalizeDirectMessage(await request<unknown>(`/api/friends/${friendId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text, ...options }),
  }))
}

export async function loadRooms(token: string, status: 'online' | 'closed' = 'online'): Promise<RoomSummary[]> {
  const query = status === 'closed' ? '?status=closed' : ''
  return asArray(await request<unknown>(`/api/rooms${query}`, {
    headers: authHeaders(token),
  })).map(normalizeRoomSummary)
}

export async function loadRoom(roomId: string, token: string): Promise<RoomState> {
  return normalizeRoomState(await request<unknown>(`/api/rooms/${roomId}`, {
    headers: authHeaders(token),
  }))
}

export async function joinRoom(
  roomId: string,
  token: string,
  role: UserRole,
  options: { resume?: boolean } = {},
): Promise<RoomState> {
  return normalizeRoomState(await request<unknown>(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ resume: options.resume, role }),
  }))
}

export async function inviteRoomFriend(roomId: string, token: string, friendId: string): Promise<RoomState> {
  return normalizeRoomState(await request<unknown>(`/api/rooms/${roomId}/invitations`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ friendId }),
  }))
}

export async function leaveRoom(roomId: string, token: string): Promise<void> {
  return request<void>(`/api/rooms/${roomId}/leave`, {
    method: 'POST',
    headers: authHeaders(token),
  })
}

export async function closeRoom(roomId: string, token: string): Promise<RoomState> {
  return normalizeRoomState(await request<unknown>(`/api/rooms/${roomId}/close`, {
    method: 'POST',
    headers: authHeaders(token),
  }))
}

export async function deleteRoom(roomId: string, token: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/rooms/${roomId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
}

export async function createRoom(
  token: string,
  input: { name: string; system?: string; visibility: RoomVisibility; scriptId?: string },
): Promise<RoomState> {
  return normalizeRoomState(await request<unknown>('/api/rooms', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(input),
  }))
}

export async function sendChatMessage(
  token: string,
  roomId: string,
  text: string,
  options: { replyToId?: string; clientMessageId?: string } = {},
) {
  return normalizeChatMessage(await request<unknown>(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text, ...options }),
  }))
}

export async function loadRoomMessages(
  token: string,
  roomId: string,
  options: { limit?: number; before?: string } = {},
) {
  const search = new URLSearchParams()
  search.set('limit', String(options.limit ?? 20))
  if (options.before) {
    search.set('before', options.before)
  }
  const result = await request<unknown>(`/api/rooms/${roomId}/messages?${search.toString()}`, {
    headers: authHeaders(token),
  })
  const page = isRecord(result) ? result : {}
  return {
    messages: asArray(page.messages).map(normalizeChatMessage),
    hasMore: Boolean(page.hasMore),
  }
}

export async function saveCharacter(token: string, roomId: string, character: Character) {
  return normalizeCharacter(await request<unknown>(`/api/rooms/${roomId}/characters/${character.id}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(character),
  }))
}

export async function moveRoomToken(token: string, roomId: string, tokenId: string, x: number, y: number) {
  return normalizeMapToken(await request<unknown>(`/api/rooms/${roomId}/tokens/move`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ tokenId, x, y }),
  }))
}

export async function rollDiceOnServer(
  token: string,
  roomId: string,
  formula: string,
  options: { replyToId?: string; clientMessageId?: string; diceId?: string } = {},
) {
  return normalizeDiceRollResponse(await request<unknown>(`/api/rooms/${roomId}/dice/roll`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ formula, ...options }),
  }))
}

export async function updateRoomPhase(token: string, roomId: string, phase: RoomPhase) {
  return normalizeRoomState(await request<unknown>(`/api/rooms/${roomId}/phase`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ phase }),
  }))
}

export async function updateRoomPreparation(
  token: string,
  roomId: string,
  input: { summary?: string; scriptCharacters?: ScriptCharacter[] },
) {
  return normalizeRoomState(await request<unknown>(`/api/rooms/${roomId}/preparation`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(input),
  }))
}

export async function revealRoomScriptBlock(
  token: string,
  roomId: string,
  input: { chapterId: string; blockId: string },
) {
  return normalizeRoomState(await request<unknown>(`/api/rooms/${roomId}/script-blocks/reveal`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(input),
  }))
}

export async function switchRoomScriptMap(token: string, roomId: string, mapId: string) {
  return normalizeRoomState(await request<unknown>(`/api/rooms/${roomId}/script-map`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ mapId }),
  }))
}

export async function saveCharacterSheet(token: string, roomId: string, sheet: Partial<CharacterSheet>) {
  const result = await request<unknown>(
    `/api/rooms/${roomId}/character-sheets/me`,
    {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify(sheet),
    },
  )
  const record = isRecord(result) ? result : {}
  const validation = isRecord(record.validation) ? record.validation : {}
  return {
    sheet: normalizeCharacterSheet(record.sheet),
    room: normalizeRoomState(record.room),
    validation: {
      ok: asBoolean(validation.ok),
      errors: asArray(validation.errors).map((error) => asString(error)).filter(Boolean),
    },
  }
}

export async function submitCharacterSheet(token: string, roomId: string, sheet: Partial<CharacterSheet>) {
  const result = await request<unknown>(
    `/api/rooms/${roomId}/character-sheets/me/submit`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(sheet),
    },
  )
  const record = isRecord(result) ? result : {}
  const validation = isRecord(record.validation) ? record.validation : {}
  return {
    sheet: normalizeCharacterSheet(record.sheet),
    room: normalizeRoomState(record.room),
    validation: {
      ok: asBoolean(validation.ok),
      errors: asArray(validation.errors).map((error) => asString(error)).filter(Boolean),
    },
  }
}

export async function confirmCharacterSheet(token: string, roomId: string) {
  const result = await request<unknown>(
    `/api/rooms/${roomId}/character-sheets/me/confirm`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  )
  const record = isRecord(result) ? result : {}
  return {
    sheet: normalizeCharacterSheet(record.sheet),
    room: normalizeRoomState(record.room),
  }
}

export async function reviewCharacterSheet(
  token: string,
  roomId: string,
  sheetId: string,
  input: { status: 'approved' | 'rejected'; reviewerNotes?: string },
) {
  const result = await request<unknown>(
    `/api/rooms/${roomId}/character-sheets/${sheetId}/review`,
    {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(input),
    },
  )
  const record = isRecord(result) ? result : {}
  const validation = isRecord(record.validation) ? record.validation : {}
  return {
    sheet: normalizeCharacterSheet(record.sheet),
    room: normalizeRoomState(record.room),
    validation: {
      ok: asBoolean(validation.ok),
      errors: asArray(validation.errors).map((error) => asString(error)).filter(Boolean),
    },
  }
}

export async function importApprovedCharacterSheets(token: string, roomId: string) {
  return normalizeRoomState(await request<unknown>(`/api/rooms/${roomId}/character-sheets/import-approved`, {
    method: 'POST',
    headers: authHeaders(token),
  }))
}

export async function loadScripts(token: string): Promise<TrpgScriptSummary[]> {
  return asArray(await request<unknown>('/api/scripts', {
    headers: authHeaders(token),
  })).map(normalizeScriptSummary)
}

export async function loadScript(scriptId: string, token: string): Promise<TrpgScript> {
  return normalizeScript(await request<unknown>(`/api/scripts/${scriptId}`, {
    headers: authHeaders(token),
  }))
}

export async function createScript(token: string, script: Partial<TrpgScript> & { title: string }) {
  return normalizeScript(await request<unknown>('/api/scripts', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(script),
  }))
}

export async function updateScript(token: string, scriptId: string, script: Partial<TrpgScript> & Pick<TrpgScript, 'version'>) {
  return normalizeScript(await request<unknown>(`/api/scripts/${scriptId}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(script),
  }))
}

export async function deleteScript(token: string, scriptId: string) {
  return request<void>(`/api/scripts/${scriptId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
}

export async function importScript(token: string, input: { title: string; system?: string; rawText: string }) {
  return normalizeScript(await request<unknown>('/api/scripts/import', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(input),
  }))
}

export async function requestVoiceToken(token: string, roomId: string, voiceSessionId?: string) {
  return request<VoiceTokenResponse>('/api/livekit/token', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ roomId, voiceSessionId }),
  })
}

export async function requestDirectVoiceToken(token: string, friendId: string, callId: string, voiceSessionId?: string) {
  return request<VoiceTokenResponse>('/api/livekit/direct-token', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ friendId, callId, voiceSessionId }),
  })
}

export async function confirmDirectVoiceReady(token: string, friendId: string, callId: string) {
  return request<{ ok: true; changedRoomIds: string[] }>('/api/livekit/direct-ready', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ friendId, callId }),
  })
}
