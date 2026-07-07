import {
  Activity,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  AudioLines,
  BookOpen,
  ChevronRight,
  Check,
  Clock,
  CirclePlus,
  Dice5,
  DoorOpen,
  Eye,
  EyeOff,
  Home,
  Image as ImageIcon,
  Lock,
  LogIn,
  LogOut,
  ListTree,
  Map,
  MessageCircle,
  Mic,
  MicOff,
  Move,
  PanelLeftClose,
  PanelLeftOpen,
  PhoneCall,
  PhoneOff,
  Radio,
  Save,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Smile,
  Trash2,
  Unlock,
  Upload,
  User,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ErrorInfo, PointerEvent, ReactNode, SetStateAction } from 'react'
import type { RemoteAudioTrack, RemoteTrack, Room as LiveKitRoom } from 'livekit-client'
import { io, type Socket } from 'socket.io-client'
import './App.css'
import {
  acceptFriend,
  closeRoom,
  confirmDirectVoiceReady,
  createRoom,
  createScript,
  deleteRoom,
  deleteScript,
  importScript,
  importApprovedCharacterSheets,
  inviteRoomFriend,
  joinRoom,
  leaveRoom,
  markDirectMessagesRead,
  defaultApiBase,
  getApiBase,
  loadDirectMessages,
  loadAccountSession,
  loadFriends,
  loadRoom,
  loadRoomMessages,
  loadRooms,
  loadScript,
  loadScripts,
  loginAccount,
  logoutAccount,
  moveRoomToken,
  registerAccount,
  revealRoomScriptBlock,
  requestPasswordResetCode,
  resetApiBase,
  resetPassword,
  removeFriend,
  requestFriend,
  requestDirectVoiceToken,
  requestRegistrationCode,
  requestVoiceToken,
  rollDiceOnServer,
  saveCharacter,
  saveCharacterSheet,
  confirmCharacterSheet,
  sendDirectMessage,
  sendChatMessage,
  setApiBase,
  reviewCharacterSheet,
  submitCharacterSheet,
  switchRoomScriptMap,
  updateProfile,
  updateRoomPreparation,
  updateRoomPhase,
  updateScript,
} from './api'
import type { ApiRequestError } from './api'
import { estimateOpusRoomKbps, formatClock, moveToken, updateCharacterVitals } from './domain'
import type {
  Account,
  Character,
  CharacterSheet,
  CharacterSheetStatus,
  ChatMessage,
  Coc7Attributes,
  DirectMessage,
  DirectCallEvent,
  DiceProfile,
  DiceRollResponse,
  FriendSummary,
  MapFeature,
  MapToken,
  RoomState,
  RoomSummary,
  RoomPhase,
  RoomVisibility,
  ScriptCharacter,
  ScriptChapter,
  ScriptBlock,
  ScriptMap,
  TrpgScript,
  TrpgScriptSummary,
  UserRole,
  VoiceParticipant,
  VoiceStateEvent,
  VoiceTokenResponse,
} from './types'

type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'demo' | 'error'
type DirectCallActionName = 'direct-call:invite' | 'direct-call:accept' | 'direct-call:reject' | 'direct-call:end'
type DirectCallActionHandler = (eventName: DirectCallActionName, friendId: string, callId?: string) => Promise<void>
type AuthMode = 'login' | 'register' | 'reset'
type MainPage = 'lobby' | 'chat' | 'scripts' | 'account' | 'room'
type RoomTab = 'flow' | 'map' | 'chat' | 'characters' | 'voice'
type ScriptEditorView = 'overview' | 'maps' | 'characters' | 'dice' | 'chapters'
type AccountTab = 'friends'
type RoomMessageToast = ChatMessage & { toastId: string }
type ScriptConflictState = {
  current: TrpgScript
  currentVersion: number
}
type FloatingRoomPosition = { x: number; y: number }
type StoredActiveRoom = {
  accountId: string
  minimized: boolean
  role: UserRole
  roomId: string
}

type KeyedState<T> = {
  key: string
  value: T
}

type PendingTokenMutation = {
  roomId: string
  seq: number
  x: number
  y: number
}

type PendingCharacterMutation = {
  hp: number
  roomId: string
  sanity: number
  seq: number
}

type PendingRoomMessageRetry = {
  clientMessageId: string
  replyToId?: string
  roomId: string
  text: string
}

type PendingRoomDiceRetry = {
  clientMessageId: string
  diceId?: string
  formula: string
  replyToId?: string
  roomId: string
}

type PendingDirectMessageRetry = {
  clientMessageId: string
  friendId: string
  replyTo?: DirectMessage['replyTo']
  replyToId?: string
  text: string
}

type ConfirmedRoomMessageSignal = {
  clientMessageId: string
  kind: 'chat' | 'dice'
  replyToId?: string
  roomId: string
  seq: number
}

type NativeBackHandler = () => boolean

declare global {
  interface Window {
    __PAOTUAN_DISABLE_REALTIME__?: boolean
    __PAOTUAN_HANDLE_NATIVE_BACK__?: () => boolean
  }
}

const authStorageKey = 'paotuan.session'
const activeRoomStorageKey = 'paotuan.activeRoom'
const voiceVolumeStorageKey = 'paotuan.voiceVolumes'
const quickDice = ['1d100<=50', '1d100<=70', '1d20>=10', '2d6>=7']
const roomStateMessageLimit = 50
const maxRoomClientMessages = 500
const nativeBackHandlers: Array<{ handler: NativeBackHandler; order: number; priority: number }> = []
let nativeBackHandlerOrder = 0

function runNativeBackHandlers() {
  return [...nativeBackHandlers]
    .sort((a, b) => b.priority - a.priority || b.order - a.order)
    .some((entry) => {
      try {
        return entry.handler()
      } catch {
        return false
      }
    })
}

function useNativeBackHandler(handler: NativeBackHandler, priority = 0) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    const entry = {
      handler: () => handlerRef.current(),
      order: nativeBackHandlerOrder += 1,
      priority,
    }
    nativeBackHandlers.push(entry)
    return () => {
      const index = nativeBackHandlers.indexOf(entry)
      if (index >= 0) {
        nativeBackHandlers.splice(index, 1)
      }
    }
  }, [priority])
}

class ViewErrorBoundary extends Component<
  { children: ReactNode; onBack: () => void; resetKey: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(previousProps: { resetKey: string }) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Paotuan view crashed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <section className="view-error-panel" role="alert">
        <h2>当前页面加载异常</h2>
        <p>页面数据临时不可用，已阻止白屏。可以回到大厅后重新进入。</p>
        <div>
          <button type="button" onClick={() => this.setState({ error: null })}>
            重试
          </button>
          <button type="button" onClick={this.props.onBack}>
            返回大厅
          </button>
        </div>
        <small>{this.state.error.message}</small>
      </section>
    )
  }
}

function LoadingPanel({
  actionLabel,
  message,
  onAction,
  title,
}: {
  actionLabel?: string
  message?: string
  onAction?: () => void
  title: string
}) {
  return (
    <main className="loading loading-shell">
      <section className="loading-panel">
        <strong>{title}</strong>
        {message && <p>{message}</p>}
        {actionLabel && onAction && (
          <button type="button" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </section>
    </main>
  )
}

function defaultRoomTabFor(room: RoomState): RoomTab {
  return room.phase !== 'closed' ? 'flow' : 'map'
}

function defaultFloatingRoomPosition(): FloatingRoomPosition {
  if (typeof window === 'undefined') {
    return { x: 18, y: 86 }
  }
  return {
    x: 18,
    y: Math.max(86, window.innerHeight - 150),
  }
}

function describeError(error: unknown, fallback = '请求失败') {
  if (typeof error === 'string') {
    return error
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (error && typeof error === 'object') {
    const maybeError = 'error' in error ? (error as { error?: unknown }).error : undefined
    if (typeof maybeError === 'string') {
      return maybeError
    }
  }
  return fallback
}

function retryAfterSecondsFrom(error: unknown) {
  if (!error || typeof error !== 'object') {
    return 0
  }
  const retryAfterSeconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
  return typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
    ? Math.max(1, Math.ceil(retryAfterSeconds))
    : 0
}

function formatErrorWithRetry(error: unknown, fallback = '请求失败') {
  const message = describeError(error, fallback)
  const retryAfterSeconds = retryAfterSecondsFrom(error)
  return retryAfterSeconds > 0 ? `${message}，请 ${retryAfterSeconds} 秒后再试。` : message
}

function cooldownUntilFrom(error: unknown) {
  const retryAfterSeconds = retryAfterSecondsFrom(error)
  return retryAfterSeconds > 0 ? Date.now() + retryAfterSeconds * 1000 : 0
}

function remainingCooldownSeconds(cooldownUntil: number) {
  return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))
}

function scriptConflictFromError(error: unknown): ScriptConflictState | null {
  const requestError = error as ApiRequestError
  const body = requestError.body
  if (requestError.status !== 409 || !body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const conflictBody = body as { current?: unknown; currentVersion?: unknown }
  const current = conflictBody.current
  if (
    !current ||
    typeof current !== 'object' ||
    Array.isArray(current) ||
    typeof conflictBody.currentVersion !== 'number'
  ) {
    return null
  }
  const script = current as Partial<TrpgScript>
  if (typeof script.id !== 'string' || typeof script.title !== 'string' || typeof script.version !== 'number') {
    return null
  }
  return { current: script as TrpgScript, currentVersion: conflictBody.currentVersion }
}

function normalizeDiceFormula(value: string) {
  const trimmed = value
    .trim()
    .replace(/[≤≦]/g, '<=')
    .replace(/[≥≧]/g, '>=')
    .replace(/[＝]/g, '=')
    .replace(/[＋]/g, '+')
    .replace(/[－]/g, '-')

  if (/^\.ra\s+/i.test(trimmed)) {
    return trimmed.replace(/\s+/, ' ')
  }

  return trimmed
    .replace(/^[./。]r\s+/i, '')
    .toLowerCase()
    .replace(/\s+/g, '')
}

function isDiceFormulaSupported(value: string) {
  const trimmed = value.trim()
  return (
    /^\.ra\s+\S+/i.test(trimmed) ||
    /^(\d{0,2})d(\d{1,4})([+-]\d{1,4})?(?:(<=|>=|<|>|=)\d{1,5})?$/.test(normalizeDiceFormula(trimmed))
  )
}

function invalidScriptDiceProfiles(script: Pick<TrpgScript, 'diceProfiles'>) {
  return script.diceProfiles.filter((dice) => !isDiceFormulaSupported(dice.formula))
}

type ApiUiError = Error & { status?: number; retryAfterSeconds?: number }
type SocketAck<T> = { ok: true; data: T } | { ok: false; error: unknown; retryAfterSeconds?: number }
type RoomVoiceJoinAck = { ok: true; room: RoomState } | { ok: false; error: unknown }

function emitSocketAck<T>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMessage: string,
): Promise<SocketAck<T>> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      resolve({ ok: false, error: timeoutMessage })
    }, 7000)
    socket.emit(event, payload, (ack: SocketAck<T>) => {
      window.clearTimeout(timer)
      resolve(ack)
    })
  })
}

function emitRoomVoiceJoin(socket: Socket | null, payload: unknown): Promise<RoomVoiceJoinAck> {
  if (!socket?.connected) {
    return Promise.resolve({ ok: false, error: '语音信令未连接' })
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      resolve({ ok: false, error: '加入语音频道超时' })
    }, 7000)
    socket.emit('voice:join', payload, (ack: RoomVoiceJoinAck) => {
      window.clearTimeout(timer)
      resolve(ack)
    })
  })
}

function isSocketTimeout(error: unknown) {
  return typeof error === 'string' && error.includes('超时')
}

const roleLabel: Record<UserRole, string> = {
  keeper: '守秘人',
  player: '玩家',
}

const roomPhaseLabel: Record<RoomPhase, string> = {
  module_locked: '模组确认',
  module_editing: '模组编辑',
  recruiting: '招募PL',
  chargen: 'PL车卡',
  review: 'KP审核',
  casting: '选角导入',
  playing: '跑团中',
  closed: '已关闭',
}

const characterSheetStatusLabel: Record<CharacterSheetStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  approved: '已通过',
  rejected: '需修改',
}

function characterSheetFlowLabel(sheet: CharacterSheet) {
  return sheet.status === 'approved' && !sheet.confirmedAt ? '已通过，待玩家确认' : characterSheetStatusLabel[sheet.status]
}

const flowPhaseOrder: RoomPhase[] = ['module_locked', 'module_editing', 'recruiting', 'chargen', 'review', 'casting', 'playing']

const coc7OccupationProfiles = [
  {
    key: 'journalist',
    name: '记者',
    formula: 'edu*4',
    crMin: 9,
    crMax: 30,
    skills: ['spotHidden', 'libraryUse', 'persuade', 'psychology', 'nativeLanguage', 'creditRating'],
  },
  {
    key: 'doctor',
    name: '医生',
    formula: 'edu*4',
    crMin: 30,
    crMax: 80,
    skills: ['firstAid', 'medicine', 'psychology', 'persuade', 'libraryUse', 'nativeLanguage', 'creditRating'],
  },
  {
    key: 'privateInvestigator',
    name: '私家侦探',
    formula: 'edu*2+dex*2',
    crMin: 9,
    crMax: 30,
    skills: ['spotHidden', 'listen', 'libraryUse', 'stealth', 'psychology', 'persuade', 'fighting', 'firearms', 'creditRating'],
  },
  {
    key: 'professor',
    name: '教授',
    formula: 'edu*4',
    crMin: 20,
    crMax: 70,
    skills: ['libraryUse', 'nativeLanguage', 'psychology', 'persuade', 'occult', 'creditRating'],
  },
  {
    key: 'police',
    name: '警察',
    formula: 'edu*2+dex*2',
    crMin: 9,
    crMax: 30,
    skills: ['fighting', 'firearms', 'firstAid', 'persuade', 'psychology', 'spotHidden', 'listen', 'creditRating'],
  },
] as const

const coc7OccupationOptions = coc7OccupationProfiles.map((profile) => profile.name)
const coc7SkillTemplates = [
  { key: 'spotHidden', name: '侦查', base: 25 },
  { key: 'listen', name: '聆听', base: 20 },
  { key: 'libraryUse', name: '图书馆使用', base: 20 },
  { key: 'dodge', name: '闪避', base: 25 },
  { key: 'creditRating', name: '信用评级', base: 0 },
  { key: 'persuade', name: '说服', base: 10 },
  { key: 'psychology', name: '心理学', base: 10 },
  { key: 'firstAid', name: '急救', base: 30 },
  { key: 'medicine', name: '医学', base: 1 },
  { key: 'occult', name: '神秘学', base: 5 },
  { key: 'stealth', name: '潜行', base: 20 },
  { key: 'fighting', name: '格斗', base: 25 },
  { key: 'firearms', name: '射击', base: 20 },
  { key: 'nativeLanguage', name: '母语', base: 60 },
]

const coc7AttributeLabels: Array<[keyof Coc7Attributes, string]> = [
  ['str', 'STR'],
  ['con', 'CON'],
  ['siz', 'SIZ'],
  ['dex', 'DEX'],
  ['app', 'APP'],
  ['int', 'INT'],
  ['pow', 'POW'],
  ['edu', 'EDU'],
  ['luck', '幸运'],
]

type ClientCharacterSheetValidation = {
  ok: boolean
  errors: string[]
  occupationPool: number
  interestPool: number
  creditMin: number
  creditMax: number
}

const scriptEditorViewLabel: Record<ScriptEditorView, string> = {
  overview: '概览',
  maps: '地图',
  characters: '人物',
  dice: '骰子',
  chapters: '章节',
}

const scriptBlockTypeLabel: Record<ScriptBlock['type'], string> = {
  narrative: '剧情',
  map: '地图',
  character: '角色',
  check: '判定',
}

const mapFeatureTypeLabel: Record<MapFeature['type'], string> = {
  wall: '墙体',
  door: '门',
  cover: '掩体',
  hazard: '危险区',
}

const mapTokenStatusLabel: Record<MapToken['status'], string> = {
  ready: '普通',
  wounded: '受伤',
  hidden: '隐藏',
  npc: 'NPC',
}

const mapMinSize = 4
const mapMaxWidth = 40
const mapMaxHeight = 30

function clampGridValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)))
}

function parseGridInput(value: string, min: number, max: number) {
  return clampGridValue(Number(value), min, max)
}

function sanitizeMapFeatureForBounds(feature: MapFeature, width: number, height: number): MapFeature {
  const x = clampGridValue(feature.x, 1, width)
  const y = clampGridValue(feature.y, 1, height)
  return {
    ...feature,
    x,
    y,
    w: clampGridValue(feature.w || 1, 1, width - x + 1),
    h: clampGridValue(feature.h || 1, 1, height - y + 1),
  }
}

function sanitizeMapTokenForBounds(token: MapToken, width: number, height: number): MapToken {
  return {
    ...token,
    x: clampGridValue(token.x, 1, width),
    y: clampGridValue(token.y, 1, height),
  }
}

function sanitizeScriptMap(map: ScriptMap): ScriptMap {
  const width = clampGridValue(map.width, mapMinSize, mapMaxWidth)
  const height = clampGridValue(map.height, mapMinSize, mapMaxHeight)
  return {
    ...map,
    width,
    height,
    features: (map.features ?? []).map((feature) => sanitizeMapFeatureForBounds(feature, width, height)),
    tokens: (map.tokens ?? []).map((token) => sanitizeMapTokenForBounds(token, width, height)),
  }
}

function sanitizeScriptForEditor(script: TrpgScript): TrpgScript {
  return {
    ...script,
    maps: script.maps.map(sanitizeScriptMap),
  }
}

function mapFeaturePreviewStyle(map: ScriptMap, feature: MapFeature): CSSProperties {
  const x = clampGridValue(feature.x, 1, map.width)
  const y = clampGridValue(feature.y, 1, map.height)
  const w = clampGridValue(feature.w || 1, 1, map.width - x + 1)
  const h = clampGridValue(feature.h || 1, 1, map.height - y + 1)
  return {
    gridColumn: `${x} / span ${w}`,
    gridRow: `${y} / span ${h}`,
  }
}

function mapTokenPreviewStyle(map: ScriptMap, token: MapToken): CSSProperties {
  return {
    background: token.color || '#187a6d',
    gridColumn: clampGridValue(token.x, 1, map.width),
    gridRow: clampGridValue(token.y, 1, map.height),
  }
}

function loadStoredVolumes() {
  try {
    return JSON.parse(localStorage.getItem(voiceVolumeStorageKey) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function makeVoiceSessionId() {
  return globalThis.crypto?.randomUUID?.() ?? buildId('voice-session')
}

function accountIdFromVoiceIdentity(identity: string) {
  const separator = identity.lastIndexOf(':')
  return separator > 0 ? identity.slice(0, separator) : identity
}

function loadStoredActiveRoom(accountId?: string) {
  try {
    const stored = JSON.parse(localStorage.getItem(activeRoomStorageKey) ?? 'null') as Partial<StoredActiveRoom> | null
    if (!stored?.accountId || !stored.roomId) {
      return null
    }
    if (accountId && stored.accountId !== accountId) {
      return null
    }
    return {
      accountId: stored.accountId,
      minimized: Boolean(stored.minimized),
      role: stored.role === 'keeper' ? 'keeper' : 'player',
      roomId: stored.roomId,
    } satisfies StoredActiveRoom
  } catch {
    return null
  }
}

function buildId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function initials(value: string) {
  return value.trim().slice(0, 2).toUpperCase() || 'PT'
}

function formatDateTime(iso?: string | null) {
  if (!iso) {
    return ''
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function deriveClientCoc7(attributes: Coc7Attributes, age = 30) {
  const hp = Math.floor((attributes.con + attributes.siz) / 10)
  const mp = Math.floor(attributes.pow / 5)
  let mov = attributes.dex < attributes.siz && attributes.str < attributes.siz ? 7 : 8
  if (attributes.dex > attributes.siz && attributes.str > attributes.siz) {
    mov = 9
  }
  if (age >= 80) mov -= 5
  else if (age >= 70) mov -= 4
  else if (age >= 60) mov -= 3
  else if (age >= 50) mov -= 2
  else if (age >= 40) mov -= 1
  return { hp, maxHp: hp, mp, maxMp: mp, san: attributes.pow, maxSan: attributes.pow, mov: Math.max(1, mov), db: '0', build: 0 }
}

function buildDraftSheet(account: Account, existing?: CharacterSheet | null, scriptCharacterId?: string): CharacterSheet {
  const attributes = existing?.attributes ?? {
    str: 50,
    con: 50,
    siz: 60,
    dex: 50,
    app: 50,
    int: 60,
    pow: 50,
    edu: 60,
    luck: 50,
  }
  const nowIso = new Date().toISOString()
  return {
    id: existing?.id ?? buildId('sheet'),
    ownerId: account.id,
    ownerName: account.displayName,
    scriptCharacterId: existing?.scriptCharacterId ?? scriptCharacterId,
    status: existing?.status ?? 'draft',
    name: existing?.name ?? '',
    occupation: existing?.occupation ?? '记者',
    age: existing?.age ?? 30,
    sex: existing?.sex ?? '',
    residence: existing?.residence ?? '',
    birthplace: existing?.birthplace ?? '',
    attributes,
    derived: deriveClientCoc7(attributes, existing?.age ?? 30),
    skills:
      existing?.skills ??
      coc7SkillTemplates.map((skill) => ({
        ...skill,
        base: skill.key === 'dodge' ? Math.floor(attributes.dex / 2) : skill.key === 'nativeLanguage' ? attributes.edu : skill.base,
        occupation: 0,
        interest: 0,
        growth: 0,
      })),
    background: existing?.background ?? {
      description: '',
      ideology: '',
      significantPeople: '',
      locations: '',
      possessions: '',
      traits: '',
    },
    reviewerNotes: existing?.reviewerNotes ?? '',
    reviewedAt: existing?.reviewedAt,
    reviewedBy: existing?.reviewedBy,
    confirmedAt: existing?.confirmedAt,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: existing?.updatedAt ?? nowIso,
  }
}

function occupationUsed(sheet: CharacterSheet) {
  return sheet.skills.reduce((sum, skill) => sum + Number(skill.occupation || 0), 0)
}

function interestUsed(sheet: CharacterSheet) {
  return sheet.skills.reduce((sum, skill) => sum + Number(skill.interest || 0), 0)
}

function coc7OccupationProfileFor(name: string) {
  return coc7OccupationProfiles.find((profile) => profile.name === name || profile.key === name) ?? coc7OccupationProfiles[0]
}

function evaluateCoc7OccupationPool(formula: string, attributes: Coc7Attributes) {
  const tokens = formula.match(/[a-z]+|\d+|[+*]/gi) ?? []
  let total = 0
  let pending: '+' | '*' = '+'
  for (const token of tokens) {
    if (token === '+' || token === '*') {
      pending = token
      continue
    }
    const key = token.toLowerCase() as keyof Coc7Attributes
    const value = key in attributes ? attributes[key] : Number(token)
    if (!Number.isFinite(value)) {
      continue
    }
    total = pending === '*' ? total * value : total + value
  }
  return total
}

function validateClientCharacterSheet(sheet: CharacterSheet): ClientCharacterSheetValidation {
  const errors: string[] = []
  for (const [key] of coc7AttributeLabels) {
    const value = sheet.attributes[key]
    const min = key === 'siz' ? 40 : 15
    if (value < min || value > 90) {
      errors.push(`${key.toUpperCase()} 必须在 ${min}-90 之间`)
    }
  }
  if (sheet.age < 15 || sheet.age > 90) {
    errors.push('年龄必须在 15-90 之间')
  }

  const occupation = coc7OccupationProfileFor(sheet.occupation)
  const occupationPool = evaluateCoc7OccupationPool(occupation.formula, sheet.attributes)
  const interestPool = sheet.attributes.int * 2
  const usedOccupation = occupationUsed(sheet)
  const usedInterest = interestUsed(sheet)
  if (usedOccupation > occupationPool) {
    errors.push(`职业技能点超出上限：${usedOccupation}/${occupationPool}`)
  }
  if (usedInterest > interestPool) {
    errors.push(`兴趣技能点超出上限：${usedInterest}/${interestPool}`)
  }

  const occupationSkills = new Set<string>(occupation.skills)
  const background = sheet.background.description
  sheet.skills.forEach((skill) => {
    const finalValue = skill.base + skill.occupation + skill.interest + skill.growth
    if (finalValue > 90 && skill.key !== 'creditRating') {
      errors.push(`${skill.name} 不能高于 90`)
    }
    if (skill.key === 'creditRating' && (finalValue < occupation.crMin || finalValue > occupation.crMax)) {
      errors.push(`信用评级必须在 ${occupation.crMin}-${occupation.crMax} 之间`)
    }
    if (skill.occupation > 0 && skill.key !== 'creditRating' && !occupationSkills.has(skill.key)) {
      const tagByName = `[skill:${skill.name}]`
      const tagByKey = `[skill:${skill.key}]`
      if (!background.includes(tagByName) && !background.includes(tagByKey)) {
        errors.push(`${skill.name} 不是 ${occupation.name} 的本职技能，需要在背景中写明 ${tagByName}`)
      }
    }
  })

  return {
    ok: errors.length === 0,
    errors,
    occupationPool,
    interestPool,
    creditMin: occupation.crMin,
    creditMax: occupation.crMax,
  }
}

type RoomPreparationDraft = {
  summary: string
  scriptCharacters: ScriptCharacter[]
}

function buildPreparationDraft(room: RoomState): RoomPreparationDraft {
  return {
    summary: room.summary ?? '',
    scriptCharacters: room.scriptCharacters.map((character) => ({
      id: character.id || buildId('script-character'),
      name: character.name ?? '',
      count: character.count || 1,
      parameters: character.parameters ?? '',
      story: character.story ?? '',
      occupation: character.occupation ?? '',
      publicSummary: character.publicSummary ?? '',
      privateBrief: character.privateBrief ?? '',
      recommendedSkills: character.recommendedSkills ?? [],
    })),
  }
}

function formatRecommendedSkills(character: ScriptCharacter) {
  return (character.recommendedSkills ?? []).map((skill) => `${skill.name}:${skill.base}`).join('\n')
}

function parseRecommendedSkills(value: string) {
  return value
    .split(/\r?\n|[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [name, base] = item.split(/[:：]/)
      return {
        name: name?.trim() ?? '',
        base: Math.max(0, Math.min(100, Number(base) || 0)),
      }
    })
    .filter((skill) => skill.name)
}

function recruitedPlayerIdSet(room: RoomState) {
  return new Set(
    (room.roster ?? [])
      .filter((member) => member.accountId !== room.ownerId)
      .map((member) => member.accountId),
  )
}

function scriptCharacterUsage(room: RoomState, scriptCharacterId: string, currentSheetId = '') {
  const activePlayerIds = recruitedPlayerIdSet(room)
  const sheetUses = room.characterSheets.filter(
    (sheet) =>
      sheet.id !== currentSheetId &&
      activePlayerIds.has(sheet.ownerId) &&
      sheet.scriptCharacterId === scriptCharacterId &&
      (sheet.status === 'submitted' || sheet.status === 'approved'),
  ).length
  const importedUses = room.characters.filter(
    (character) =>
      character.scriptCharacterId === scriptCharacterId &&
      activePlayerIds.has(character.accountId ?? '') &&
      !room.characterSheets.some((sheet) => sheet.id === character.sheetId),
  ).length
  return sheetUses + importedUses
}

function scriptCharacterAvailability(room: RoomState, character: ScriptCharacter, currentSheetId = '') {
  const used = scriptCharacterUsage(room, character.id, currentSheetId)
  return {
    used,
    total: character.count,
    full: used >= character.count,
  }
}

function scriptCharacterBrief(character: ScriptCharacter) {
  return [character.publicSummary, character.story].filter(Boolean).join('\n')
}

function roomPreparationIssues(summary: string, scriptCharacters: Array<Pick<ScriptCharacter, 'name' | 'publicSummary'>>) {
  const issues: string[] = []
  if (!summary.trim()) {
    issues.push('需要填写公开剧情')
  }
  const hasPublicCharacter = scriptCharacters.some(
    (character) => character.name.trim() && (character.publicSummary ?? '').trim(),
  )
  if (!hasPublicCharacter) {
    issues.push('至少需要 1 个带公开人设摘要的可选角色')
  }
  return issues
}

function mergeDirectMessageList(current: DirectMessage[], incoming: DirectMessage[] = []) {
  const byId = new globalThis.Map<string, DirectMessage>()
  current.forEach((message) => byId.set(message.id, message))
  incoming.forEach((message) => byId.set(message.id, message))
  return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function formatBadgeCount(value: number) {
  return value > 99 ? '99+' : String(value)
}

function mergeRoomMessageList(current: ChatMessage[], incoming: ChatMessage[] = []) {
  const byId = new globalThis.Map<string, ChatMessage>()
  current.forEach((message) => byId.set(message.id, message))
  incoming.forEach((message) => byId.set(message.id, message))
  return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function trimRoomMessageCache(messages: ChatMessage[]) {
  return messages.length > maxRoomClientMessages ? messages.slice(-maxRoomClientMessages) : messages
}

function mergeRoomMessageCache(current: ChatMessage[], incoming: ChatMessage[] = []) {
  return trimRoomMessageCache(mergeRoomMessageList(current, incoming))
}

function lastItem<T>(items: readonly T[]) {
  return items.length > 0 ? items[items.length - 1] : undefined
}

type LiveKitClientRuntime = typeof import('livekit-client')
let liveKitClientPromise: Promise<LiveKitClientRuntime> | null = null

function latestLiveKitClientResourceUrl() {
  const entries = performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => /livekit-client.*\.js/i.test(name))
  return lastItem(entries) ?? ''
}

function cacheBustedLiveKitClientUrl(sourceUrl: string) {
  const url = new URL(sourceUrl, window.location.href)
  url.searchParams.set('pt_voice_retry', Date.now().toString(36))
  return url.toString()
}

function loadLiveKitClient() {
  if (!liveKitClientPromise) {
    const nextPromise = import('livekit-client').catch((error) => {
      if (liveKitClientPromise === nextPromise) {
        liveKitClientPromise = null
      }
      const retryUrl = latestLiveKitClientResourceUrl()
      if (!retryUrl) {
        throw error
      }
      const retryPromise = import(/* @vite-ignore */ cacheBustedLiveKitClientUrl(retryUrl)).catch((retryError) => {
        if (liveKitClientPromise === retryPromise) {
          liveKitClientPromise = null
        }
        throw retryError
      }) as Promise<LiveKitClientRuntime>
      liveKitClientPromise = retryPromise
      return retryPromise
    })
    liveKitClientPromise = nextPromise
  }
  return liveKitClientPromise
}

function mapLiveKitQuality(quality: unknown): VoiceParticipant['quality'] {
  switch (String(quality).toLowerCase()) {
    case 'excellent':
      return 'excellent'
    case 'good':
      return 'good'
    case 'poor':
    case 'lost':
      return 'relay'
    default:
      return 'offline'
  }
}

function directCallPeer(event: DirectCallEvent, accountId: string) {
  return event.fromId === accountId
    ? { id: event.toId, name: event.toName }
    : { id: event.fromId, name: event.fromName }
}

function resolveStateAction<T>(action: SetStateAction<T>, previous: T) {
  return typeof action === 'function' ? (action as (value: T) => T)(previous) : action
}

function useKeyedState<T>(key: string, createValue: () => T) {
  const [, forceRender] = useState(0)
  const stateRef = useRef<KeyedState<T> | null>(null)

  if (!stateRef.current || stateRef.current.key !== key) {
    stateRef.current = { key, value: createValue() }
  }

  const setValue = useCallback(
    (action: SetStateAction<T>) => {
      const current = stateRef.current
      const previous = current?.key === key ? current.value : createValue()
      stateRef.current = { key, value: resolveStateAction(action, previous) }
      forceRender((version) => version + 1)
    },
    [createValue, key],
  )

  return [stateRef.current.value, setValue] as const
}

function escapeAttributeValue(value: string) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/["\\]/g, '\\$&')
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1) {
  const target = index + direction
  if (index < 0 || target < 0 || target >= items.length) {
    return items
  }
  const next = [...items]
  const current = next[index]
  next[index] = next[target]
  next[target] = current
  return next
}

function isImageAvatar(value: string) {
  return /^data:image\//.test(value) || /^https?:\/\//.test(value) || value.startsWith('/uploads/')
}

function avatarLabel(value: string, fallback: string) {
  return value && !isImageAvatar(value) ? value : initials(fallback)
}

function makeAvatarUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const reader = new FileReader()
    const readableFile = normalizeAvatarFile(file)

    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('无法读取图片'))
      }
      image.onload = () => {
        const size = 256
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error('无法处理图片'))
          return
        }
        const minSide = Math.min(image.width, image.height)
        const cropX = Math.max(0, Math.floor((image.width - minSide) / 2))
        const cropY = Math.max(0, Math.floor((image.height - minSide) / 2))
        context.clearRect(0, 0, size, size)
        context.drawImage(image, cropX, cropY, minSide, minSide, 0, 0, size, size)
        const output = canvas.toDataURL('image/webp', 0.88)
        if (output.length > avatarOutputMaxChars) {
          reject(new Error('头像图片处理后仍然过大'))
          return
        }
        resolve(output)
      }
      image.onerror = () => reject(new Error('图片加载失败'))
      if (typeof reader.result !== 'string') {
        reject(new Error('图片加载失败'))
        return
      }
      image.src = reader.result
    }
    reader.readAsDataURL(readableFile)
  })
}

const avatarAcceptedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const avatarAcceptedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const avatarSourceMaxBytes = 8 * 1024 * 1024
const avatarOutputMaxChars = 300000

function avatarFileExtension(file: File) {
  return file.name.includes('.') ? `.${file.name.split('.').pop()?.toLowerCase() ?? ''}` : ''
}

function inferAvatarMimeType(file: File) {
  const type = file.type.trim().toLowerCase()
  if (avatarAcceptedTypes.has(type)) {
    return type
  }
  if (type === 'image/jpg') {
    return 'image/jpeg'
  }
  switch (avatarFileExtension(file)) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      return ''
  }
}

function normalizeAvatarFile(file: File) {
  const mimeType = inferAvatarMimeType(file)
  if (!mimeType || file.type.trim().toLowerCase() === mimeType) {
    return file
  }
  return new File([file], file.name, { type: mimeType })
}

function isPotentialAvatarImage(file: File) {
  const type = file.type.trim().toLowerCase()
  if (avatarAcceptedTypes.has(type) || type === 'image/jpg') {
    return true
  }
  const extensionAccepted = avatarAcceptedExtensions.has(avatarFileExtension(file))
  if (!type || type === 'application/octet-stream') {
    return extensionAccepted
  }
  if (type.startsWith('image/')) {
    return extensionAccepted
  }
  return false
}

function AvatarView({
  value,
  name,
  className = '',
}: {
  value: string
  name: string
  className?: string
}) {
  const classes = className ? `avatar ${className}` : 'avatar'
  return (
    <div className={classes}>
      {isImageAvatar(value) ? <img alt="" src={value} /> : avatarLabel(value, name)}
    </div>
  )
}

function emptyScriptBlock(type: ScriptBlock['type']): ScriptBlock {
  const id = buildId('block')
  switch (type) {
    case 'narrative':
      return { id, type, title: '正文', markdown: '' }
    case 'map':
      return { id, type, title: '地图块', mapId: '', notes: '' }
    case 'character':
      return { id, type, title: '角色块', characterId: '', notes: '' }
    case 'check':
      return {
        id,
        type,
        title: '判定块',
        diceId: '',
        difficulty: 50,
        onPass: '',
        onFail: '',
      }
  }
}

function scriptBlockFor(script: TrpgScript, type: ScriptBlock['type'], existing?: ScriptBlock): ScriptBlock {
  const block = emptyScriptBlock(type)
  const next = {
    ...block,
    id: existing?.id ?? block.id,
    title: existing?.title || block.title,
  } as ScriptBlock

  if (next.type === 'map') {
    next.mapId = script.maps[0]?.id ?? ''
  }
  if (next.type === 'character') {
    next.characterId = script.characters[0]?.id ?? ''
  }
  if (next.type === 'check') {
    next.diceId = script.diceProfiles[0]?.id ?? ''
  }

  return next
}

function asApiError(error: unknown): ApiUiError {
  return error instanceof Error ? (error as ApiUiError) : new Error(String(error))
}

function verificationSendErrorMessage(error: unknown) {
  const apiError = asApiError(error)
  if (apiError.status === 409 || apiError.message === 'Email already exists') {
    return '这个邮箱已经注册，请直接登录或换一个邮箱。'
  }
  if (apiError.status === 404 || apiError.message === 'Account not found') {
    return '这个邮箱还没有注册。'
  }
  if (apiError.status === 429 || apiError.message === 'Verification code requested too frequently') {
    const retryAfter = apiError.retryAfterSeconds ? `${apiError.retryAfterSeconds} 秒后` : '稍后'
    return `验证码请求过快，请 ${retryAfter} 再试。`
  }
  if (apiError.status === 503) {
    return '邮件服务暂时不可用，请联系管理员检查 Resend、SMTP 或 Cloud Mail 配置。'
  }
  return '验证码发送失败，请确认邮箱格式正确，或稍后再试。'
}

function authErrorMessage(error: unknown, mode: AuthMode) {
  const apiError = asApiError(error)
  if (mode === 'login') {
    return '登录失败，请检查邮箱和密码。'
  }
  if (mode === 'reset') {
    if (apiError.message === 'Account not found') {
      return '这个邮箱还没有注册。'
    }
    if (apiError.message === 'Verification code is invalid or expired') {
      return '验证码错误或已过期，请重新获取。'
    }
    return '重置密码失败，请检查验证码、邮箱或新密码。'
  }
  if (apiError.message === 'Verification code is invalid or expired') {
    return '验证码错误或已过期，请重新获取。'
  }
  if (apiError.message === 'Too many verification attempts') {
    return '验证码错误次数过多，请重新获取。'
  }
  if (apiError.message === 'Email already exists') {
    return '这个邮箱已经注册，请直接登录。'
  }
  return '注册失败，请检查验证码、邮箱或密码。'
}

function voiceQualityLabel(participant: VoiceParticipant) {
  if (participant.speaking) {
    return '说话中'
  }

  if (participant.muted) {
    return '静音'
  }

  const labels: Record<VoiceParticipant['quality'], string> = {
    excellent: '流畅',
    good: '良好',
    relay: '中继',
    offline: '离线',
  }

  return labels[participant.quality]
}

function makeLocalScript(account: Account): TrpgScript {
  const createdAt = new Date().toISOString()
  return {
    id: `local-${Date.now()}`,
    title: '新建跑团剧本',
    system: 'COC 7th',
    visibility: 'private',
    ownerId: account.id,
    ownerName: account.displayName,
    summary: '',
    tags: ['自定义'],
    coverUrl: '',
    maps: [{ id: buildId('map'), name: '初始地图', width: 12, height: 8, notes: '' }],
    characters: [
      {
        id: buildId('sc'),
        name: '主要角色',
        count: 1,
        parameters: 'HP 10 / SAN 50',
        story: '',
        occupation: '调查员',
        publicSummary: '面向玩家公开的人设摘要，可写身份、动机和可被招募的信息。',
        privateBrief: '',
        recommendedSkills: [{ name: '侦查', base: 25 }, { name: '聆听', base: 20 }],
      },
    ],
    diceProfiles: [{ id: buildId('dice'), label: '默认骰子', formula: '1d100', probability: 0.5 }],
    chapters: [
      {
        id: buildId('chapter'),
        title: '第一章',
        blocks: [
          {
            id: buildId('block'),
            type: 'narrative',
            title: '开场',
            markdown: '',
          },
        ],
      },
    ],
    createdAt,
    updatedAt: createdAt,
    version: 1,
  }
}

function App() {
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem(authStorageKey) ?? '')
  const [account, setAccount] = useState<Account | null>(null)
  const [booting, setBooting] = useState(Boolean(sessionToken))
  const [bootingSlow, setBootingSlow] = useState(false)
  const [page, setPage] = useState<MainPage>('lobby')
  const [roomTab, setRoomTab] = useState<RoomTab>('map')
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [closedRooms, setClosedRooms] = useState<RoomSummary[]>([])
  const [friends, setFriends] = useState<FriendSummary[]>([])
  const [scripts, setScripts] = useState<TrpgScriptSummary[]>([])
  const [activeRoomId, setActiveRoomId] = useState('')
  const [roomMinimized, setRoomMinimized] = useState(false)
  const [room, setRoom] = useState<RoomState | null>(null)
  const [roomMessageToasts, setRoomMessageToasts] = useState<RoomMessageToast[]>([])
  const [floatingRoomPosition, setFloatingRoomPosition] = useState<FloatingRoomPosition>(() => defaultFloatingRoomPosition())
  const [directMessageEvents, setDirectMessageEvents] = useState<DirectMessage[]>([])
  const [directCall, setDirectCall] = useState<DirectCallEvent | null>(null)
  const [directCallNotice, setDirectCallNotice] = useState('')
  const [directCallActionError, setDirectCallActionError] = useState('')
  const [directCallBusy, setDirectCallBusy] = useState(false)
  const [directVoiceStatus, setDirectVoiceStatus] = useState<VoiceStatus>('idle')
  const [directVoiceNote, setDirectVoiceNote] = useState('等待通话')
  const [directVoiceMuted, setDirectVoiceMuted] = useState(false)
  const [directAudioPlaybackBlocked, setDirectAudioPlaybackBlocked] = useState(false)
  const [selectedTokenId, setSelectedTokenId] = useState('')
  const [chatDraft, setChatDraft] = useState('')
  const [diceFormula, setDiceFormula] = useState('1d100<=50')
  const [lastRoll, setLastRoll] = useState('')
  const [roomChatStatus, setRoomChatStatus] = useState('')
  const [confirmedRoomMessage, setConfirmedRoomMessage] = useState<ConfirmedRoomMessageSignal | null>(null)
  const [roomMessageCooldownUntil, setRoomMessageCooldownUntil] = useState(0)
  const [roomDiceCooldownUntil, setRoomDiceCooldownUntil] = useState(0)
  const [, setCooldownTick] = useState(0)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle')
  const [voiceNote, setVoiceNote] = useState('等待连接')
  const [voiceMuted, setVoiceMuted] = useState(false)
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false)
  const [noiseSuppression, setNoiseSuppression] = useState(true)
  const [voiceVolumes, setVoiceVolumes] = useState<Record<string, number>>(loadStoredVolumes)
  const [roomVoiceReturnRoomId, setRoomVoiceReturnRoomId] = useState('')
  const socketRef = useRef<Socket | null>(null)
  const homeSocketRef = useRef<Socket | null>(null)
  const liveKitRef = useRef<LiveKitRoom | null>(null)
  const pendingLiveKitRef = useRef<LiveKitRoom | null>(null)
  const directLiveKitRef = useRef<LiveKitRoom | null>(null)
  const pendingDirectLiveKitRef = useRef<LiveKitRoom | null>(null)
  const voiceSessionIdRef = useRef(makeVoiceSessionId())
  const directVoiceSessionIdRef = useRef(makeVoiceSessionId())
  const remoteAudioElementsRef = useRef<globalThis.Map<string, HTMLMediaElement[]>>(new globalThis.Map())
  const directRemoteAudioElementsRef = useRef<globalThis.Map<string, HTMLMediaElement[]>>(new globalThis.Map())
  const toastTimersRef = useRef<globalThis.Map<string, number>>(new globalThis.Map())
  const pageRef = useRef(page)
  const roomTabRef = useRef(roomTab)
  const roomMinimizedRef = useRef(roomMinimized)
  const activeRoomRestoreKeyRef = useRef('')
  const currentRoomRoleRef = useRef<UserRole>('player')
  const voiceStatusRef = useRef<VoiceStatus>('idle')
  const directVoiceStatusRef = useRef<VoiceStatus>('idle')
  const voiceMutedRef = useRef(voiceMuted)
  const directVoiceMutedRef = useRef(directVoiceMuted)
  const roomRef = useRef<RoomState | null>(room)
  const accountRef = useRef<Account | null>(account)
  const sessionTokenRef = useRef(sessionToken)
  const voiceWantedRef = useRef(false)
  const directVoiceWantedRef = useRef(false)
  const directVoiceTargetRef = useRef<{ callId: string; event: DirectCallEvent; peerId: string; peerName: string } | null>(null)
  const directVoiceApprovedCallIdsRef = useRef<Set<string>>(new Set())
  const lastLocalSpeakingRef = useRef(false)
  const pendingLocalSpeakingRef = useRef<boolean | null>(null)
  const voiceReconnectTimerRef = useRef<number | null>(null)
  const voiceSpeakingUpdateTimerRef = useRef<number | null>(null)
  const voiceReconnectAttemptsRef = useRef(0)
  const voiceConnectGenerationRef = useRef(0)
  const directVoiceReconnectTimerRef = useRef<number | null>(null)
  const directVoiceReconnectAttemptsRef = useRef(0)
  const directVoiceConnectGenerationRef = useRef(0)
  const directCallBusyRef = useRef(false)
  const appliedNoiseSuppressionRef = useRef(noiseSuppression)
  const connectVoiceRef = useRef<((options?: { reconnecting?: boolean }) => Promise<void>) | null>(null)
  const connectDirectVoiceRef = useRef<((event: DirectCallEvent, options?: { reconnecting?: boolean }) => Promise<void>) | null>(null)
  const tokenMutationSeqRef = useRef(0)
  const pendingTokenMutationsRef = useRef<globalThis.Map<string, PendingTokenMutation>>(new globalThis.Map())
  const characterMutationSeqRef = useRef(0)
  const pendingCharacterMutationsRef = useRef<globalThis.Map<string, PendingCharacterMutation>>(new globalThis.Map())
  const pendingRoomMessagesRef = useRef<globalThis.Map<string, { replyToId?: string; roomId: string; text: string }>>(new globalThis.Map())
  const pendingRoomMessageRetryRef = useRef<PendingRoomMessageRetry | null>(null)
  const pendingRoomDiceRetryRef = useRef<PendingRoomDiceRetry | null>(null)
  const confirmedRoomMessageSeqRef = useRef(0)
  const directCallClearTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!roomMessageCooldownUntil && !roomDiceCooldownUntil) {
      return
    }
    const timer = window.setInterval(() => {
      const timestamp = Date.now()
      setRoomMessageCooldownUntil((current) => {
        if (current > 0 && current <= timestamp) {
          setRoomChatStatus((status) => (status.includes('请 ') ? '' : status))
          return 0
        }
        return current
      })
      setRoomDiceCooldownUntil((current) => {
        if (current > 0 && current <= timestamp) {
          setLastRoll((status) => (status.includes('请 ') ? '' : status))
          return 0
        }
        return current
      })
      setCooldownTick(timestamp)
    }, 500)
    return () => window.clearInterval(timer)
  }, [roomDiceCooldownUntil, roomMessageCooldownUntil])

  const markRoomMessageConfirmed = useCallback((roomId: string, kind: ConfirmedRoomMessageSignal['kind'], clientMessageId?: string, replyToId?: string) => {
    if (!clientMessageId) {
      return
    }
    confirmedRoomMessageSeqRef.current += 1
    setConfirmedRoomMessage({
      clientMessageId,
      kind,
      replyToId,
      roomId,
      seq: confirmedRoomMessageSeqRef.current,
    })
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const updateViewportVars = () => {
      const viewport = window.visualViewport
      const height = viewport?.height ?? window.innerHeight
      const keyboardInset = Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0))
      root.style.setProperty('--pt-viewport-height', `${height}px`)
      root.style.setProperty('--pt-keyboard-inset', `${keyboardInset}px`)
    }

    updateViewportVars()
    window.addEventListener('resize', updateViewportVars)
    window.addEventListener('orientationchange', updateViewportVars)
    window.visualViewport?.addEventListener('resize', updateViewportVars)
    window.visualViewport?.addEventListener('scroll', updateViewportVars)
    return () => {
      window.removeEventListener('resize', updateViewportVars)
      window.removeEventListener('orientationchange', updateViewportVars)
      window.visualViewport?.removeEventListener('resize', updateViewportVars)
      window.visualViewport?.removeEventListener('scroll', updateViewportVars)
    }
  }, [])

  const clearVoiceReconnectTimer = useCallback(() => {
    if (voiceReconnectTimerRef.current !== null) {
      window.clearTimeout(voiceReconnectTimerRef.current)
      voiceReconnectTimerRef.current = null
    }
  }, [])

  const clearVoiceSpeakingTimer = useCallback(() => {
    if (voiceSpeakingUpdateTimerRef.current !== null) {
      window.clearTimeout(voiceSpeakingUpdateTimerRef.current)
      voiceSpeakingUpdateTimerRef.current = null
    }
    pendingLocalSpeakingRef.current = null
  }, [])

  const clearDirectVoiceReconnectTimer = useCallback(() => {
    if (directVoiceReconnectTimerRef.current !== null) {
      window.clearTimeout(directVoiceReconnectTimerRef.current)
      directVoiceReconnectTimerRef.current = null
    }
  }, [])

  const detachRemoteAudio = useCallback((track?: RemoteTrack | null) => {
    if (track && track.kind === 'audio') {
      const audioTrack = track as RemoteAudioTrack
      const trackId = audioTrack.sid ?? audioTrack.mediaStreamTrack.id
      audioTrack.detach().forEach((element) => element.remove())
      remoteAudioElementsRef.current.delete(trackId)
      return
    }

    remoteAudioElementsRef.current.forEach((elements) => {
      elements.forEach((element) => element.remove())
    })
    remoteAudioElementsRef.current.clear()
  }, [])

  const detachDirectRemoteAudio = useCallback((track?: RemoteTrack | null) => {
    if (track && track.kind === 'audio') {
      const audioTrack = track as RemoteAudioTrack
      const trackId = audioTrack.sid ?? audioTrack.mediaStreamTrack.id
      audioTrack.detach().forEach((element) => element.remove())
      directRemoteAudioElementsRef.current.delete(trackId)
      return
    }

    directRemoteAudioElementsRef.current.forEach((elements) => {
      elements.forEach((element) => element.remove())
    })
    directRemoteAudioElementsRef.current.clear()
  }, [])

  const cleanupDirectVoiceConnection = useCallback(() => {
    directVoiceConnectGenerationRef.current += 1
    directVoiceWantedRef.current = false
    directVoiceTargetRef.current = null
    directVoiceReconnectAttemptsRef.current = 0
    clearDirectVoiceReconnectTimer()
    pendingDirectLiveKitRef.current?.disconnect()
    pendingDirectLiveKitRef.current = null
    directLiveKitRef.current?.disconnect()
    directLiveKitRef.current = null
    detachDirectRemoteAudio()
    setDirectVoiceMuted(false)
    setDirectAudioPlaybackBlocked(false)
    setDirectVoiceStatus('idle')
    setDirectVoiceNote('等待通话')
  }, [clearDirectVoiceReconnectTimer, detachDirectRemoteAudio])

  const cleanupVoiceConnection = useCallback(
    (options: { emitLeave?: boolean; roomId?: string; token?: string } = {}) => {
      voiceConnectGenerationRef.current += 1
      voiceWantedRef.current = false
      voiceReconnectAttemptsRef.current = 0
      lastLocalSpeakingRef.current = false
      clearVoiceReconnectTimer()
      clearVoiceSpeakingTimer()
      if (options.emitLeave && options.roomId && options.token) {
        socketRef.current?.emit('voice:leave', {
          roomId: options.roomId,
          token: options.token,
        })
      }
      pendingLiveKitRef.current?.disconnect()
      pendingLiveKitRef.current = null
      liveKitRef.current?.disconnect()
      liveKitRef.current = null
      detachRemoteAudio()
      setVoiceMuted(false)
      setAudioPlaybackBlocked(false)
      setVoiceStatus('idle')
      setVoiceNote('等待连接')
    },
    [clearVoiceReconnectTimer, clearVoiceSpeakingTimer, detachRemoteAudio],
  )

  const clearDirectCallTimer = useCallback(() => {
    if (directCallClearTimerRef.current !== null) {
      window.clearTimeout(directCallClearTimerRef.current)
      directCallClearTimerRef.current = null
    }
  }, [])

  const endAcceptedDirectCallBestEffort = useCallback(async (event?: DirectCallEvent | null) => {
    const currentCall = event ?? directCall
    const accountId = accountRef.current?.id
    const token = sessionTokenRef.current
    const homeSocket = homeSocketRef.current
    if (!currentCall || currentCall.status !== 'accepted' || !accountId || !token || !homeSocket?.connected) {
      return
    }
    const ownsDirectVoiceOnThisDevice =
      directVoiceApprovedCallIdsRef.current.has(currentCall.callId) ||
      directVoiceTargetRef.current?.callId === currentCall.callId
    if (!ownsDirectVoiceOnThisDevice) {
      return
    }
    const peer = directCallPeer(currentCall, accountId)
    if (!peer.id) {
      return
    }
    try {
      await emitSocketAck<DirectCallEvent>(
        homeSocket,
        'direct-call:end',
        {
          token,
          friendId: peer.id,
          callId: currentCall.callId,
        },
        '结束好友通话超时',
      )
    } catch {
      // Best effort: the accepted-call lease still expires server-side if this packet is lost.
    }
  }, [directCall])

  const updateDirectCallState = useCallback(
    (event: DirectCallEvent, options: { allowVoiceAutoStart?: boolean } = {}) => {
      clearDirectCallTimer()
      setDirectCallActionError('')
      const currentAccountId = accountRef.current?.id
      const peerName = currentAccountId ? directCallPeer(event, currentAccountId).name : event.fromName
      if (options.allowVoiceAutoStart) {
        directVoiceApprovedCallIdsRef.current.add(event.callId)
      }
      if (event.status === 'ringing') {
        setDirectCall(event)
        setDirectCallNotice(event.fromId === currentAccountId ? `正在呼叫 ${peerName}` : `${peerName} 请求语音通话`)
        return
      }
      setDirectCall(event)
      setDirectCallNotice(
        event.status === 'accepted'
          ? `已接通 ${peerName} 的通话`
          : event.status === 'rejected'
          ? `${peerName} 已拒绝通话`
          : `已结束与 ${peerName} 的通话`,
      )
      if (event.status === 'accepted') {
        const currentTarget = directVoiceTargetRef.current
        const alreadyConnected =
          currentTarget?.callId === event.callId &&
          (directVoiceStatusRef.current === 'connecting' || directVoiceStatusRef.current === 'connected' || directVoiceStatusRef.current === 'demo')
        const userApprovedOnThisDevice = directVoiceApprovedCallIdsRef.current.has(event.callId)
        if (!alreadyConnected && userApprovedOnThisDevice) {
          void connectDirectVoiceRef.current?.(event)
        } else if (!alreadyConnected && directVoiceStatusRef.current === 'idle') {
          setDirectVoiceNote('此通话已在其他设备接通，本设备不会自动占用麦克风。可点“重连语音”在本设备加入。')
        }
        return
      }
      directVoiceApprovedCallIdsRef.current.delete(event.callId)
      cleanupDirectVoiceConnection()
      if (roomVoiceReturnRoomId) {
        setVoiceNote('好友通话已结束，可回到房间语音。')
      }
      directCallClearTimerRef.current = window.setTimeout(() => {
        setDirectCall(null)
        setDirectCallNotice('')
        directCallClearTimerRef.current = null
      }, 3500)
    },
    [clearDirectCallTimer, cleanupDirectVoiceConnection, roomVoiceReturnRoomId],
  )

  const syncDirectCallState = useCallback(
    (payload: { currentCall?: DirectCallEvent | null }) => {
      const currentCall = payload.currentCall ?? null
      if (currentCall) {
        updateDirectCallState(currentCall)
        return
      }
      clearDirectCallTimer()
      cleanupDirectVoiceConnection()
      directVoiceApprovedCallIdsRef.current.clear()
      setDirectCall(null)
      setDirectCallNotice('')
      setDirectCallActionError('')
    },
    [clearDirectCallTimer, cleanupDirectVoiceConnection, updateDirectCallState],
  )

  const handleDirectCallAction = useCallback<DirectCallActionHandler>(
    async (eventName, friendId, callId) => {
      if (!friendId || directCallBusyRef.current) {
        return
      }
      const homeSocket = homeSocketRef.current
      if (!homeSocket?.connected) {
        setDirectCallActionError('通话信令未连接，请稍后重试。')
        throw new Error('Socket is not connected')
      }
      const startsDirectVoice = eventName === 'direct-call:invite' || eventName === 'direct-call:accept'
      const currentRoomId = roomRef.current?.id ?? activeRoomId
      const roomVoiceActive =
        voiceWantedRef.current ||
        Boolean(liveKitRef.current) ||
        Boolean(pendingLiveKitRef.current) ||
        voiceStatusRef.current === 'connected' ||
        voiceStatusRef.current === 'demo'
      if (startsDirectVoice && roomVoiceActive && currentRoomId) {
        const confirmed = window.confirm('接通好友语音会断开当前房间语音。挂断后可在房间语音页一键回到房间语音。继续？')
        if (!confirmed) {
          return
        }
        setRoomVoiceReturnRoomId(currentRoomId)
      }
      if (startsDirectVoice && callId) {
        directVoiceApprovedCallIdsRef.current.add(callId)
      }
      directCallBusyRef.current = true
      setDirectCallBusy(true)
      setDirectCallActionError('')
      try {
        const payload = {
          token: sessionToken,
          friendId,
          ...(callId ? { callId } : {}),
        }
        const ack = await emitSocketAck<DirectCallEvent>(
          homeSocket,
          eventName,
          payload,
          '通话请求超时',
        )
        if (!ack.ok) {
          throw new Error(String(ack.error || 'Call signaling failed'))
        }
        if (startsDirectVoice) {
          directVoiceApprovedCallIdsRef.current.add(ack.data.callId)
        }
        updateDirectCallState(ack.data, { allowVoiceAutoStart: startsDirectVoice })
      } catch (error) {
        if (startsDirectVoice && callId) {
          directVoiceApprovedCallIdsRef.current.delete(callId)
        }
        setDirectCallActionError('通话信令发送失败，请检查网络后重试。')
        throw error
      } finally {
        directCallBusyRef.current = false
        setDirectCallBusy(false)
      }
    },
    [activeRoomId, sessionToken, updateDirectCallState],
  )

  useEffect(() => {
    if (!account || !sessionToken || directCall?.status !== 'accepted') {
      return
    }
    const peer = directCallPeer(directCall, account.id)
    if (!peer.id) {
      return
    }

    let disposed = false
    const sendHeartbeat = () => {
      const socket = homeSocketRef.current
      if (disposed || !socket?.connected) {
        return
      }
      socket.emit(
        'direct-call:heartbeat',
        { token: sessionToken, friendId: peer.id, callId: directCall.callId },
        (ack: SocketAck<DirectCallEvent>) => {
          if (disposed || ack?.ok) {
            return
          }
          socket.emit('home:sync', { token: sessionToken }, (response?: { ok?: boolean; currentCall?: DirectCallEvent | null }) => {
            if (!disposed && response?.ok) {
              syncDirectCallState({ currentCall: response.currentCall ?? null })
            }
          })
          setDirectVoiceNote('好友通话状态同步失败，等待服务器确认')
        },
      )
    }

    sendHeartbeat()
    const timer = window.setInterval(sendHeartbeat, 15_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [account, directCall, sessionToken, syncDirectCallState])

  const clearAuthenticatedClientState = useCallback(() => {
    localStorage.removeItem(authStorageKey)
    localStorage.removeItem(activeRoomStorageKey)
    setSessionToken('')
    setAccount(null)
    setRoom(null)
    setActiveRoomId('')
    setRoomMinimized(false)
    setRoomMessageToasts([])
    setRooms([])
    setClosedRooms([])
    setFriends([])
    setScripts([])
    setDirectMessageEvents([])
    setDirectCall(null)
    setDirectCallNotice('')
    setDirectCallActionError('')
    directCallBusyRef.current = false
    setDirectCallBusy(false)
    cleanupDirectVoiceConnection()
    setPage('lobby')
    cleanupVoiceConnection()
  }, [cleanupDirectVoiceConnection, cleanupVoiceConnection])

  const refreshHomeData = useCallback(
    async (token = sessionToken) => {
      if (!token) {
        return
      }
      try {
        const [nextRooms, nextClosedRooms, nextFriends, nextScripts] = await Promise.all([
          loadRooms(token),
          loadRooms(token, 'closed'),
          loadFriends(token).catch(() => []),
          loadScripts(token),
        ])
        setRooms(nextRooms)
        setClosedRooms(nextClosedRooms)
        setFriends(nextFriends)
        setScripts(nextScripts)
      } catch {
        setRooms([])
        setClosedRooms([])
        setScripts([])
      }
    },
    [sessionToken],
  )

  const refreshRoomLists = useCallback(
    async (token = sessionToken) => {
      if (!token) {
        return
      }
      try {
        const [nextRooms, nextClosedRooms] = await Promise.all([
          loadRooms(token),
          loadRooms(token, 'closed'),
        ])
        setRooms(nextRooms)
        setClosedRooms(nextClosedRooms)
      } catch {
        setRooms([])
        setClosedRooms([])
      }
    },
    [sessionToken],
  )

  useEffect(() => {
    pageRef.current = page
  }, [page])

  useEffect(() => {
    roomTabRef.current = roomTab
  }, [roomTab])

  useEffect(() => {
    roomMinimizedRef.current = roomMinimized
  }, [roomMinimized])

  useEffect(() => {
    voiceMutedRef.current = voiceMuted
  }, [voiceMuted])

  useEffect(() => {
    directVoiceMutedRef.current = directVoiceMuted
  }, [directVoiceMuted])

  useEffect(() => {
    voiceStatusRef.current = voiceStatus
  }, [voiceStatus])

  useEffect(() => {
    directVoiceStatusRef.current = directVoiceStatus
  }, [directVoiceStatus])

  useEffect(() => {
    roomRef.current = room
  }, [room])

  useEffect(() => {
    accountRef.current = account
  }, [account])

  useEffect(() => {
    sessionTokenRef.current = sessionToken
  }, [sessionToken])

  useEffect(
    () => () => {
      if (voiceReconnectTimerRef.current !== null) {
        window.clearTimeout(voiceReconnectTimerRef.current)
        voiceReconnectTimerRef.current = null
      }
      if (directVoiceReconnectTimerRef.current !== null) {
        window.clearTimeout(directVoiceReconnectTimerRef.current)
        directVoiceReconnectTimerRef.current = null
      }
    },
    [],
  )

  const pushRoomMessageToast = useCallback((message: ChatMessage) => {
    const toast: RoomMessageToast = {
      ...message,
      toastId: `${message.id}-${Date.now()}`,
    }
    setRoomMessageToasts((current) => [...current.slice(-2), toast].slice(-3))
    const timer = window.setTimeout(() => {
      setRoomMessageToasts((current) => current.filter((item) => item.toastId !== toast.toastId))
      toastTimersRef.current.delete(toast.toastId)
    }, 3000)
    toastTimersRef.current.set(toast.toastId, timer)
  }, [])

  useEffect(
    () => () => {
      toastTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      toastTimersRef.current.clear()
    },
    [],
  )

  useEffect(() => {
    if (!sessionToken) {
      return
    }

    let disposed = false
    void loadAccountSession(sessionToken)
      .then((nextAccount) => {
        if (disposed) {
          return
        }
        setAccount(nextAccount)
        void refreshHomeData(sessionToken)
      })
      .catch(() => {
        localStorage.removeItem(authStorageKey)
        localStorage.removeItem(activeRoomStorageKey)
        if (!disposed) {
          setSessionToken('')
          setAccount(null)
        }
      })
      .finally(() => {
        if (!disposed) {
          setBooting(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [refreshHomeData, sessionToken])

  useEffect(() => {
    if (!sessionToken || !account || window.__PAOTUAN_DISABLE_REALTIME__) {
      return
    }

    const socket = io(getApiBase() || '/', {
      transports: ['websocket', 'polling'],
      auth: { token: sessionToken },
    })
    homeSocketRef.current = socket

    let roomsRefreshTimer: number | null = null
    const refreshRooms = () => {
      if (roomsRefreshTimer !== null) {
        window.clearTimeout(roomsRefreshTimer)
      }
      roomsRefreshTimer = window.setTimeout(() => {
        roomsRefreshTimer = null
        void refreshRoomLists()
      }, 350)
    }
    socket.on('rooms:changed', refreshRooms)
    socket.on('auth:revoked', clearAuthenticatedClientState)
    socket.on('direct:message', (message: DirectMessage) => {
      setDirectMessageEvents((current) => mergeDirectMessageList(current, [message]).slice(-120))
    })
    socket.on('direct-call:invite', updateDirectCallState)
    socket.on('direct-call:accepted', updateDirectCallState)
    socket.on('direct-call:rejected', updateDirectCallState)
    socket.on('direct-call:ended', updateDirectCallState)
    socket.on('direct-call:sync', syncDirectCallState)
    const syncHomeState = () => {
      socket.emit('home:sync', { token: sessionToken }, (response?: { ok?: boolean; currentCall?: DirectCallEvent | null }) => {
        if (response?.ok) {
          syncDirectCallState({ currentCall: response.currentCall ?? null })
        }
      })
    }
    socket.on('connect', syncHomeState)
    if (socket.connected) {
      syncHomeState()
    }
    socket.on('friends:changed', (nextFriends: FriendSummary[]) => {
      if (Array.isArray(nextFriends)) {
        setFriends(nextFriends)
      } else {
        void loadFriends(sessionToken).then(setFriends).catch(() => undefined)
      }
    })

    return () => {
      if (roomsRefreshTimer !== null) {
        window.clearTimeout(roomsRefreshTimer)
      }
      socket.off('connect', syncHomeState)
      socket.off('direct-call:sync', syncDirectCallState)
      socket.disconnect()
      if (homeSocketRef.current === socket) {
        homeSocketRef.current = null
      }
    }
  }, [account, clearAuthenticatedClientState, refreshRoomLists, sessionToken, syncDirectCallState, updateDirectCallState])

  useEffect(() => {
    if (!account || !sessionToken || activeRoomId) {
      return
    }
    const restoreKey = `${account.id}:${sessionToken}`
    if (activeRoomRestoreKeyRef.current === restoreKey) {
      return
    }
    activeRoomRestoreKeyRef.current = restoreKey

    const stored = loadStoredActiveRoom(account.id)
    if (!stored) {
      const staleStored = loadStoredActiveRoom()
      if (staleStored && staleStored.accountId !== account.id) {
        localStorage.removeItem(activeRoomStorageKey)
      }
      return
    }

    let disposed = false
    void (async () => {
      try {
        let nextRoom: RoomState | null = null
        try {
          const storedRoom = await loadRoom(stored.roomId, sessionToken)
          if (!storedRoom.online) {
            localStorage.removeItem(activeRoomStorageKey)
            if (!disposed) {
              setRoom(null)
              setActiveRoomId('')
              setRoomMinimized(false)
              setPage('lobby')
              void refreshHomeData(sessionToken)
            }
            return
          }
          nextRoom = storedRoom
        } catch {
          nextRoom = await joinRoom(stored.roomId, sessionToken, stored.role, { resume: true })
        }
        if (disposed) {
          return
        }
        setRoom(nextRoom)
        setActiveRoomId(nextRoom.id)
        setRoomMinimized(stored.minimized)
        setRoomTab(defaultRoomTabFor(nextRoom))
        setPage(stored.minimized ? 'lobby' : 'room')
        void refreshHomeData(sessionToken)
      } catch {
        localStorage.removeItem(activeRoomStorageKey)
        if (!disposed) {
          setRoom(null)
          setActiveRoomId('')
          setRoomMinimized(false)
          setPage('lobby')
          void refreshHomeData(sessionToken)
        }
      }
    })()

    return () => {
      disposed = true
    }
  }, [account, activeRoomId, refreshHomeData, sessionToken])

  useEffect(() => {
    if (!activeRoomId || !sessionToken || !account) {
      return
    }

    let disposed = false
    void loadRoom(activeRoomId, sessionToken)
      .then((nextRoom) => {
        if (!disposed) {
          setRoom(nextRoom)
          setSelectedTokenId(nextRoom.scene.tokens[0]?.id ?? '')
        }
      })
      .catch(() => {
        if (!disposed) {
          localStorage.removeItem(activeRoomStorageKey)
          setRoom(null)
          setActiveRoomId('')
          setPage('lobby')
        }
      })

    return () => {
      disposed = true
    }
  }, [account, activeRoomId, sessionToken])

  const currentRoomMember = useMemo(
    () => room?.members.find((member) => member.accountId === account?.id) ?? null,
    [account?.id, room],
  )
  const storedCurrentRoomRole = account ? loadStoredActiveRoom(account.id) : null
  const currentRoomRole =
    currentRoomMember?.role ??
    (storedCurrentRoomRole?.roomId === activeRoomId ? storedCurrentRoomRole.role : undefined) ??
    account?.role ??
    'player'
  const socketRoomId = room?.id

  useEffect(() => {
    currentRoomRoleRef.current = currentRoomRole
  }, [currentRoomRole])

  useEffect(() => {
    if (!account || !activeRoomId) {
      return
    }
    localStorage.setItem(
      activeRoomStorageKey,
      JSON.stringify({
        accountId: account.id,
        minimized: roomMinimized,
        role: currentRoomRole,
        roomId: activeRoomId,
      } satisfies StoredActiveRoom),
    )
  }, [account, activeRoomId, currentRoomRole, roomMinimized])

  const rejoinRoomSocket = useCallback(
    (targetRoomId: string) => {
      const socket = socketRef.current
      if (!socket || !account || !sessionToken) {
        return
      }

      const role = currentRoomRoleRef.current
      socket.emit(
        'room:join',
        {
          roomId: targetRoomId,
          displayName: account.displayName,
          resume: true,
          role,
          token: sessionToken,
        },
        (response: { ok: true; room: RoomState } | { ok: false; error: unknown }) => {
          if (response.ok) {
            setRoom(response.room)
            if (liveKitRef.current || voiceStatusRef.current === 'demo') {
              socket.emit('voice:join', {
                roomId: targetRoomId,
                token: sessionToken,
                muted: voiceMutedRef.current,
              })
            }
            return
          }
          if (roomRef.current?.id === targetRoomId) {
            localStorage.removeItem(activeRoomStorageKey)
            cleanupVoiceConnection()
            setRoom(null)
            setActiveRoomId('')
            setRoomMinimized(false)
            setPage('lobby')
            void refreshHomeData(sessionToken)
          }
        },
      )
    },
    [account, cleanupVoiceConnection, refreshHomeData, sessionToken],
  )

  const suspendCurrentRoom = useCallback(() => {
    const currentRoomId = roomRef.current?.id
    setRoomMinimized(true)
    setPage('lobby')
    if (currentRoomId) {
      rejoinRoomSocket(currentRoomId)
    }
    void refreshHomeData(sessionTokenRef.current)
  }, [refreshHomeData, rejoinRoomSocket])

  useEffect(() => {
    const previous = window.__PAOTUAN_HANDLE_NATIVE_BACK__
    window.__PAOTUAN_HANDLE_NATIVE_BACK__ = runNativeBackHandlers
    return () => {
      if (window.__PAOTUAN_HANDLE_NATIVE_BACK__ === runNativeBackHandlers) {
        window.__PAOTUAN_HANDLE_NATIVE_BACK__ = previous
      }
    }
  }, [])

  useNativeBackHandler(() => {
    if (pageRef.current === 'room' && roomRef.current) {
      suspendCurrentRoom()
      return true
    }
    if (pageRef.current !== 'lobby') {
      setPage('lobby')
      return true
    }
    return false
  }, -100)

  useEffect(() => {
    if (!socketRoomId || !account || window.__PAOTUAN_DISABLE_REALTIME__) {
      return
    }

    const socket = io(getApiBase() || '/', {
      transports: ['websocket', 'polling'],
      auth: { displayName: account.displayName, role: currentRoomRoleRef.current, token: sessionToken },
    })

    socketRef.current = socket
    const joinCurrentRoom = () => {
      rejoinRoomSocket(socketRoomId)
    }
    socket.on('connect', joinCurrentRoom)
    if (socket.connected) {
      joinCurrentRoom()
    }

    socket.on('room:state', (nextRoom: RoomState) => {
      if (nextRoom.id !== socketRoomId) {
        return
      }
      setRoom(nextRoom)
      setSelectedTokenId((current) => current || nextRoom.scene.tokens[0]?.id || '')
    })
    socket.on('voice:state', (payload: VoiceStateEvent) => {
      setRoom((current) =>
        current && current.id === payload.roomId
          ? {
              ...current,
              voice: {
                ...current.voice,
                participants: payload.participants,
              },
            }
          : current,
      )
    })
    socket.on('chat:message', (message: ChatMessage) => {
      if (message.roomId !== socketRoomId) {
        return
      }
      const pendingMessage = message.clientMessageId
        ? pendingRoomMessagesRef.current.get(message.clientMessageId)
        : undefined
      const pendingMessageRetry =
        message.clientMessageId && pendingRoomMessageRetryRef.current?.clientMessageId === message.clientMessageId
          ? pendingRoomMessageRetryRef.current
          : null
      if (message.clientMessageId && (pendingMessage || pendingMessageRetry)) {
        pendingRoomMessagesRef.current.delete(message.clientMessageId)
        pendingRoomMessageRetryRef.current = null
        setRoomChatStatus('')
        const confirmedText = pendingMessage?.text ?? pendingMessageRetry?.text ?? ''
        setChatDraft((current) => (current === confirmedText ? '' : current))
        markRoomMessageConfirmed(message.roomId, 'chat', message.clientMessageId, pendingMessage?.replyToId ?? pendingMessageRetry?.replyToId)
      }
      const pendingDiceRetry =
        message.clientMessageId &&
        message.messageType === 'dice' &&
        pendingRoomDiceRetryRef.current?.clientMessageId === message.clientMessageId
          ? pendingRoomDiceRetryRef.current
          : null
      if (message.clientMessageId && pendingDiceRetry) {
        pendingRoomDiceRetryRef.current = null
        if (message.roll) {
          setRoomDiceCooldownUntil(0)
          setLastRoll(message.roll.text)
        }
        markRoomMessageConfirmed(message.roomId, 'dice', message.clientMessageId, pendingDiceRetry.replyToId)
      }
      setRoom((current) =>
        current?.id === socketRoomId
          ? { ...current, messages: mergeRoomMessageCache(current.messages, [message]) }
          : current,
      )
      if (pageRef.current !== 'room' || roomMinimizedRef.current || roomTabRef.current !== 'chat') {
        pushRoomMessageToast(message)
      }
    })
    socket.on('scene:tokenMoved', (payload: { roomId?: string; tokenId: string; x: number; y: number }) => {
      if (payload.roomId !== socketRoomId) {
        return
      }
      const pendingKey = `${socketRoomId}:${payload.tokenId}`
      const pending = pendingTokenMutationsRef.current.get(pendingKey)
      if (
        pending &&
        pending.roomId === socketRoomId &&
        (pending.x !== payload.x || pending.y !== payload.y)
      ) {
        return
      }
      setRoom((current) =>
        current?.id === socketRoomId ? moveToken(current, payload.tokenId, payload.x, payload.y) : current,
      )
    })
    socket.on('character:updated', (payload: Character & { roomId?: string }) => {
      if (payload.roomId !== socketRoomId) {
        return
      }
      const character = payload
      const pendingKey = `${socketRoomId}:${character.id}`
      const pending = pendingCharacterMutationsRef.current.get(pendingKey)
      if (
        pending &&
        pending.roomId === socketRoomId &&
        (pending.hp !== character.hp || pending.sanity !== character.sanity)
      ) {
        return
      }
      setRoom((current) =>
        current?.id === socketRoomId
          ? {
              ...current,
              characters: current.characters.map((item) =>
                item.id === character.id ? character : item,
              ),
            }
          : current,
      )
    })
    const clearActiveRoom = () => {
      localStorage.removeItem(activeRoomStorageKey)
      cleanupVoiceConnection()
      setRoom(null)
      setActiveRoomId('')
      setRoomMinimized(false)
      setPage('lobby')
      void refreshHomeData()
    }
    const handleRoomClosed = (closedRoom: RoomState) => {
      if (closedRoom.id === socketRoomId) {
        clearActiveRoom()
      }
    }
    socket.on('room:closed', handleRoomClosed)
    const handleRoomDeleted = (payload?: { roomId?: string }) => {
      if (!payload?.roomId || payload.roomId === socketRoomId) {
        clearActiveRoom()
      }
    }
    socket.on('room:deleted', handleRoomDeleted)
    socket.on('room:left', handleRoomDeleted)

    return () => {
      socket.off('connect', joinCurrentRoom)
      socket.off('room:closed', handleRoomClosed)
      socket.off('room:deleted', handleRoomDeleted)
      socket.off('room:left', handleRoomDeleted)
      socket.disconnect()
      if (socketRef.current === socket) {
        socketRef.current = null
      }
    }
  }, [account, cleanupVoiceConnection, markRoomMessageConfirmed, pushRoomMessageToast, refreshHomeData, rejoinRoomSocket, sessionToken, socketRoomId])

  const applyParticipantVolumes = useCallback(
    (targetRoom = liveKitRef.current) => {
      if (!targetRoom) {
        return
      }
      targetRoom.remoteParticipants.forEach((participant) => {
        const nextVolume = voiceVolumes[accountIdFromVoiceIdentity(participant.identity)] ?? 100
        participant.setVolume(nextVolume / 100)
      })
    },
    [voiceVolumes],
  )

  const applyDirectParticipantVolumes = useCallback(
    (targetRoom = directLiveKitRef.current) => {
      if (!targetRoom) {
        return
      }
      targetRoom.remoteParticipants.forEach((participant) => {
        const nextVolume = voiceVolumes[accountIdFromVoiceIdentity(participant.identity)] ?? 100
        participant.setVolume(nextVolume / 100)
      })
    },
    [voiceVolumes],
  )

  useEffect(() => {
    localStorage.setItem(voiceVolumeStorageKey, JSON.stringify(voiceVolumes))
    applyParticipantVolumes()
    applyDirectParticipantVolumes()
  }, [applyDirectParticipantVolumes, applyParticipantVolumes, voiceVolumes])

  useEffect(() => {
    if (!account || !sessionToken || page !== 'lobby') {
      return
    }

    const timer = window.setInterval(() => {
      void Promise.all([loadRooms(sessionToken), loadRooms(sessionToken, 'closed')])
        .then(([nextRooms, nextClosedRooms]) => {
          setRooms(nextRooms)
          setClosedRooms(nextClosedRooms)
        })
        .catch(() => undefined)
    }, 5000)

    return () => window.clearInterval(timer)
  }, [account, page, sessionToken])

  const selectedToken = useMemo(
    () => room?.scene.tokens.find((token) => token.id === selectedTokenId) ?? null,
    [room, selectedTokenId],
  )

  const selectedCharacter = useMemo(() => {
    if (!room || !selectedToken) {
      return null
    }

    return room.characters.find((character) => character.id === selectedToken.characterId) ?? null
  }, [room, selectedToken])

  const boardStyle = room
    ? ({
        '--cols': room.scene.width,
        '--rows': room.scene.height,
      } as CSSProperties)
    : undefined

  const leaveCurrentRoom = useCallback(async (options: { bestEffort?: boolean } = {}) => {
    if (!room || !sessionToken) {
      return true
    }

    if (options.bestEffort) {
      socketRef.current?.emit('room:leave', {
        roomId: room.id,
        token: sessionToken,
      })
      try {
        await leaveRoom(room.id, sessionToken)
        return true
      } catch {
        return false
      }
    }

    await leaveRoom(room.id, sessionToken)
    return true
  }, [room, sessionToken])

  const handleAuthSuccess = (session: { token: string; account: Account }) => {
    localStorage.setItem(authStorageKey, session.token)
    setSessionToken(session.token)
    setAccount(session.account)
    setPage('lobby')
    void refreshHomeData(session.token)
  }

  const handleSignOut = () => {
    const token = sessionToken
    void endAcceptedDirectCallBestEffort().finally(() => leaveCurrentRoom({ bestEffort: true })).finally(() => {
      if (token) {
        void logoutAccount(token).catch(() => undefined)
      }
    })
    clearAuthenticatedClientState()
  }

  const unreadDirectCount = useMemo(
    () => friends.reduce((count, friend) => count + (friend.direction === 'friend' ? friend.unreadCount ?? 0 : 0), 0),
    [friends],
  )
  const incomingFriendRequestCount = useMemo(
    () => friends.filter((friend) => friend.direction === 'incoming').length,
    [friends],
  )

  const enterRoom = async (roomSummary: RoomSummary, role: UserRole) => {
    if (!sessionToken) {
      return
    }
    if (roomMinimized && activeRoomId && activeRoomId !== roomSummary.id) {
      return
    }
    const nextRoom = await joinRoom(roomSummary.id, sessionToken, role)
    setRoom(nextRoom)
    setActiveRoomId(nextRoom.id)
    setRoomMinimized(false)
    setRoomTab(defaultRoomTabFor(nextRoom))
    setPage('room')
    await refreshHomeData()
  }

  const updateToken = useCallback(
    (token: MapToken, x: number, y: number) => {
      const sourceRoom = roomRef.current
      const tokenValue = sessionTokenRef.current
      if (!sourceRoom || !tokenValue) {
        return
      }

      const previousToken = sourceRoom.scene.tokens.find((item) => item.id === token.id)
      if (!previousToken) {
        return
      }
      const optimisticRoom = moveToken(sourceRoom, token.id, x, y)
      const targetToken = optimisticRoom.scene.tokens.find((item) => item.id === token.id)
      if (!targetToken) {
        return
      }
      const mutationKey = `${sourceRoom.id}:${token.id}`
      const mutationSeq = tokenMutationSeqRef.current + 1
      tokenMutationSeqRef.current = mutationSeq
      pendingTokenMutationsRef.current.set(mutationKey, {
        roomId: sourceRoom.id,
        seq: mutationSeq,
        x: targetToken.x,
        y: targetToken.y,
      })
      setRoom(optimisticRoom)

      const applyServerToken = (serverToken: MapToken) => {
        const pending = pendingTokenMutationsRef.current.get(mutationKey)
        if (!pending || pending.seq !== mutationSeq) {
          return
        }
        pendingTokenMutationsRef.current.delete(mutationKey)
        setRoom((current) =>
          current?.id === sourceRoom.id ? moveToken(current, serverToken.id, serverToken.x, serverToken.y) : current,
        )
      }
      const rollbackToken = () => {
        const pending = pendingTokenMutationsRef.current.get(mutationKey)
        if (!pending || pending.seq !== mutationSeq) {
          return
        }
        pendingTokenMutationsRef.current.delete(mutationKey)
        setRoom((current) => {
          if (!current || current.id !== sourceRoom.id) {
            return current
          }
          const currentToken = current.scene.tokens.find((item) => item.id === token.id)
          if (!currentToken || currentToken.x !== targetToken.x || currentToken.y !== targetToken.y) {
            return current
          }
          return moveToken(current, token.id, previousToken.x, previousToken.y)
        })
      }

      void (async () => {
        try {
          const socket = socketRef.current
          if (socket?.connected) {
            const response = await emitSocketAck<MapToken>(
              socket,
              'scene:moveToken',
              {
                roomId: sourceRoom.id,
                token: tokenValue,
                tokenId: token.id,
                x,
                y,
              },
              '移动超时，请检查网络后重试',
            )
            if (response.ok) {
              applyServerToken(response.data)
              return
            }
            if (!isSocketTimeout(response.error)) {
              throw new Error(describeError(response.error, '服务器拒绝本次移动'))
            }
          }

          const serverToken = await moveRoomToken(tokenValue, sourceRoom.id, token.id, x, y)
          applyServerToken(serverToken)
        } catch (error) {
          rollbackToken()
          setLastRoll(`移动失败：${describeError(error, '请检查网络或权限')}`)
        }
      })()
    },
    [],
  )

  const handleBoardClick = (event: PointerEvent<HTMLDivElement>) => {
    if (!room || !selectedToken) {
      return
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    const x = Math.ceil(((event.clientX - bounds.left) / bounds.width) * room.scene.width)
    const y = Math.ceil(((event.clientY - bounds.top) / bounds.height) * room.scene.height)
    updateToken(selectedToken, x, y)
  }

  const submitMessage = async (text: string, options: { replyToId?: string } = {}) => {
    const trimmed = text.trim()
    if (!room || !account || !trimmed) {
      return false
    }
    const cooldownSeconds = remainingCooldownSeconds(roomMessageCooldownUntil)
    if (cooldownSeconds > 0) {
      setRoomChatStatus(`发送过于频繁，请 ${cooldownSeconds} 秒后再试。`)
      return false
    }

    setChatDraft('')
    setRoomChatStatus('')
    const pendingRetry = pendingRoomMessageRetryRef.current
    const clientMessageId =
      pendingRetry &&
      pendingRetry.roomId === room.id &&
      pendingRetry.text === trimmed &&
      pendingRetry.replyToId === options.replyToId
        ? pendingRetry.clientMessageId
        : buildId('chat')
    pendingRoomMessageRetryRef.current = null
    pendingRoomMessagesRef.current.set(clientMessageId, { roomId: room.id, text: trimmed, replyToId: options.replyToId })
    const socket = socketRef.current
    if (socket?.connected) {
      const response = await new Promise<SocketAck<ChatMessage>>((resolve) => {
        const timer = window.setTimeout(() => {
          resolve({ ok: false, error: '发送超时，请检查网络后重试' })
        }, 7000)
        socket.emit(
          'chat:send',
          {
            roomId: room.id,
            token: sessionToken,
            message: {
              text: trimmed,
              clientMessageId,
              ...options,
            },
          },
          (ack: SocketAck<ChatMessage>) => {
            window.clearTimeout(timer)
            resolve(ack)
          },
        )
      })
      if (response.ok) {
        pendingRoomMessagesRef.current.delete(clientMessageId)
        pendingRoomMessageRetryRef.current = null
        setRoomMessageCooldownUntil(0)
        markRoomMessageConfirmed(room.id, 'chat', clientMessageId, options.replyToId)
        setRoom((current) =>
          current?.id === room.id
            ? { ...current, messages: mergeRoomMessageCache(current.messages, [response.data]) }
            : current,
        )
        return true
      }
      if (!pendingRoomMessagesRef.current.has(clientMessageId)) {
        return true
      }
      if (isSocketTimeout(response.error)) {
        try {
          const message = await sendChatMessage(sessionToken, room.id, trimmed, { ...options, clientMessageId })
          pendingRoomMessagesRef.current.delete(clientMessageId)
          pendingRoomMessageRetryRef.current = null
          setRoomMessageCooldownUntil(0)
          markRoomMessageConfirmed(room.id, 'chat', clientMessageId, options.replyToId)
          setRoom((current) =>
            current?.id === room.id
              ? { ...current, messages: mergeRoomMessageCache(current.messages, [message]) }
              : current,
          )
          return true
        } catch (error) {
          if (!pendingRoomMessagesRef.current.has(clientMessageId)) {
            pendingRoomMessageRetryRef.current = null
            setRoomMessageCooldownUntil(0)
            setRoomChatStatus('')
            return true
          }
          pendingRoomMessagesRef.current.delete(clientMessageId)
          pendingRoomMessageRetryRef.current = { roomId: room.id, text: trimmed, replyToId: options.replyToId, clientMessageId }
          const cooldownUntil = cooldownUntilFrom(error)
          if (cooldownUntil) {
            setRoomMessageCooldownUntil(cooldownUntil)
          }
          setChatDraft(trimmed)
          setRoomChatStatus(`发送失败：${formatErrorWithRetry(error, '请检查网络后重试')}`)
          return false
        }
      } else {
        pendingRoomMessagesRef.current.delete(clientMessageId)
      }
      pendingRoomMessageRetryRef.current = { roomId: room.id, text: trimmed, replyToId: options.replyToId, clientMessageId }
      const cooldownUntil = cooldownUntilFrom(response)
      if (cooldownUntil) {
        setRoomMessageCooldownUntil(cooldownUntil)
      }
      setChatDraft(trimmed)
      setRoomChatStatus(`发送失败：${formatErrorWithRetry(response, '服务器拒绝本次消息')}`)
      return false
    }

    try {
      const message = await sendChatMessage(sessionToken, room.id, trimmed, { ...options, clientMessageId })
      pendingRoomMessagesRef.current.delete(clientMessageId)
      pendingRoomMessageRetryRef.current = null
      setRoomMessageCooldownUntil(0)
      markRoomMessageConfirmed(room.id, 'chat', clientMessageId, options.replyToId)
      setRoom((current) =>
        current?.id === room.id
          ? { ...current, messages: mergeRoomMessageCache(current.messages, [message]) }
          : current,
      )
      return true
    } catch (error) {
      pendingRoomMessagesRef.current.delete(clientMessageId)
      pendingRoomMessageRetryRef.current = { roomId: room.id, text: trimmed, replyToId: options.replyToId, clientMessageId }
      const cooldownUntil = cooldownUntilFrom(error)
      if (cooldownUntil) {
        setRoomMessageCooldownUntil(cooldownUntil)
      }
      setChatDraft(trimmed)
      setRoomChatStatus(`发送失败：${formatErrorWithRetry(error, '请检查网络后重试')}`)
      return false
    }
  }

  const rollDice = async (formula = diceFormula, options: { replyToId?: string; diceId?: string } = {}) => {
    const normalized = normalizeDiceFormula(formula)
    if (!isDiceFormulaSupported(formula)) {
      setLastRoll('格式示例：1d100<=60、1d20>=10、2d6+1、.ra 侦查')
      return false
    }

    if (!room || !sessionToken) {
      setLastRoll('请先加入房间再掷骰')
      return false
    }
    const diceCooldownSeconds = remainingCooldownSeconds(roomDiceCooldownUntil)
    if (diceCooldownSeconds > 0) {
      setLastRoll(`掷骰过于频繁，请 ${diceCooldownSeconds} 秒后再试。`)
      return false
    }

    const pendingRetry = pendingRoomDiceRetryRef.current
    const clientMessageId =
      pendingRetry &&
      pendingRetry.roomId === room.id &&
      pendingRetry.formula === normalized &&
      pendingRetry.replyToId === options.replyToId &&
      pendingRetry.diceId === options.diceId
        ? pendingRetry.clientMessageId
        : buildId('roll')
    const retryState: PendingRoomDiceRetry = {
      clientMessageId,
      diceId: options.diceId,
      formula: normalized,
      replyToId: options.replyToId,
      roomId: room.id,
    }
    const rememberDiceRetry = () => {
      pendingRoomDiceRetryRef.current = retryState
    }
    const clearDiceRetry = () => {
      if (pendingRoomDiceRetryRef.current?.clientMessageId === clientMessageId) {
        pendingRoomDiceRetryRef.current = null
      }
    }
    pendingRoomDiceRetryRef.current = null

    const applyRoll = (response: DiceRollResponse) => {
      clearDiceRetry()
      setRoomDiceCooldownUntil(0)
      setDiceFormula(response.roll.formula)
      setLastRoll(response.roll.text)
      markRoomMessageConfirmed(room.id, 'dice', response.message.clientMessageId ?? clientMessageId, options.replyToId)
      setRoom((current) =>
        current?.id === room.id
          ? { ...current, messages: mergeRoomMessageCache(current.messages, [response.message]) }
          : current,
      )
    }

    if (socketRef.current?.connected) {
      const response = await emitSocketAck<DiceRollResponse>(
        socketRef.current,
        'dice:roll',
        {
          roomId: room.id,
          token: sessionToken,
          formula: normalized,
          diceId: options.diceId,
          clientMessageId,
          ...options,
        },
        '连接超时，请检查网络后重试',
      )
      if (response.ok) {
        applyRoll(response.data)
        return true
      }
      if (!isSocketTimeout(response.error)) {
        rememberDiceRetry()
        const cooldownUntil = cooldownUntilFrom(response)
        if (cooldownUntil) {
          setRoomDiceCooldownUntil(cooldownUntil)
        }
        setLastRoll(`掷骰失败：${formatErrorWithRetry(response, '服务器拒绝本次掷骰')}`)
        return false
      }
      try {
        const fallbackResponse = await rollDiceOnServer(sessionToken, room.id, normalized, {
          clientMessageId,
          ...options,
        })
        applyRoll(fallbackResponse)
        return true
      } catch (error) {
        rememberDiceRetry()
        const cooldownUntil = cooldownUntilFrom(error)
        if (cooldownUntil) {
          setRoomDiceCooldownUntil(cooldownUntil)
        }
        setLastRoll(`掷骰失败：${formatErrorWithRetry(error, '请检查网络后重试')}`)
        return false
      }
    }

    try {
      const response = await rollDiceOnServer(sessionToken, room.id, normalized, {
        clientMessageId,
        ...options,
      })
      applyRoll(response)
      return true
    } catch (error) {
      rememberDiceRetry()
      const cooldownUntil = cooldownUntilFrom(error)
      if (cooldownUntil) {
        setRoomDiceCooldownUntil(cooldownUntil)
      }
      setLastRoll(`掷骰失败：${formatErrorWithRetry(error, '请确认已加入在线房间')}`)
      return false
    }
  }

  const handleVitalsChange = async (character: Character, hp: number, sanity: number) => {
    const sourceRoom = roomRef.current
    const tokenValue = sessionTokenRef.current
    if (!sourceRoom || !tokenValue) {
      return
    }

    const previousCharacter = sourceRoom.characters.find((item) => item.id === character.id)
    if (!previousCharacter) {
      return
    }
    const nextRoom = updateCharacterVitals(sourceRoom, character.id, hp, sanity)
    const nextCharacter = nextRoom.characters.find((item) => item.id === character.id)
    if (!nextCharacter) {
      return
    }

    const mutationKey = `${sourceRoom.id}:${character.id}`
    const mutationSeq = characterMutationSeqRef.current + 1
    characterMutationSeqRef.current = mutationSeq
    pendingCharacterMutationsRef.current.set(mutationKey, {
      hp: nextCharacter.hp,
      roomId: sourceRoom.id,
      sanity: nextCharacter.sanity,
      seq: mutationSeq,
    })
    setRoom(nextRoom)

    const applyServerCharacter = (serverCharacter: Character) => {
      const pending = pendingCharacterMutationsRef.current.get(mutationKey)
      if (!pending || pending.seq !== mutationSeq) {
        return
      }
      pendingCharacterMutationsRef.current.delete(mutationKey)
      setRoom((current) =>
        current?.id === sourceRoom.id
          ? {
              ...current,
              characters: current.characters.map((item) =>
                item.id === serverCharacter.id ? serverCharacter : item,
              ),
            }
          : current,
      )
    }
    const rollbackCharacter = () => {
      const pending = pendingCharacterMutationsRef.current.get(mutationKey)
      if (!pending || pending.seq !== mutationSeq) {
        return
      }
      pendingCharacterMutationsRef.current.delete(mutationKey)
      setRoom((current) => {
        if (!current || current.id !== sourceRoom.id) {
          return current
        }
        const currentCharacter = current.characters.find((item) => item.id === character.id)
        if (
          !currentCharacter ||
          currentCharacter.hp !== nextCharacter.hp ||
          currentCharacter.sanity !== nextCharacter.sanity
        ) {
          return current
        }
        return {
          ...current,
          characters: current.characters.map((item) =>
            item.id === previousCharacter.id ? previousCharacter : item,
          ),
        }
      })
    }

    try {
      const socket = socketRef.current
      if (socket?.connected) {
        const response = await emitSocketAck<Character>(
          socket,
          'character:update',
          {
            roomId: sourceRoom.id,
            token: tokenValue,
            character: nextCharacter,
          },
          '角色状态同步超时，请检查网络后重试',
        )
        if (response.ok) {
          applyServerCharacter(response.data)
          return
        }
        if (!isSocketTimeout(response.error)) {
          throw new Error(describeError(response.error, '服务器拒绝本次角色更新'))
        }
      }

      const serverCharacter = await saveCharacter(tokenValue, sourceRoom.id, nextCharacter)
      applyServerCharacter(serverCharacter)
    } catch (error) {
      rollbackCharacter()
      setLastRoll(`角色状态同步失败：${describeError(error, '请检查网络或权限')}`)
    }
  }

  const attachRemoteAudio = useCallback((track: RemoteTrack) => {
    if (track.kind !== 'audio') {
      return
    }

    const audioTrack = track as RemoteAudioTrack
    const trackId = audioTrack.sid ?? audioTrack.mediaStreamTrack.id
    if (remoteAudioElementsRef.current.has(trackId)) {
      return
    }

    const element = audioTrack.attach()
    element.autoplay = true
    element.controls = false
    element.setAttribute('playsinline', 'true')
    element.style.display = 'none'
    document.body.appendChild(element)
    remoteAudioElementsRef.current.set(trackId, [element])
    void element.play().catch(() => {
      setAudioPlaybackBlocked(true)
      setVoiceNote('语音已连接，但系统阻止了播放。请点“恢复语音”启用听筒输出。')
    })
  }, [])

  const attachExistingRemoteAudio = useCallback(
    (targetRoom: LiveKitRoom) => {
      targetRoom.remoteParticipants.forEach((participant) => {
        participant.audioTrackPublications.forEach((publication) => {
          if (publication.track) {
            attachRemoteAudio(publication.track)
          }
        })
      })
    },
    [attachRemoteAudio],
  )

  const attachDirectRemoteAudio = useCallback((track: RemoteTrack) => {
    if (track.kind !== 'audio') {
      return
    }

    const audioTrack = track as RemoteAudioTrack
    const trackId = audioTrack.sid ?? audioTrack.mediaStreamTrack.id
    if (directRemoteAudioElementsRef.current.has(trackId)) {
      return
    }

    const element = audioTrack.attach()
    element.autoplay = true
    element.controls = false
    element.setAttribute('playsinline', 'true')
    element.style.display = 'none'
    document.body.appendChild(element)
    directRemoteAudioElementsRef.current.set(trackId, [element])
    void element.play().catch(() => {
      setDirectAudioPlaybackBlocked(true)
      setDirectVoiceNote('好友语音已连接，但系统阻止了播放。请点“恢复语音”。')
    })
  }, [])

  const attachExistingDirectRemoteAudio = useCallback(
    (targetRoom: LiveKitRoom) => {
      targetRoom.remoteParticipants.forEach((participant) => {
        participant.audioTrackPublications.forEach((publication) => {
          if (publication.track) {
            attachDirectRemoteAudio(publication.track)
          }
        })
      })
    },
    [attachDirectRemoteAudio],
  )

  const scheduleDirectVoiceReconnect = useCallback(() => {
    const target = directVoiceTargetRef.current
    if (!directVoiceWantedRef.current || !target || !sessionTokenRef.current) {
      return
    }
    if (directVoiceReconnectTimerRef.current !== null) {
      return
    }
    if (directVoiceReconnectAttemptsRef.current >= 30) {
      directVoiceWantedRef.current = false
      setDirectVoiceStatus('error')
      setDirectVoiceNote('网络中断时间过长，好友语音已断开，请重新呼叫')
      return
    }

    const attempt = Math.min(directVoiceReconnectAttemptsRef.current + 1, 6)
    directVoiceReconnectAttemptsRef.current += 1
    const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000)
    directVoiceReconnectTimerRef.current = window.setTimeout(() => {
      directVoiceReconnectTimerRef.current = null
      const nextTarget = directVoiceTargetRef.current
      if (!directVoiceWantedRef.current || !nextTarget || nextTarget.callId !== target.callId) {
        return
      }
      void connectDirectVoiceRef.current?.(nextTarget.event, { reconnecting: true })
    }, delay)
  }, [])

  const connectDirectVoice = useCallback(async (event: DirectCallEvent, options: { reconnecting?: boolean } = {}) => {
    const currentAccount = accountRef.current
    const token = sessionTokenRef.current
    if (!currentAccount || !token || event.status !== 'accepted') {
      return
    }
    if (pendingDirectLiveKitRef.current || (options.reconnecting && directLiveKitRef.current)) {
      setDirectVoiceStatus('connecting')
      setDirectVoiceNote(options.reconnecting ? '好友语音正在保持连接' : '好友语音正在连接中')
      return
    }

    const peer = directCallPeer(event, currentAccount.id)
    if (!peer.id) {
      return
    }
    const generation = directVoiceConnectGenerationRef.current + 1
    directVoiceConnectGenerationRef.current = generation
    directVoiceWantedRef.current = true
    directVoiceTargetRef.current = { callId: event.callId, event, peerId: peer.id, peerName: peer.name }
    clearDirectVoiceReconnectTimer()
    setDirectVoiceStatus('connecting')
    setDirectVoiceNote(options.reconnecting ? '好友语音网络波动，正在重新连接' : '正在请求好友语音令牌')

    const isCurrentDirectAttempt = () =>
      directVoiceConnectGenerationRef.current === generation &&
      directVoiceWantedRef.current &&
      directVoiceTargetRef.current?.callId === event.callId

    let response: VoiceTokenResponse
    try {
      response = await requestDirectVoiceToken(token, peer.id, event.callId, directVoiceSessionIdRef.current)
    } catch (error) {
      if (!isCurrentDirectAttempt()) {
        return
      }
      const requestError = error as ApiRequestError
      if (requestError.status === 403 || requestError.status === 404) {
        directVoiceWantedRef.current = false
        setDirectVoiceStatus('error')
        setDirectVoiceNote('好友通话已结束或对方离线，请重新呼叫')
        homeSocketRef.current?.emit('home:sync', { token }, (response?: { ok?: boolean; currentCall?: DirectCallEvent | null }) => {
          if (response?.ok) {
            syncDirectCallState({ currentCall: response.currentCall ?? null })
          }
        })
        return
      }
      if (options.reconnecting && directVoiceWantedRef.current) {
        setDirectVoiceNote('好友语音重连失败，继续重试')
        scheduleDirectVoiceReconnect()
        return
      }
      setDirectVoiceStatus('error')
      setDirectVoiceNote('好友语音连接失败，请确认对方已接听并检查网络')
      return
    }

    if (!isCurrentDirectAttempt()) {
      return
    }

    if (!response.configured || !response.url || !response.token) {
      directVoiceReconnectAttemptsRef.current = 0
      setDirectAudioPlaybackBlocked(false)
      setDirectVoiceStatus('demo')
      setDirectVoiceNote(response.reason ?? '语音服务未启用，当前仅显示通话状态，未传输音频。')
      return
    }

    let LiveKitRoomCtor: LiveKitClientRuntime['Room']
    let RoomEvent: LiveKitClientRuntime['RoomEvent']
    try {
      ;({ Room: LiveKitRoomCtor, RoomEvent } = await loadLiveKitClient())
    } catch {
      if (!isCurrentDirectAttempt()) {
        return
      }
      if (options.reconnecting && directVoiceWantedRef.current) {
        setDirectVoiceStatus('connecting')
        setDirectVoiceNote('好友语音资源加载失败，继续重试')
        scheduleDirectVoiceReconnect()
        return
      }
      setDirectVoiceStatus('error')
      setDirectVoiceNote('好友语音资源加载失败，请检查网络后重试。')
      return
    }
    let liveKitRoom: LiveKitRoom | null = null
    let suppressDisconnectHandler = false

    try {
      liveKitRoom = new LiveKitRoomCtor({
        adaptiveStream: true,
        dynacast: true,
      })
      const connectionRoom = liveKitRoom
      pendingDirectLiveKitRef.current = connectionRoom

      connectionRoom.on(RoomEvent.Disconnected, () => {
        if (directLiveKitRef.current !== connectionRoom && pendingDirectLiveKitRef.current !== connectionRoom) {
          return
        }
        detachDirectRemoteAudio()
        if (directLiveKitRef.current === connectionRoom) {
          directLiveKitRef.current = null
        }
        if (pendingDirectLiveKitRef.current === connectionRoom) {
          pendingDirectLiveKitRef.current = null
        }
        if (suppressDisconnectHandler) {
          return
        }
        if (!isCurrentDirectAttempt()) {
          setDirectVoiceStatus('idle')
          setDirectVoiceNote('好友语音已断开')
          return
        }
        setDirectVoiceStatus('connecting')
        setDirectVoiceNote('好友语音网络波动，正在自动重连')
        scheduleDirectVoiceReconnect()
      })
      connectionRoom.on(RoomEvent.Reconnecting, () => {
        if (directLiveKitRef.current !== connectionRoom) {
          return
        }
        setDirectVoiceStatus('connecting')
        setDirectVoiceNote('好友语音网络波动，正在保持连接')
      })
      connectionRoom.on(RoomEvent.Reconnected, () => {
        if (directLiveKitRef.current !== connectionRoom || !isCurrentDirectAttempt()) {
          return
        }
        directVoiceReconnectAttemptsRef.current = 0
        attachExistingDirectRemoteAudio(connectionRoom)
        applyDirectParticipantVolumes(connectionRoom)
        setDirectAudioPlaybackBlocked(!connectionRoom.canPlaybackAudio)
        setDirectVoiceStatus('connected')
        setDirectVoiceNote(
          connectionRoom.canPlaybackAudio
            ? noiseSuppression
              ? '好友高清语音已恢复，系统降噪已开启'
              : '好友高清语音已恢复'
            : '好友语音已恢复连接，但系统阻止了播放。请点“恢复语音”。',
        )
      })
      connectionRoom.on(RoomEvent.MediaDevicesError, () => {
        if (directLiveKitRef.current !== connectionRoom && pendingDirectLiveKitRef.current !== connectionRoom) {
          return
        }
        setDirectVoiceStatus('error')
        setDirectVoiceNote('麦克风权限或设备异常')
      })
      connectionRoom.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
        if (directLiveKitRef.current !== connectionRoom) {
          return
        }
        setDirectAudioPlaybackBlocked(!playing)
        if (!playing) {
          setDirectVoiceNote('好友语音已连接，但系统阻止了播放。请点“恢复语音”。')
        }
      })
      connectionRoom.on(RoomEvent.TrackSubscribed, (track) => {
        if (directLiveKitRef.current !== connectionRoom) {
          return
        }
        attachDirectRemoteAudio(track)
        applyDirectParticipantVolumes(connectionRoom)
      })
      connectionRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (directLiveKitRef.current !== connectionRoom) {
          return
        }
        detachDirectRemoteAudio(track)
      })

      await connectionRoom.connect(response.url, response.token)
      if (!isCurrentDirectAttempt()) {
        suppressDisconnectHandler = true
        pendingDirectLiveKitRef.current = null
        void connectionRoom.disconnect()
        return
      }
      try {
        await connectionRoom.startAudio()
        if (!isCurrentDirectAttempt()) {
          suppressDisconnectHandler = true
          pendingDirectLiveKitRef.current = null
          void connectionRoom.disconnect()
          return
        }
        setDirectAudioPlaybackBlocked(!connectionRoom.canPlaybackAudio)
      } catch {
        setDirectAudioPlaybackBlocked(true)
      }
      let directReadyConfirmed = false
      let directReadyTerminalError: ApiRequestError | null = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await confirmDirectVoiceReady(token, peer.id, event.callId)
          directReadyConfirmed = true
          break
        } catch (error) {
          const requestError = error as ApiRequestError
          if (!isCurrentDirectAttempt()) {
            return
          }
          if (requestError.status === 403 || requestError.status === 404) {
            directReadyTerminalError = requestError
            break
          }
          if (attempt < 2) {
            setDirectVoiceStatus('connecting')
            setDirectVoiceNote('好友语音切换确认失败，正在重试')
            await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)))
            if (!isCurrentDirectAttempt()) {
              return
            }
          }
        }
      }
      if (!directReadyConfirmed) {
        suppressDisconnectHandler = true
        pendingDirectLiveKitRef.current = null
        void Promise.resolve(connectionRoom.disconnect()).catch(() => undefined)
        if (!isCurrentDirectAttempt()) {
          return
        }
        if (directReadyTerminalError) {
          directVoiceWantedRef.current = false
          setDirectVoiceStatus('error')
          setDirectVoiceNote('好友通话已结束或服务器拒绝切换，请重新呼叫')
          homeSocketRef.current?.emit('home:sync', { token }, (response?: { ok?: boolean; currentCall?: DirectCallEvent | null }) => {
            if (response?.ok) {
              syncDirectCallState({ currentCall: response.currentCall ?? null })
            }
          })
          return
        }
        setDirectVoiceStatus('connecting')
        setDirectVoiceNote(options.reconnecting ? '好友语音切换确认失败，继续重试' : '好友语音切换确认失败，正在同步状态并重试')
        homeSocketRef.current?.emit('home:sync', { token }, (response?: { ok?: boolean; currentCall?: DirectCallEvent | null }) => {
          if (response?.ok) {
            syncDirectCallState({ currentCall: response.currentCall ?? null })
          }
        })
        scheduleDirectVoiceReconnect()
        return
      }
      if (liveKitRef.current || pendingLiveKitRef.current || voiceWantedRef.current || voiceStatusRef.current === 'demo') {
        cleanupVoiceConnection()
      }
      const shouldMute = directVoiceMutedRef.current
      let microphoneError = false
      try {
        await connectionRoom.localParticipant.setMicrophoneEnabled(!shouldMute, {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression,
        })
      } catch {
        microphoneError = true
      }
      if (!isCurrentDirectAttempt()) {
        suppressDisconnectHandler = true
        pendingDirectLiveKitRef.current = null
        void connectionRoom.disconnect()
        return
      }
      pendingDirectLiveKitRef.current = null
      directLiveKitRef.current = connectionRoom
      attachExistingDirectRemoteAudio(connectionRoom)
      applyDirectParticipantVolumes(connectionRoom)
      setDirectVoiceMuted(microphoneError ? true : shouldMute)
      setDirectVoiceStatus('connected')
      directVoiceReconnectAttemptsRef.current = 0
      setDirectVoiceNote(
        microphoneError
          ? '好友语音已连接，但麦克风权限异常。请检查权限后点“开麦”。'
          : connectionRoom.canPlaybackAudio
          ? noiseSuppression
            ? '好友高清语音已连接，系统降噪已开启'
            : '好友高清语音已连接'
          : '好友语音已连接，但系统阻止了播放。请点“恢复语音”。',
      )
    } catch {
      suppressDisconnectHandler = true
      const ownsDirectRoom = Boolean(
        liveKitRoom && (directLiveKitRef.current === liveKitRoom || pendingDirectLiveKitRef.current === liveKitRoom),
      )
      if (liveKitRoom) {
        if (pendingDirectLiveKitRef.current === liveKitRoom) {
          pendingDirectLiveKitRef.current = null
        }
        void Promise.resolve(liveKitRoom.disconnect()).catch(() => undefined)
      }
      if (ownsDirectRoom) {
        detachDirectRemoteAudio()
        setDirectAudioPlaybackBlocked(false)
      }
      if (!liveKitRoom || directLiveKitRef.current === liveKitRoom) {
        directLiveKitRef.current = null
      }
      if (!isCurrentDirectAttempt()) {
        return
      }
      if (options.reconnecting && directVoiceWantedRef.current && directVoiceTargetRef.current?.callId === event.callId) {
        setDirectVoiceStatus('connecting')
        setDirectVoiceNote('好友语音重连失败，继续重试')
        scheduleDirectVoiceReconnect()
        return
      }
      setDirectVoiceStatus('error')
      setDirectVoiceNote('好友语音连接失败，请检查 HTTPS、UDP 和 LiveKit 配置')
    }
  }, [
    applyDirectParticipantVolumes,
    attachDirectRemoteAudio,
    attachExistingDirectRemoteAudio,
    cleanupVoiceConnection,
    clearDirectVoiceReconnectTimer,
    detachDirectRemoteAudio,
    noiseSuppression,
    scheduleDirectVoiceReconnect,
    syncDirectCallState,
  ])

  useEffect(() => {
    connectDirectVoiceRef.current = connectDirectVoice
  }, [connectDirectVoice])

  const retryDirectVoice = useCallback(async () => {
    const target = directVoiceTargetRef.current
    const event = directCall?.status === 'accepted' ? directCall : target?.event
    if (!event) {
      setDirectVoiceStatus('error')
      setDirectVoiceNote('没有可恢复的好友通话，请重新呼叫')
      return
    }
    const currentRoomId = roomRef.current?.id ?? activeRoomId
    const roomVoiceActive =
      voiceWantedRef.current ||
      Boolean(liveKitRef.current) ||
      Boolean(pendingLiveKitRef.current) ||
      voiceStatusRef.current === 'connected' ||
      voiceStatusRef.current === 'demo'
    if (roomVoiceActive && currentRoomId) {
      const confirmed = window.confirm('接入好友语音会断开当前房间语音。挂断后可在房间语音页一键回到房间语音。继续？')
      if (!confirmed) {
        return
      }
      setRoomVoiceReturnRoomId(currentRoomId)
    }
    directVoiceWantedRef.current = true
    directVoiceApprovedCallIdsRef.current.add(event.callId)
    const staleDirectRoom = directLiveKitRef.current
    const stalePendingDirectRoom = pendingDirectLiveKitRef.current
    if (staleDirectRoom || stalePendingDirectRoom) {
      pendingDirectLiveKitRef.current = null
      directLiveKitRef.current = null
      detachDirectRemoteAudio()
      setDirectAudioPlaybackBlocked(false)
      void Promise.resolve(stalePendingDirectRoom?.disconnect()).catch(() => undefined)
      if (staleDirectRoom && staleDirectRoom !== stalePendingDirectRoom) {
        void Promise.resolve(staleDirectRoom.disconnect()).catch(() => undefined)
      }
    }
    await connectDirectVoiceRef.current?.(event)
  }, [activeRoomId, detachDirectRemoteAudio, directCall])

  const scheduleVoiceReconnect = useCallback((roomId: string) => {
    if (!voiceWantedRef.current || roomRef.current?.id !== roomId || !sessionTokenRef.current) {
      return
    }
    if (voiceReconnectTimerRef.current !== null) {
      return
    }
    if (voiceReconnectAttemptsRef.current >= 30) {
      voiceWantedRef.current = false
      socketRef.current?.emit('voice:leave', {
        roomId,
        token: sessionTokenRef.current,
      })
      setVoiceStatus('error')
      setVoiceNote('网络中断时间过长，语音已断开，请重新加入')
      return
    }

    const attempt = Math.min(voiceReconnectAttemptsRef.current + 1, 6)
    voiceReconnectAttemptsRef.current += 1
    const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000)
    voiceReconnectTimerRef.current = window.setTimeout(() => {
      voiceReconnectTimerRef.current = null
      if (!voiceWantedRef.current || roomRef.current?.id !== roomId) {
        return
      }
      void connectVoiceRef.current?.({ reconnecting: true })
    }, delay)
  }, [])

  const connectVoice = useCallback(async (options: { reconnecting?: boolean } = {}) => {
    const targetRoom = roomRef.current
    const currentAccount = accountRef.current
    const token = sessionTokenRef.current
    if (!targetRoom || !currentAccount || !token) {
      return
    }
    if (directVoiceWantedRef.current || directLiveKitRef.current || pendingDirectLiveKitRef.current) {
      setVoiceStatus('error')
      setVoiceNote('好友通话进行中，请先挂断后再加入房间语音')
      return
    }
    if (pendingLiveKitRef.current || (options.reconnecting && liveKitRef.current)) {
      setVoiceStatus('connecting')
      setVoiceNote(options.reconnecting ? 'LiveKit 正在保持连接' : '语音正在连接中')
      return
    }

    const generation = voiceConnectGenerationRef.current + 1
    voiceConnectGenerationRef.current = generation
    const isCurrentVoiceAttempt = () =>
      voiceConnectGenerationRef.current === generation &&
      voiceWantedRef.current &&
      roomRef.current?.id === targetRoom.id

    voiceWantedRef.current = true
    lastLocalSpeakingRef.current = false
    clearVoiceReconnectTimer()
    setVoiceStatus('connecting')
    setVoiceNote(options.reconnecting ? '语音网络波动，正在重新连接' : '正在请求语音令牌')

    let response: VoiceTokenResponse
    try {
      response = await requestVoiceToken(token, targetRoom.id, voiceSessionIdRef.current)
    } catch {
      if (!isCurrentVoiceAttempt()) {
        return
      }
      if (options.reconnecting && voiceWantedRef.current) {
        setVoiceNote('语音重连失败，继续重试')
        scheduleVoiceReconnect(targetRoom.id)
        return
      }
      setVoiceStatus('error')
      setVoiceNote('语音连接失败，请检查 HTTPS、UDP 和 LiveKit 配置')
      return
    }

    if (!isCurrentVoiceAttempt()) {
      return
    }
    const localVoiceIdentity = response.identity ?? currentAccount.id

    if (!response.configured || !response.url || !response.token) {
      const joinAck = await emitRoomVoiceJoin(socketRef.current, {
        roomId: targetRoom.id,
        token,
        muted: voiceMutedRef.current,
      })
      if (!isCurrentVoiceAttempt()) {
        return
      }
      if (!joinAck.ok) {
        voiceWantedRef.current = false
        setVoiceStatus('error')
        setVoiceNote(`加入语音频道失败：${describeError(joinAck.error, '服务器拒绝加入')}`)
        return
      }
      setRoom(joinAck.room)
      voiceReconnectAttemptsRef.current = 0
      setVoiceStatus('demo')
      setVoiceNote(response.reason ?? '语音服务未启用，当前仅显示频道成员，未传输音频。')
      return
    }

    let LiveKitRoomCtor: LiveKitClientRuntime['Room']
    let RoomEvent: LiveKitClientRuntime['RoomEvent']
    try {
      ;({ Room: LiveKitRoomCtor, RoomEvent } = await loadLiveKitClient())
    } catch {
      if (!isCurrentVoiceAttempt()) {
        return
      }
      if (options.reconnecting && voiceWantedRef.current) {
        setVoiceStatus('connecting')
        setVoiceNote('语音资源加载失败，继续重试')
        scheduleVoiceReconnect(targetRoom.id)
        return
      }
      voiceWantedRef.current = false
      setVoiceStatus('error')
      setVoiceNote('语音资源加载失败，请检查网络后重试。')
      return
    }
    let liveKitRoom: LiveKitRoom | null = null
    let suppressDisconnectHandler = false
    const markVoiceOffline = () => {
      socketRef.current?.emit('voice:update', {
        roomId: targetRoom.id,
        token,
        speaking: false,
        quality: 'offline',
      })
      lastLocalSpeakingRef.current = false
    }

    try {
      liveKitRoom = new LiveKitRoomCtor({
        adaptiveStream: true,
        dynacast: true,
      })
      const connectionRoom = liveKitRoom
      pendingLiveKitRef.current = connectionRoom

      connectionRoom.on(RoomEvent.Disconnected, () => {
        if (liveKitRef.current !== connectionRoom && pendingLiveKitRef.current !== connectionRoom) {
          return
        }
        detachRemoteAudio()
        if (liveKitRef.current === connectionRoom) {
          liveKitRef.current = null
        }
        if (pendingLiveKitRef.current === connectionRoom) {
          pendingLiveKitRef.current = null
        }
        if (suppressDisconnectHandler) {
          return
        }
        if (!isCurrentVoiceAttempt()) {
          socketRef.current?.emit('voice:leave', {
            roomId: targetRoom.id,
            token,
          })
          setVoiceStatus('idle')
          setVoiceNote('语音已断开')
          return
        }
        markVoiceOffline()
        setVoiceStatus('connecting')
        setVoiceNote('语音网络波动，正在自动重连')
        scheduleVoiceReconnect(targetRoom.id)
      })
      connectionRoom.on(RoomEvent.Reconnecting, () => {
        if (liveKitRef.current !== connectionRoom) {
          return
        }
        markVoiceOffline()
        setVoiceStatus('connecting')
        setVoiceNote('语音网络波动，正在保持连接')
      })
      connectionRoom.on(RoomEvent.Reconnected, () => {
        if (liveKitRef.current !== connectionRoom || !isCurrentVoiceAttempt()) {
          return
        }
        voiceReconnectAttemptsRef.current = 0
        attachExistingRemoteAudio(connectionRoom)
        applyParticipantVolumes(connectionRoom)
        setAudioPlaybackBlocked(!connectionRoom.canPlaybackAudio)
        setVoiceStatus('connected')
        setVoiceNote(
          connectionRoom.canPlaybackAudio
            ? noiseSuppression
              ? 'LiveKit 高清语音已恢复，系统降噪已开启'
              : 'LiveKit 高清语音已恢复'
            : '语音已恢复连接，但系统阻止了播放。请点“恢复语音”。',
        )
        socketRef.current?.emit('voice:join', {
          roomId: targetRoom.id,
          token,
          muted: voiceMutedRef.current,
          quality: mapLiveKitQuality(connectionRoom.localParticipant.connectionQuality),
        })
        lastLocalSpeakingRef.current = false
      })
      connectionRoom.on(RoomEvent.MediaDevicesError, () => {
        if (liveKitRef.current !== connectionRoom && pendingLiveKitRef.current !== connectionRoom) {
          return
        }
        setVoiceStatus('error')
        setVoiceNote('麦克风权限或设备异常')
      })
      connectionRoom.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
        if (liveKitRef.current !== connectionRoom) {
          return
        }
        setAudioPlaybackBlocked(!playing)
        if (!playing) {
          setVoiceNote('语音已连接，但系统阻止了播放。请点“恢复语音”启用听筒输出。')
        }
      })
      connectionRoom.on(RoomEvent.TrackSubscribed, (track) => {
        if (liveKitRef.current !== connectionRoom) {
          return
        }
        attachRemoteAudio(track)
        applyParticipantVolumes(connectionRoom)
      })
      connectionRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (liveKitRef.current !== connectionRoom) {
          return
        }
        detachRemoteAudio(track)
      })
      connectionRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        if (liveKitRef.current !== connectionRoom || !isCurrentVoiceAttempt()) {
          return
        }
        const speaking = speakers.some((speaker) => speaker.identity === localVoiceIdentity)
        if (lastLocalSpeakingRef.current === speaking && pendingLocalSpeakingRef.current === null) {
          return
        }
        pendingLocalSpeakingRef.current = speaking
        if (voiceSpeakingUpdateTimerRef.current !== null) {
          return
        }
        voiceSpeakingUpdateTimerRef.current = window.setTimeout(() => {
          voiceSpeakingUpdateTimerRef.current = null
          const nextSpeaking = pendingLocalSpeakingRef.current
          pendingLocalSpeakingRef.current = null
          if (nextSpeaking === null || lastLocalSpeakingRef.current === nextSpeaking) {
            return
          }
          lastLocalSpeakingRef.current = nextSpeaking
          socketRef.current?.emit('voice:update', {
            roomId: targetRoom.id,
            token,
            speaking: nextSpeaking,
          })
        }, 250)
      })
      connectionRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (liveKitRef.current !== connectionRoom || !isCurrentVoiceAttempt() || participant.identity !== localVoiceIdentity) {
          return
        }
        socketRef.current?.emit('voice:update', {
          roomId: targetRoom.id,
          token,
          quality: mapLiveKitQuality(quality),
        })
      })

      await connectionRoom.connect(response.url, response.token)
      if (!isCurrentVoiceAttempt()) {
        suppressDisconnectHandler = true
        pendingLiveKitRef.current = null
        void connectionRoom.disconnect()
        return
      }
      try {
        await connectionRoom.startAudio()
        if (!isCurrentVoiceAttempt()) {
          suppressDisconnectHandler = true
          pendingLiveKitRef.current = null
          void connectionRoom.disconnect()
          return
        }
        setAudioPlaybackBlocked(!connectionRoom.canPlaybackAudio)
      } catch {
        setAudioPlaybackBlocked(true)
      }
      const shouldMute = voiceMutedRef.current
      await connectionRoom.localParticipant.setMicrophoneEnabled(!shouldMute, {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression,
      })
      appliedNoiseSuppressionRef.current = noiseSuppression
      if (!isCurrentVoiceAttempt()) {
        suppressDisconnectHandler = true
        pendingLiveKitRef.current = null
        void connectionRoom.disconnect()
        return
      }
      pendingLiveKitRef.current = null
      liveKitRef.current = connectionRoom
      attachExistingRemoteAudio(connectionRoom)
      applyParticipantVolumes(connectionRoom)
      setVoiceMuted(shouldMute)
      voiceReconnectAttemptsRef.current = 0
      lastLocalSpeakingRef.current = false
      const joinAck = await emitRoomVoiceJoin(socketRef.current, {
        roomId: targetRoom.id,
        token,
        muted: shouldMute,
        quality: mapLiveKitQuality(connectionRoom.localParticipant.connectionQuality),
      })
      if (!isCurrentVoiceAttempt()) {
        suppressDisconnectHandler = true
        pendingLiveKitRef.current = null
        void connectionRoom.disconnect()
        return
      }
      if (!joinAck.ok) {
        throw new Error(`加入语音频道失败：${describeError(joinAck.error, '服务器拒绝加入')}`)
      }
      setRoom(joinAck.room)
      setVoiceStatus('connected')
      setVoiceNote(
        connectionRoom.canPlaybackAudio
          ? noiseSuppression
            ? 'LiveKit 高清语音已连接，系统降噪已开启'
            : 'LiveKit 高清语音已连接'
          : '语音已连接，但系统阻止了播放。请点“恢复语音”启用听筒输出。',
      )
    } catch (error) {
      suppressDisconnectHandler = true
      const ownsVoiceRoom = Boolean(
        liveKitRoom && (liveKitRef.current === liveKitRoom || pendingLiveKitRef.current === liveKitRoom),
      )
      if (liveKitRoom) {
        if (pendingLiveKitRef.current === liveKitRoom) {
          pendingLiveKitRef.current = null
        }
        void Promise.resolve(liveKitRoom.disconnect()).catch(() => undefined)
      }
      if (ownsVoiceRoom) {
        detachRemoteAudio()
        setAudioPlaybackBlocked(false)
      }
      if (!liveKitRoom || liveKitRef.current === liveKitRoom) {
        liveKitRef.current = null
      }
      if (!isCurrentVoiceAttempt()) {
        return
      }
      if (options.reconnecting && voiceWantedRef.current && roomRef.current?.id === targetRoom.id) {
        setVoiceStatus('connecting')
        setVoiceNote('语音重连失败，继续重试')
        scheduleVoiceReconnect(targetRoom.id)
        return
      }
      voiceWantedRef.current = false
      setVoiceStatus('error')
      setVoiceNote(describeError(error, '语音连接失败，请检查 HTTPS、UDP 和 LiveKit 配置'))
    }
  }, [
    applyParticipantVolumes,
    attachExistingRemoteAudio,
    attachRemoteAudio,
    clearVoiceReconnectTimer,
    detachRemoteAudio,
    noiseSuppression,
    scheduleVoiceReconnect,
  ])
  useEffect(() => {
    connectVoiceRef.current = connectVoice
  }, [connectVoice])

  useEffect(() => {
    const handleOffline = () => {
      if (voiceWantedRef.current) {
        clearVoiceReconnectTimer()
        setVoiceStatus('connecting')
        setVoiceNote('网络已断开，语音等待恢复')
      }
      if (directVoiceWantedRef.current) {
        clearDirectVoiceReconnectTimer()
        setDirectVoiceStatus('connecting')
        setDirectVoiceNote('网络已断开，好友语音等待恢复')
      }
    }
    const handleOnline = () => {
      const targetRoomId = roomRef.current?.id
      if (voiceWantedRef.current && targetRoomId) {
        voiceReconnectAttemptsRef.current = 0
        clearVoiceReconnectTimer()
        setVoiceNote('网络已恢复，正在重连语音')
        void connectVoiceRef.current?.({ reconnecting: true })
      }
      const directTarget = directVoiceTargetRef.current
      if (directVoiceWantedRef.current && directTarget) {
        directVoiceReconnectAttemptsRef.current = 0
        clearDirectVoiceReconnectTimer()
        setDirectVoiceNote('网络已恢复，正在重连好友语音')
        void connectDirectVoiceRef.current?.(directTarget.event, { reconnecting: true })
      }
    }
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [clearDirectVoiceReconnectTimer, clearVoiceReconnectTimer])

  const startAudioPlayback = async () => {
    const liveKitRoom = liveKitRef.current
    if (!liveKitRoom) {
      return
    }

    try {
      await liveKitRoom.startAudio()
      attachExistingRemoteAudio(liveKitRoom)
      applyParticipantVolumes(liveKitRoom)
      setAudioPlaybackBlocked(!liveKitRoom.canPlaybackAudio)
      setVoiceNote(liveKitRoom.canPlaybackAudio ? '语音播放已恢复' : '系统仍阻止播放，请再次点按恢复语音。')
    } catch {
      setAudioPlaybackBlocked(true)
      setVoiceNote('系统仍阻止播放，请再次点按恢复语音。')
    }
  }

  const startDirectAudioPlayback = async () => {
    const liveKitRoom = directLiveKitRef.current
    if (!liveKitRoom) {
      return
    }

    try {
      await liveKitRoom.startAudio()
      attachExistingDirectRemoteAudio(liveKitRoom)
      applyDirectParticipantVolumes(liveKitRoom)
      setDirectAudioPlaybackBlocked(!liveKitRoom.canPlaybackAudio)
      setDirectVoiceNote(liveKitRoom.canPlaybackAudio ? '好友语音播放已恢复' : '系统仍阻止播放，请再次点按恢复语音。')
    } catch {
      setDirectAudioPlaybackBlocked(true)
      setDirectVoiceNote('系统仍阻止播放，请再次点按恢复语音。')
    }
  }

  const toggleDirectVoiceMute = async () => {
    if (!directLiveKitRef.current) {
      if (directVoiceStatus === 'demo') {
        const nextMuted = !directVoiceMuted
        setDirectVoiceMuted(nextMuted)
        setDirectVoiceNote(nextMuted ? '麦克风已静音，仍在好友通话' : '麦克风已开启')
      }
      return
    }

    const nextMuted = !directVoiceMuted
    try {
      await directLiveKitRef.current.localParticipant.setMicrophoneEnabled(!nextMuted, {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression,
      })
      setDirectVoiceMuted(nextMuted)
      setDirectVoiceNote(nextMuted ? '麦克风已静音，仍在好友通话' : '麦克风已开启')
    } catch {
      setDirectVoiceStatus('error')
      setDirectVoiceNote('麦克风切换失败，请检查权限')
    }
  }

  const toggleVoiceMute = async () => {
    if (!liveKitRef.current) {
      if (voiceStatus === 'demo' && room) {
        const nextMuted = !voiceMuted
        setVoiceMuted(nextMuted)
        socketRef.current?.emit('voice:update', {
          roomId: room.id,
          token: sessionToken,
          muted: nextMuted,
          speaking: false,
        })
        lastLocalSpeakingRef.current = false
        setVoiceNote(nextMuted ? '麦克风已静音，仍在语音房间' : '麦克风已开启')
      }
      return
    }

    const nextMuted = !voiceMuted
    try {
      await liveKitRef.current.localParticipant.setMicrophoneEnabled(!nextMuted, {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression,
      })
      appliedNoiseSuppressionRef.current = noiseSuppression
      setVoiceMuted(nextMuted)
      setVoiceNote(nextMuted ? '麦克风已静音，仍在语音房间' : '麦克风已开启')
      if (room) {
        socketRef.current?.emit('voice:update', {
          roomId: room.id,
          token: sessionToken,
          muted: nextMuted,
          speaking: false,
        })
        lastLocalSpeakingRef.current = false
      }
    } catch {
      setVoiceStatus('error')
      setVoiceNote('麦克风切换失败，请检查权限')
    }
  }

  useEffect(() => {
    const liveKitRoom = liveKitRef.current
    if (!liveKitRoom || voiceStatus !== 'connected') {
      return
    }
    if (appliedNoiseSuppressionRef.current === noiseSuppression) {
      return
    }

    let disposed = false
    const muted = voiceMutedRef.current
    const requestedNoiseSuppression = noiseSuppression
    void liveKitRoom.localParticipant
      .setMicrophoneEnabled(!muted, {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: requestedNoiseSuppression,
      })
      .then(() => {
        if (disposed) {
          return
        }
        appliedNoiseSuppressionRef.current = requestedNoiseSuppression
        setVoiceNote(
          muted
            ? requestedNoiseSuppression
              ? '降噪已开启，麦克风保持静音'
              : '降噪已关闭，麦克风保持静音'
            : requestedNoiseSuppression
              ? '系统降噪已开启'
              : '系统降噪已关闭',
        )
      })
      .catch(() => {
        if (!disposed) {
          setVoiceNote('降噪设置更新失败，语音仍保持连接')
        }
      })

    return () => {
      disposed = true
    }
  }, [noiseSuppression, voiceStatus])

  useEffect(() => {
    const liveKitRoom = directLiveKitRef.current
    if (!liveKitRoom || directVoiceStatus !== 'connected') {
      return
    }

    let disposed = false
    const muted = directVoiceMutedRef.current
    const requestedNoiseSuppression = noiseSuppression
    void liveKitRoom.localParticipant
      .setMicrophoneEnabled(!muted, {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: requestedNoiseSuppression,
      })
      .then(() => {
        if (disposed) {
          return
        }
        setDirectVoiceNote(
          muted
            ? requestedNoiseSuppression
              ? '降噪已开启，麦克风保持静音'
              : '降噪已关闭，麦克风保持静音'
            : requestedNoiseSuppression
              ? '系统降噪已开启'
              : '系统降噪已关闭',
        )
      })
      .catch(() => {
        if (!disposed) {
          setDirectVoiceNote('降噪设置更新失败，好友语音仍保持连接')
        }
      })

    return () => {
      disposed = true
    }
  }, [directVoiceStatus, noiseSuppression])

  const handleVoicePrimary = async () => {
    if (voiceStatus === 'connected' || voiceStatus === 'demo') {
      await toggleVoiceMute()
      return
    }

    setRoomVoiceReturnRoomId('')
    await connectVoice()
  }

  function disconnectVoice() {
    const roomId = room?.id
    setRoomVoiceReturnRoomId('')
    cleanupVoiceConnection({ emitLeave: Boolean(roomId && sessionToken), roomId, token: sessionToken })
  }

  const returnToRoomVoice = async () => {
    setRoomVoiceReturnRoomId('')
    await connectVoice()
  }

  const updateRoomChatDraft = (value: string) => {
    const pendingRetry = pendingRoomMessageRetryRef.current
    if (!pendingRetry || pendingRetry.text !== value || pendingRetry.roomId !== room?.id) {
      pendingRoomMessageRetryRef.current = null
    }
    setChatDraft(value)
  }

  useEffect(() => {
    if (!booting) {
      setBootingSlow(false)
      return
    }
    const timer = window.setTimeout(() => setBootingSlow(true), 5000)
    return () => window.clearTimeout(timer)
  }, [booting])

  if (booting) {
    return (
      <LoadingPanel
        actionLabel={bootingSlow ? '刷新重试' : undefined}
        message={bootingSlow ? '账号信息加载时间过长，请检查网络或刷新重试。' : '正在连接账号与房间数据。'}
        onAction={bootingSlow ? () => window.location.reload() : undefined}
        title="正在载入账号"
      />
    )
  }

  if (!account) {
    return <AuthPage onSuccess={handleAuthSuccess} />
  }

  const globalDirectCallBanner =
    page !== 'chat' ? (
      <DirectCallBanner
        account={account}
        actionError={directCallActionError}
        busy={directCallBusy}
        className="global-call-banner"
        directAudioPlaybackBlocked={directAudioPlaybackBlocked}
        directCall={directCall}
        directCallNotice={directCallNotice}
        directVoiceMuted={directVoiceMuted}
        directVoiceNote={directVoiceNote}
        directVoiceStatus={directVoiceStatus}
        onAction={handleDirectCallAction}
        onRecoverDirectVoice={startDirectAudioPlayback}
        onRetryDirectVoice={retryDirectVoice}
        onToggleDirectVoiceMute={toggleDirectVoiceMute}
      />
    ) : null
  const directVoiceActive =
    directCall?.status === 'accepted' ||
    directVoiceStatus === 'connecting' ||
    directVoiceStatus === 'connected' ||
    directVoiceStatus === 'demo'
  const roomVoiceReturnAvailable = Boolean(
    room &&
      roomVoiceReturnRoomId === room.id &&
      !directVoiceActive &&
      voiceStatus !== 'connected' &&
      voiceStatus !== 'demo',
  )
  const roomMessageCooldownSeconds = remainingCooldownSeconds(roomMessageCooldownUntil)
  const roomDiceCooldownSeconds = remainingCooldownSeconds(roomDiceCooldownUntil)

  if (page === 'room') {
    return (
      <>
        {globalDirectCallBanner}
        <ViewErrorBoundary onBack={suspendCurrentRoom} resetKey={`room:${room?.id ?? activeRoomId}:${roomTab}`}>
          <RoomPage
            account={account}
            audioPlaybackBlocked={audioPlaybackBlocked}
            boardStyle={boardStyle}
            chatDraft={chatDraft}
            confirmedRoomMessage={confirmedRoomMessage}
            currentRoomRole={currentRoomRole}
            diceFormula={diceFormula}
            friends={friends}
            handleBoardClick={handleBoardClick}
            handleSignOut={handleSignOut}
            handleVitalsChange={handleVitalsChange}
            handleVoicePrimary={handleVoicePrimary}
            lastRoll={lastRoll}
            noiseSuppression={noiseSuppression}
            onBack={suspendCurrentRoom}
            onDisconnectVoice={disconnectVoice}
            onReturnRoomVoice={returnToRoomVoice}
            onStartAudioPlayback={startAudioPlayback}
            onRollDice={rollDice}
            onSendMessage={(options) => submitMessage(chatDraft, options)}
            onSetChatDraft={updateRoomChatDraft}
            onSetDiceFormula={setDiceFormula}
            onSetNoiseSuppression={setNoiseSuppression}
            onSetRoomTab={setRoomTab}
            onSetSelectedTokenId={setSelectedTokenId}
            onSetVoiceVolume={(id, volume) =>
              setVoiceVolumes((current) => ({ ...current, [id]: volume }))
            }
            onInviteFriend={async (friendId) => {
              if (!room) {
                return
              }
              const nextRoom = await inviteRoomFriend(room.id, sessionToken, friendId)
              setRoom(nextRoom)
              await refreshHomeData()
            }}
            onCloseRoom={async () => {
              if (!room) {
                return
              }
              if (!window.confirm('关闭后房间会进入历史房间，当前语音会断开，参与过的用户仍可从已关闭列表重新进入。确认关闭？')) {
                return
              }
              await closeRoom(room.id, sessionToken)
              disconnectVoice()
              localStorage.removeItem(activeRoomStorageKey)
              setRoom(null)
              setActiveRoomId('')
              setRoomMinimized(false)
              setRoomMessageToasts([])
              setPage('lobby')
              await refreshHomeData()
            }}
            roomMessageToasts={roomMessageToasts}
            room={room}
            roomChatStatus={roomChatStatus}
            roomDiceCooldownSeconds={roomDiceCooldownSeconds}
            roomMessageCooldownSeconds={roomMessageCooldownSeconds}
            roomTab={roomTab}
            roomVoiceReturnAvailable={roomVoiceReturnAvailable}
            sessionToken={sessionToken}
            onRoomUpdated={(nextRoom) => setRoom(nextRoom)}
            selectedCharacter={selectedCharacter}
            selectedToken={selectedToken}
            selectedTokenId={selectedTokenId}
            updateToken={updateToken}
            voiceMuted={voiceMuted}
            voiceNote={voiceNote}
            voiceStatus={voiceStatus}
            voiceVolumes={voiceVolumes}
          />
        </ViewErrorBoundary>
      </>
    )
  }

  return (
    <main className="home-shell">
      {globalDirectCallBanner}
      <aside className="home-nav" aria-label="主导航">
        <Brand />
        <button className={page === 'lobby' ? 'active' : ''} type="button" onClick={() => setPage('lobby')}>
          <Home size={19} aria-hidden="true" />
          大厅
        </button>
        <button className={page === 'chat' ? 'active' : ''} type="button" onClick={() => setPage('chat')}>
          <MessageCircle size={19} aria-hidden="true" />
          <span>聊天</span>
          {unreadDirectCount > 0 && <span className="nav-badge">{formatBadgeCount(unreadDirectCount)}</span>}
        </button>
        <button className={page === 'scripts' ? 'active' : ''} type="button" onClick={() => setPage('scripts')}>
          <BookOpen size={19} aria-hidden="true" />
          剧本
        </button>
        <button className={page === 'account' ? 'active' : ''} type="button" onClick={() => setPage('account')}>
          <User size={19} aria-hidden="true" />
          <span>账户</span>
          {incomingFriendRequestCount > 0 && <span className="nav-badge">{formatBadgeCount(incomingFriendRequestCount)}</span>}
        </button>
      </aside>

      <section className={`home-main home-page-${page}`}>
        {page === 'lobby' && (
          <LobbyPage
            account={account}
            activeRoomName={roomMinimized ? room?.name : undefined}
            activeRoomPhase={roomMinimized ? room?.phase : undefined}
            lockedByActiveRoom={roomMinimized && Boolean(activeRoomId)}
            onReturnActiveRoom={() => {
              if (!activeRoomId) {
                return
              }
              setRoomMinimized(false)
              setPage('room')
            }}
            onLeaveActiveRoom={async () => {
              const left = await leaveCurrentRoom()
              if (!left) {
                throw new Error('正式退出失败')
              }
              localStorage.removeItem(activeRoomStorageKey)
              setRoom(null)
              setActiveRoomId('')
              setRoomMinimized(false)
              setRoomMessageToasts([])
              disconnectVoice()
              await refreshHomeData()
            }}
            onCreateRoom={async (input) => {
              if (roomMinimized && activeRoomId) {
                return
              }
              const nextRoom = await createRoom(sessionToken, input)
              await refreshHomeData()
              setRoom(nextRoom)
              setActiveRoomId(nextRoom.id)
              setRoomMinimized(false)
              setRoomTab(defaultRoomTabFor(nextRoom))
              setPage('room')
            }}
            onDeleteRoom={async (roomId) => {
              await deleteRoom(roomId, sessionToken)
              if (roomId === activeRoomId) {
                disconnectVoice()
                localStorage.removeItem(activeRoomStorageKey)
                setRoom(null)
                setActiveRoomId('')
                setRoomMinimized(false)
                setRoomMessageToasts([])
                setPage('lobby')
              }
              await refreshHomeData()
            }}
            onEnterRoom={enterRoom}
            rooms={rooms}
            closedRooms={closedRooms}
            scripts={scripts}
          />
        )}
        {page === 'chat' && (
          <ViewErrorBoundary onBack={() => setPage('lobby')} resetKey={`chat:${friends.length}:${directMessageEvents.length}`}>
            <ChatPage
              account={account}
              directAudioPlaybackBlocked={directAudioPlaybackBlocked}
              directCallActionError={directCallActionError}
              directCallBusy={directCallBusy}
              directCall={directCall}
              directCallNotice={directCallNotice}
              directMessageEvents={directMessageEvents}
              directVoiceMuted={directVoiceMuted}
              directVoiceNote={directVoiceNote}
              directVoiceStatus={directVoiceStatus}
              friends={friends}
              onMarkRead={async (friendId, lastReadMessageId) => {
                const nextFriend = await markDirectMessagesRead(sessionToken, friendId, lastReadMessageId)
                setFriends((current) => current.map((friend) => (friend.id === nextFriend.id ? nextFriend : friend)))
              }}
              onDirectCallAction={handleDirectCallAction}
              onRecoverDirectVoice={startDirectAudioPlayback}
              onRetryDirectVoice={retryDirectVoice}
              onToggleDirectVoiceMute={toggleDirectVoiceMute}
              token={sessionToken}
            />
          </ViewErrorBoundary>
        )}
        {page === 'account' && (
          <ViewErrorBoundary onBack={() => setPage('lobby')} resetKey={`account:${account.id}:${friends.length}`}>
            <AccountPage
              account={account}
              friends={friends}
              onAccept={async (friendId) => {
                await acceptFriend(sessionToken, friendId)
                setFriends(await loadFriends(sessionToken))
              }}
              onRemove={async (friendId) => {
                await removeFriend(sessionToken, friendId)
                setFriends(await loadFriends(sessionToken))
              }}
              onRequest={async (email) => {
                await requestFriend(sessionToken, email)
                setFriends(await loadFriends(sessionToken))
              }}
              onSignOut={handleSignOut}
              onUpdate={async (input) => {
                const nextAccount = await updateProfile(sessionToken, input)
                setAccount(nextAccount)
                await refreshHomeData()
              }}
            />
          </ViewErrorBoundary>
        )}
        {page === 'scripts' && (
          <ViewErrorBoundary onBack={() => setPage('lobby')} resetKey={`scripts:${scripts.length}`}>
            <ScriptsPage
              account={account}
              scripts={scripts}
              token={sessionToken}
              onRefresh={async () => {
                setScripts(await loadScripts(sessionToken))
              }}
            />
          </ViewErrorBoundary>
        )}
      </section>

      <nav className="bottom-nav" aria-label="移动端主导航">
        <button className={page === 'lobby' ? 'active' : ''} type="button" onClick={() => setPage('lobby')}>
          <Home size={19} aria-hidden="true" />
          大厅
        </button>
        <button className={page === 'chat' ? 'active' : ''} type="button" onClick={() => setPage('chat')}>
          <MessageCircle size={19} aria-hidden="true" />
          <span>聊天</span>
          {unreadDirectCount > 0 && <span className="nav-badge">{formatBadgeCount(unreadDirectCount)}</span>}
        </button>
        <button className={page === 'scripts' ? 'active' : ''} type="button" onClick={() => setPage('scripts')}>
          <BookOpen size={19} aria-hidden="true" />
          剧本
        </button>
        <button className={page === 'account' ? 'active' : ''} type="button" onClick={() => setPage('account')}>
          <User size={19} aria-hidden="true" />
          <span>账户</span>
          {incomingFriendRequestCount > 0 && <span className="nav-badge">{formatBadgeCount(incomingFriendRequestCount)}</span>}
        </button>
      </nav>
      {roomMinimized && room && (
        <FloatingRoomDock
          messages={roomMessageToasts}
          onReturn={() => {
            setRoomMinimized(false)
            setPage('room')
          }}
          position={floatingRoomPosition}
          roomName={room.name}
          setPosition={setFloatingRoomPosition}
        />
      )}
    </main>
  )
}

function Brand() {
  return (
    <div className="brand">
      <Dice5 aria-hidden="true" />
      <div>
        <strong>夜航跑团桌</strong>
        <span>Android / Windows 同步</span>
      </div>
    </div>
  )
}

function FloatingRoomDock({
  messages,
  onReturn,
  position,
  roomName,
  setPosition,
}: {
  messages: RoomMessageToast[]
  onReturn: () => void
  position: FloatingRoomPosition
  roomName: string
  setPosition: (value: FloatingRoomPosition | ((current: FloatingRoomPosition) => FloatingRoomPosition)) => void
}) {
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number; moved: boolean } | null>(null)
  const movedBeforeClickRef = useRef(false)
  const popupSide = typeof window !== 'undefined' && position.x > window.innerWidth / 2 ? 'left' : 'right'
  const popupVertical = typeof window !== 'undefined' && position.y > window.innerHeight / 2 ? 'up' : 'down'

  const clampDock = useCallback((x: number, y: number) => {
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const right = left + (viewport?.width ?? window.innerWidth)
    let bottom = top + (viewport?.height ?? window.innerHeight)
    const blockedSelectors = ['.bottom-nav', '.room-tabs']
    blockedSelectors.forEach((selector) => {
      const element = document.querySelector(selector)
      if (!element) {
        return
      }
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) {
        bottom = Math.min(bottom, rect.top)
      }
    })
    return {
      x: Math.min(Math.max(left + 8, x), Math.max(left + 8, right - 64)),
      y: Math.min(Math.max(top + 8, y), Math.max(top + 8, bottom - 64)),
    }
  }, [])

  useEffect(() => {
    const reclamp = () => {
      setPosition((current) => clampDock(current.x, current.y))
    }
    reclamp()
    window.addEventListener('resize', reclamp)
    window.addEventListener('orientationchange', reclamp)
    window.visualViewport?.addEventListener('resize', reclamp)
    window.visualViewport?.addEventListener('scroll', reclamp)
    return () => {
      window.removeEventListener('resize', reclamp)
      window.removeEventListener('orientationchange', reclamp)
      window.visualViewport?.removeEventListener('resize', reclamp)
      window.visualViewport?.removeEventListener('scroll', reclamp)
    }
  }, [clampDock, setPosition])

  return (
    <div
      className="floating-room-dock"
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      title={`返回 ${roomName}`}
      onClick={() => {
        if (movedBeforeClickRef.current) {
          movedBeforeClickRef.current = false
          return
        }
        onReturn()
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        movedBeforeClickRef.current = false
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          originX: position.x,
          originY: position.y,
          moved: false,
        }
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag) {
          return
        }
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        if (Math.abs(dx) + Math.abs(dy) > 5) {
          drag.moved = true
        }
        setPosition(clampDock(drag.originX + dx, drag.originY + dy))
      }}
      onPointerUp={() => {
        movedBeforeClickRef.current = Boolean(dragRef.current?.moved)
        dragRef.current = null
      }}
      onPointerCancel={() => {
        movedBeforeClickRef.current = Boolean(dragRef.current?.moved)
        dragRef.current = null
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onReturn()
        }
      }}
    >
      <Home size={24} aria-hidden="true" />
      <div className={`floating-room-popups ${popupSide} ${popupVertical}`}>
        {messages.map((message) => (
          <article key={message.toastId}>
            <strong>{message.author}</strong>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
    </div>
  )
}

function AuthPage({ onSuccess }: { onSuccess: (session: { token: string; account: Account }) => void }) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [codeBusy, setCodeBusy] = useState(false)
  const [codeCooldown, setCodeCooldown] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [showServerSettings, setShowServerSettings] = useState(false)
  const [serverDraft, setServerDraft] = useState(() => getApiBase())

  useEffect(() => {
    if (codeCooldown <= 0) {
      return undefined
    }
    const timer = window.setInterval(() => {
      setCodeCooldown((value) => Math.max(0, value - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [codeCooldown])

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode)
    setError('')
    setNotice('')
  }

  const saveServer = () => {
    try {
      const nextServer = setApiBase(serverDraft)
      setServerDraft(nextServer)
      setError('')
      setNotice('服务器已保存。')
    } catch {
      setNotice('')
      setError('服务器地址无效，请输入 http 或 https 地址。')
    }
  }

  const useDefaultServer = () => {
    const nextServer = resetApiBase()
    setServerDraft(nextServer)
    setError('')
    setNotice('已恢复默认服务器。')
  }

  const sendCode = async () => {
    setCodeBusy(true)
    setError('')
    setNotice('')
    try {
      const result =
        mode === 'reset'
          ? await requestPasswordResetCode(email.trim())
          : await requestRegistrationCode(email.trim())
      setCodeCooldown(result.cooldownSeconds || 60)
      if (result.debugCode) {
        setVerificationCode(result.debugCode)
        setNotice(`测试验证码：${result.debugCode}`)
      } else {
        setNotice('验证码已发送，请查收邮箱。')
      }
    } catch (error) {
      setError(verificationSendErrorMessage(error))
    } finally {
      setCodeBusy(false)
    }
  }

  const submit = async () => {
    if ((mode === 'register' || mode === 'reset') && !verificationCode.trim()) {
      setError('请先输入邮箱验证码。')
      return
    }

    setBusy(true)
    setError('')
    try {
      if (mode === 'reset') {
        await resetPassword({ email, password, verificationCode })
        setMode('login')
        setPassword('')
        setVerificationCode('')
        setNotice('密码已重置，请使用新密码登录。')
        return
      }

      const session =
        mode === 'register'
          ? await registerAccount({
              email,
              displayName: displayName || email.split('@')[0],
              password,
              verificationCode,
            })
          : await loginAccount({ email, password })
      onSuccess(session)
    } catch (error) {
      setError(authErrorMessage(error, mode))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <Brand />
        <button
          className="server-settings-toggle"
          type="button"
          title="服务器设置"
          onClick={() => setShowServerSettings((value) => !value)}
        >
          <Settings size={17} aria-hidden="true" />
          <span>服务器</span>
        </button>
        {showServerSettings && (
          <div className="server-settings-panel">
            <label className="field">
              <span>服务器地址</span>
              <input
                inputMode="url"
                placeholder={defaultApiBase || 'https://your-server.example.com'}
                value={serverDraft}
                onChange={(event) => setServerDraft(event.target.value)}
              />
            </label>
            <div className="server-settings-actions">
              <button type="button" onClick={saveServer}>
                <Check size={15} aria-hidden="true" />
                保存
              </button>
              <button type="button" onClick={useDefaultServer}>
                默认
              </button>
            </div>
          </div>
        )}
        <div className="segmented">
          <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => switchMode('login')}>
            登录
          </button>
          <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => switchMode('register')}>
            注册
          </button>
          <button className={mode === 'reset' ? 'active' : ''} type="button" onClick={() => switchMode('reset')}>
            重置密码
          </button>
        </div>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className="field">
            <span>邮箱</span>
            <input
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {mode === 'register' && (
            <>
              <label className="field">
                <span>用户名</span>
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
              </label>
            </>
          )}
          {(mode === 'register' || mode === 'reset') && (
            <>
              <label className="field">
                <span>邮箱验证码</span>
                <div className="verification-row">
                  <input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6 位数字"
                    value={verificationCode}
                    onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                  <button
                    type="button"
                    onClick={() => void sendCode()}
                    disabled={codeBusy || codeCooldown > 0 || !email.includes('@')}
                  >
                    {codeBusy ? '发送中' : codeCooldown > 0 ? `${codeCooldown}s` : '获取'}
                  </button>
                </div>
              </label>
            </>
          )}
          <label className="field">
            <span>{mode === 'reset' ? '新密码' : '密码'}</span>
            <div className="password-row">
              <input
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button type="button" title={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
          </label>
          {mode === 'login' && (
            <button className="link-button" type="button" onClick={() => switchMode('reset')}>
              忘记密码？使用邮箱验证码重置
            </button>
          )}
          {mode === 'reset' && (
            <button className="link-button" type="button" onClick={() => switchMode('login')}>
              返回登录
            </button>
          )}
          {notice && <p className="form-note">{notice}</p>}
          {error && <p className="form-error">{error}</p>}
          <button className="primary-action" disabled={busy} type="submit">
            {mode === 'login' ? <LogIn size={17} aria-hidden="true" /> : <CirclePlus size={17} aria-hidden="true" />}
            {busy ? '处理中' : mode === 'login' ? '进入大厅' : mode === 'reset' ? '重置密码' : '创建账号'}
          </button>
        </form>
      </section>
    </main>
  )
}

function DirectCallBanner({
  account,
  actionError,
  busy,
  className = '',
  directAudioPlaybackBlocked,
  directCall,
  directCallNotice,
  directVoiceMuted,
  directVoiceNote,
  directVoiceStatus,
  onAction,
  onRecoverDirectVoice,
  onRetryDirectVoice,
  onToggleDirectVoiceMute,
}: {
  account: Account
  actionError: string
  busy: boolean
  className?: string
  directAudioPlaybackBlocked: boolean
  directCall: DirectCallEvent | null
  directCallNotice: string
  directVoiceMuted: boolean
  directVoiceNote: string
  directVoiceStatus: VoiceStatus
  onAction: DirectCallActionHandler
  onRecoverDirectVoice: () => Promise<void>
  onRetryDirectVoice: () => Promise<void>
  onToggleDirectVoiceMute: () => Promise<void>
}) {
  if (!directCall && !directCallNotice && !actionError) {
    return null
  }

  const peer = directCall ? directCallPeer(directCall, account.id) : { id: '', name: '' }
  const incoming = Boolean(directCall && directCall.status === 'ringing' && directCall.toId === account.id)
  const outgoing = Boolean(directCall && directCall.status === 'ringing' && directCall.fromId === account.id)
  const active = directCall?.status === 'accepted'
  const voiceActive = active || directVoiceStatus === 'connecting' || directVoiceStatus === 'connected' || directVoiceStatus === 'demo'
  const statusClass = directCall?.status ?? (actionError ? 'error' : 'notice')
  const title = actionError
    ? '通话操作失败'
    : directCallNotice || `与 ${peer.name} 的通话`
  const note = actionError || (voiceActive ? directVoiceNote : '')
  const rootClassName = ['direct-call-banner', className, statusClass].filter(Boolean).join(' ')
  const submitAction = (eventName: DirectCallActionName, friendId: string, callId?: string) => {
    void onAction(eventName, friendId, callId).catch(() => undefined)
  }

  return (
    <div className={rootClassName} role="status">
      <span className="direct-call-copy">
        <PhoneCall size={17} aria-hidden="true" />
        <span>
          <strong>{title}</strong>
          {note && <small>{note}</small>}
        </span>
      </span>
      <div>
        {incoming && (
          <>
            <button
              disabled={busy || !peer.id}
              type="button"
              onClick={() => submitAction('direct-call:reject', peer.id, directCall?.callId)}
            >
              <PhoneOff size={16} aria-hidden="true" />
              拒绝
            </button>
            <button
              className="primary-action"
              disabled={busy || !peer.id}
              type="button"
              onClick={() => submitAction('direct-call:accept', peer.id, directCall?.callId)}
            >
              <PhoneCall size={16} aria-hidden="true" />
              接听
            </button>
          </>
        )}
        {voiceActive && (
          <>
            {(directVoiceStatus === 'connected' || directVoiceStatus === 'demo') && (
              <button
                disabled={busy}
                type="button"
                onClick={() => void onToggleDirectVoiceMute()}
              >
                {directVoiceMuted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
                {directVoiceMuted ? '开麦' : '静音'}
              </button>
            )}
            {directAudioPlaybackBlocked && (
              <button disabled={busy} type="button" onClick={() => void onRecoverDirectVoice()}>
                <Volume2 size={16} aria-hidden="true" />
                恢复语音
              </button>
            )}
            {active && directVoiceStatus === 'error' && (
              <button disabled={busy} type="button" onClick={() => void onRetryDirectVoice()}>
                <Radio size={16} aria-hidden="true" />
                重试连接
              </button>
            )}
          </>
        )}
        {(outgoing || voiceActive) && (
          <button
            disabled={busy || !peer.id}
            type="button"
            onClick={() => submitAction('direct-call:end', peer.id, directCall?.callId)}
          >
            <PhoneOff size={16} aria-hidden="true" />
            {voiceActive ? '挂断' : '取消'}
          </button>
        )}
      </div>
    </div>
  )
}

function LobbyPage({
  account,
  activeRoomName,
  activeRoomPhase,
  lockedByActiveRoom,
  rooms,
  closedRooms,
  scripts,
  onCreateRoom,
  onDeleteRoom,
  onEnterRoom,
  onLeaveActiveRoom,
  onReturnActiveRoom,
}: {
  account: Account
  activeRoomName?: string
  activeRoomPhase?: RoomPhase
  lockedByActiveRoom?: boolean
  rooms: RoomSummary[]
  closedRooms: RoomSummary[]
  scripts: TrpgScriptSummary[]
  onCreateRoom: (input: {
    name: string
    system?: string
    visibility: RoomVisibility
    scriptId?: string
  }) => Promise<void>
  onDeleteRoom: (roomId: string) => Promise<void>
  onEnterRoom: (room: RoomSummary, role: UserRole) => Promise<void>
  onLeaveActiveRoom: () => Promise<void>
  onReturnActiveRoom: () => void
}) {
  const [name, setName] = useState('')
  const [system, setSystem] = useState('COC 7th')
  const [visibility, setVisibility] = useState<RoomVisibility>('public')
  const [scriptId, setScriptId] = useState('')
  const [busy, setBusy] = useState(false)
  const [joinBusy, setJoinBusy] = useState(false)
  const [leaveBusy, setLeaveBusy] = useState(false)
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false)
  const [deletingRoomId, setDeletingRoomId] = useState('')
  const [pendingRoom, setPendingRoom] = useState<RoomSummary | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [roomListView, setRoomListView] = useState<'online' | 'closed'>('online')
  const [error, setError] = useState('')
  const visibleRooms = roomListView === 'online' ? rooms : closedRooms
  const effectiveJoinRole: UserRole = pendingRoom?.ownerId === account.id ? 'keeper' : 'player'

  useEffect(() => {
    if (!lockedByActiveRoom) {
      setLeaveBusy(false)
      setLeaveConfirmOpen(false)
    }
  }, [lockedByActiveRoom])

  useNativeBackHandler(() => {
    if (leaveConfirmOpen) {
      setLeaveConfirmOpen(false)
      return true
    }
    if (pendingRoom) {
      setPendingRoom(null)
      return true
    }
    if (createOpen) {
      setCreateOpen(false)
      return true
    }
    return false
  }, 50)

  const submitCreateRoom = async () => {
    if (lockedByActiveRoom) {
      setError('已有挂起房间，不能创建新房间。')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onCreateRoom({
        name: name.trim() || `新团 ${rooms.length + closedRooms.length + 1}`,
        system,
        visibility,
        scriptId: scriptId || undefined,
      })
      setName('')
      setCreateOpen(false)
    } catch {
      setError('创建房间失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p>欢迎，{account.displayName}</p>
          <h1>房间大厅</h1>
        </div>
        <div className="page-header-actions">
          <button
            className="icon-button create-room-icon"
            disabled={lockedByActiveRoom}
            title="创建房间"
            type="button"
            onClick={() => {
              if (lockedByActiveRoom) {
                setError('已有挂起房间，不能创建新房间。')
                return
              }
              setCreateOpen(true)
              setError('')
            }}
          >
            <CirclePlus size={20} aria-hidden="true" />
          </button>
          <span className="identity-pill">{account.email}</span>
        </div>
      </header>
      {lockedByActiveRoom && (
        <div className="active-room-lock-group">
          <div className="active-room-lock">
            <Home size={17} aria-hidden="true" />
            <span>已挂起房间「{activeRoomName ?? '当前房间'}」，返回或正式退出后才能创建、加入其他房间。</span>
            <button
              className="active-room-return"
              type="button"
              onClick={() => {
                setLeaveConfirmOpen(false)
                onReturnActiveRoom()
              }}
            >
              返回房间
            </button>
            <button type="button" onClick={() => setLeaveConfirmOpen(true)}>
              正式退出
            </button>
          </div>
          {leaveConfirmOpen && (
            <div className="active-room-confirm" role="alertdialog" aria-label="确认正式退出房间">
              <p>
                确认后会离开当前房间与语音，并从当前玩家名单中移除。
                {activeRoomPhase && activeRoomPhase !== 'recruiting' ? ' 当前阶段不能保证自助重新加入，需要 KP 邀请或重新开放招募。' : ''}
              </p>
              {error && <p className="form-error">{error}</p>}
              <div>
                <button disabled={leaveBusy} type="button" onClick={() => setLeaveConfirmOpen(false)}>
                  取消
                </button>
                <button
                  className="danger-action"
                  disabled={leaveBusy}
                  type="button"
                  onClick={async () => {
                    setLeaveBusy(true)
                    setError('')
                    try {
                      await onLeaveActiveRoom()
                      setLeaveConfirmOpen(false)
                    } catch {
                      setError('正式退出失败，请检查网络后重试。')
                    } finally {
                      setLeaveBusy(false)
                    }
                  }}
                >
                  {leaveBusy ? '退出中' : '确认退出名单'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <section className="workspace-grid lobby-grid">
        <section className="panel room-panel">
          <header className="panel-title">
            <Home size={18} aria-hidden="true" />
            <h2>房间列表</h2>
            <div className="segmented room-list-tabs">
              <button
                className={roomListView === 'online' ? 'active' : ''}
                type="button"
                onClick={() => setRoomListView('online')}
              >
                联机房间
              </button>
              <button
                className={roomListView === 'closed' ? 'active' : ''}
                type="button"
                onClick={() => setRoomListView('closed')}
              >
                已关闭
              </button>
            </div>
          </header>
          <div className="room-list large">
            {visibleRooms.map((item) => {
              const previewCharacters = item.scriptCharacterPreviews.filter(
                (character) => character.name && character.publicSummary,
              ).slice(0, 2)
              return (
              <article className={!item.online ? 'room-card closed' : item.canJoin ? 'room-card' : 'room-card locked'} key={item.id}>
                <div className="room-card-main">
                  <strong>{item.name}</strong>
                  <span>
                    {item.system} / {roomPhaseLabel[item.phase]} / {item.ownerName}
                  </span>
                  {item.summary && <p className="room-card-summary">{item.summary}</p>}
                  {previewCharacters.length > 0 && (
                    <div className="room-card-roles">
                      {previewCharacters.map((character) => (
                        <span key={character.id}>{character.name}{character.occupation ? ` / ${character.occupation}` : ''}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="room-card-meta">
                  <span>
                    {item.visibility === 'private' ? <Lock size={14} aria-hidden="true" /> : <Unlock size={14} aria-hidden="true" />}
                    {item.visibility === 'private' ? '私密' : '公开'}
                  </span>
                  <span>
                    <Users size={14} aria-hidden="true" />
                    {item.players}
                  </span>
                  <span>
                    <Radio size={14} aria-hidden="true" />
                    {item.online ? '联机中' : '已关闭'}
                  </span>
                  {item.online && item.closeAt && (
                    <span>
                      <Clock size={14} aria-hidden="true" />
                      空房将于 {formatDateTime(item.closeAt)} 关闭
                    </span>
                  )}
                  {!item.online && item.closedAt && (
                    <span>
                      <Clock size={14} aria-hidden="true" />
                      关闭 {formatDateTime(item.closedAt)}
                    </span>
                  )}
                </div>
                <button
                  disabled={!item.canJoin || lockedByActiveRoom}
                  type="button"
                  onClick={() => {
                    if (lockedByActiveRoom) {
                      setError('已有挂起房间，不能加入其他房间。')
                      return
                    }
                    setPendingRoom(item)
                    setError('')
                  }}
                >
                  {lockedByActiveRoom ? '已挂起房间' : item.canJoin ? (item.online ? '加入' : '重新加入') : item.online ? '仅好友可加入' : '已关闭'}
                </button>
                {(item.ownerId === account.id || !item.online) && (
                  <button
                    className="room-delete-button"
                    disabled={deletingRoomId === item.id}
                    title={item.ownerId === account.id ? '删除房间数据' : '删除历史记录'}
                    type="button"
                    onClick={async () => {
                      const confirmText =
                        item.ownerId === account.id
                          ? '删除后会移除这个房间的地图、聊天、角色状态，无法恢复。确认删除？'
                          : '仅从你的历史房间中移除，不影响其他成员。确认移除？'
                      if (!window.confirm(confirmText)) {
                        return
                      }
                      setDeletingRoomId(item.id)
                      setError('')
                      try {
                        await onDeleteRoom(item.id)
                      } catch {
                        setError('删除房间失败，请稍后重试。')
                      } finally {
                        setDeletingRoomId('')
                      }
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                )}
              </article>
              )
            })}
            {visibleRooms.length === 0 && (
              <p className="empty-state">
                {roomListView === 'online' ? '暂无联机房间，点右上角创建一个团。' : '暂无已关闭的历史房间。'}
              </p>
            )}
          </div>
        </section>
      </section>
      {createOpen && (
        <div className="join-dialog" role="dialog" aria-modal="true" onClick={() => setCreateOpen(false)}>
          <section className="panel join-panel create-room-dialog" onClick={(event) => event.stopPropagation()}>
            <header className="panel-title">
              <CirclePlus size={18} aria-hidden="true" />
              <h2>创建房间</h2>
            </header>
            <div className="form-grid padded">
              <label className="field">
                <span>房间名</span>
                <input placeholder="新团名称" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="field">
                <span>规则</span>
                <input value={system} onChange={(event) => setSystem(event.target.value)} />
              </label>
              <label className="field">
                <span>关联剧本</span>
                <select value={scriptId} onChange={(event) => setScriptId(event.target.value)}>
                  <option value="">不关联</option>
                  {scripts.map((script) => (
                    <option key={script.id} value={script.id}>
                      {script.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="segmented">
                <button className={visibility === 'public' ? 'active' : ''} type="button" onClick={() => setVisibility('public')}>
                  <Unlock size={15} aria-hidden="true" />
                  公开
                </button>
                <button className={visibility === 'private' ? 'active' : ''} type="button" onClick={() => setVisibility('private')}>
                  <Lock size={15} aria-hidden="true" />
                  私密
                </button>
              </div>
              {error && <p className="form-error">{error}</p>}
              <div className="dialog-actions">
                <button type="button" onClick={() => setCreateOpen(false)}>
                  取消
                </button>
                <button
                  className="primary-action"
                  disabled={busy || lockedByActiveRoom}
                  type="button"
                  onClick={() => void submitCreateRoom()}
                >
                  <CirclePlus size={17} aria-hidden="true" />
                  {busy ? '创建中' : '创建并进入'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {pendingRoom && (
        <div className="join-dialog" role="dialog" aria-modal="true">
          <section className="panel join-panel">
            <header className="panel-title">
              <DoorOpen size={18} aria-hidden="true" />
              <h2>选择房间身份</h2>
            </header>
            <div className="padded form-grid">
              <div className="join-room-summary">
                <strong>{pendingRoom.name}</strong>
                <span>
                  {pendingRoom.system} / {pendingRoom.visibility === 'private' ? '私密房' : '公开房'}
                </span>
                <span>你的房间身份：{effectiveJoinRole === 'keeper' ? '守秘人' : '玩家'}</span>
                {pendingRoom.summary && <p>{pendingRoom.summary}</p>}
                {pendingRoom.scriptCharacterPreviews.length > 0 && (
                  <div className="join-room-roles">
                    {pendingRoom.scriptCharacterPreviews.map((character) => (
                      <article key={character.id}>
                        <strong>{character.name}</strong>
                        <span>{character.occupation || '职业待定'} / 名额 {character.count}</span>
                        <p>{character.publicSummary}</p>
                      </article>
                    ))}
                  </div>
                )}
              </div>
              <p className="muted">
                {effectiveJoinRole === 'keeper' ? '房主以守秘人身份进入，可推进流程与审核角色卡。' : '非房主以玩家身份进入，参与车卡、选角与跑团。'}
              </p>
              <div className="dialog-actions">
                <button type="button" onClick={() => setPendingRoom(null)}>
                  取消
                </button>
                <button
                  className="primary-action"
                  disabled={joinBusy}
                  type="button"
                  onClick={async () => {
                    setJoinBusy(true)
                    setError('')
                    try {
                      await onEnterRoom(pendingRoom, effectiveJoinRole)
                      setPendingRoom(null)
                    } catch {
                      setError('加入房间失败，请稍后重试。')
                    } finally {
                      setJoinBusy(false)
                    }
                  }}
                >
                  <ChevronRight size={17} aria-hidden="true" />
                  {joinBusy ? '进入中' : '进入房间'}
                </button>
              </div>
              {error && <p className="form-error">{error}</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function ChatPage({
  account,
  directAudioPlaybackBlocked,
  directCallActionError,
  directCallBusy,
  directCall,
  directCallNotice,
  directMessageEvents,
  directVoiceMuted,
  directVoiceNote,
  directVoiceStatus,
  friends,
  onMarkRead,
  onDirectCallAction,
  onRecoverDirectVoice,
  onRetryDirectVoice,
  onToggleDirectVoiceMute,
  token,
}: {
  account: Account
  directAudioPlaybackBlocked: boolean
  directCallActionError: string
  directCallBusy: boolean
  directCall: DirectCallEvent | null
  directCallNotice: string
  directMessageEvents: DirectMessage[]
  directVoiceMuted: boolean
  directVoiceNote: string
  directVoiceStatus: VoiceStatus
  friends: FriendSummary[]
  onMarkRead: (friendId: string, lastReadMessageId: string) => Promise<void>
  onDirectCallAction: DirectCallActionHandler
  onRecoverDirectVoice: () => Promise<void>
  onRetryDirectVoice: () => Promise<void>
  onToggleDirectVoiceMute: () => Promise<void>
  token: string
}) {
  const accepted = useMemo(() => friends.filter((friend) => friend.direction === 'friend'), [friends])
  const [selectedFriendId, setSelectedFriendId] = useState(() => accepted[0]?.id ?? '')
  const selectedFriendStillExists = Boolean(selectedFriendId && accepted.some((friend) => friend.id === selectedFriendId))
  const effectiveSelectedFriendId = selectedFriendStillExists ? selectedFriendId : accepted[0]?.id ?? ''
  const selectedFriend = accepted.find((friend) => friend.id === effectiveSelectedFriendId) ?? null
  const selectedFriendKey = selectedFriend?.id ?? ''
  const createDirectMessageList = useCallback(() => [] as DirectMessage[], [])
  const [messages, setMessages] = useKeyedState<DirectMessage[]>(selectedFriendKey, createDirectMessageList)
  const [draftsByFriend, setDraftsByFriend] = useState<Record<string, string>>({})
  const draft = selectedFriendKey ? draftsByFriend[selectedFriendKey] ?? '' : ''
  const [collapsed, setCollapsed] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [friendQuery, setFriendQuery] = useState('')
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [mobileFriendsOpen, setMobileFriendsOpen] = useState(false)
  const [selectedDirectMessageId, setSelectedDirectMessageId] = useState('')
  const [directReplyTarget, setDirectReplyTarget] = useState<DirectMessage['replyTo'] | null>(null)
  const [showDirectScrollBottom, setShowDirectScrollBottom] = useState(false)
  const [sendingFriendIds, setSendingFriendIds] = useState<string[]>([])
  const [statusByFriend, setStatusByFriend] = useState<Record<string, string>>({})
  const [messageCooldownUntil, setMessageCooldownUntil] = useState(0)
  const [, setDirectCooldownTick] = useState(0)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const directLongPressTimerRef = useRef<number | null>(null)
  const directLongPressStartRef = useRef<{ x: number; y: number } | null>(null)
  const preserveScrollRef = useRef<{ top: number; height: number } | null>(null)
  const pendingRevealDirectMessageIdRef = useRef('')
  const scrollModeRef = useRef<'bottom' | 'preserve' | 'none'>('bottom')
  const selectedFriendKeyRef = useRef('')
  const directMessageLoadSeqRef = useRef(0)
  const directStickToBottomRef = useRef(true)
  const markedReadMessageIdRef = useRef('')
  const onMarkReadRef = useRef(onMarkRead)
  const loadingOlderMessagesRef = useRef(false)
  const sendingFriendIdsRef = useRef<Set<string>>(new Set())
  const pendingDirectMessageRetryRef = useRef<globalThis.Map<string, PendingDirectMessageRetry>>(new globalThis.Map())
  const filteredFriends = accepted.filter((friend) => {
    const query = friendQuery.trim().toLowerCase()
    if (!query) {
      return true
    }
    return `${friend.displayName} ${friend.email}`.toLowerCase().includes(query)
  })
  const directMessagesForSelectedFriend = directMessageEvents.filter(
    (message) =>
      (message.fromId === selectedFriendKey && message.toId === account.id) ||
      (message.fromId === account.id && message.toId === selectedFriendKey),
  )
  const visibleMessages = mergeDirectMessageList(messages, directMessagesForSelectedFriend)
  const directMessageIds = useMemo(() => new Set(visibleMessages.map((message) => message.id)), [visibleMessages])
  const selectedDirectMessage =
    selectedDirectMessageId && directMessageIds.has(selectedDirectMessageId)
      ? visibleMessages.find((message) => message.id === selectedDirectMessageId) ?? null
      : null
  const selectedPendingDirectRetry = selectedFriendKey
    ? pendingDirectMessageRetryRef.current.get(selectedFriendKey)
    : undefined
  const activeDirectReplyTarget =
    directReplyTarget &&
    (directMessageIds.has(directReplyTarget.id) || selectedPendingDirectRetry?.replyToId === directReplyTarget.id)
      ? directReplyTarget
      : null
  const latestDirectMessageId = lastItem(directMessagesForSelectedFriend)?.id ?? ''
  const latestVisibleMessageId = lastItem(visibleMessages)?.id ?? ''
  const latestIncomingVisibleMessageId =
    lastItem(visibleMessages.filter((message) => message.fromId === selectedFriendKey && message.toId === account.id))
      ?.id ?? ''
  const messageCooldownSeconds = remainingCooldownSeconds(messageCooldownUntil)
  const status = selectedFriendKey ? statusByFriend[selectedFriendKey] ?? '' : ''
  const sendingMessage = Boolean(selectedFriendKey && sendingFriendIds.includes(selectedFriendKey))
  const chatStatus = messageCooldownSeconds > 0 ? `发送过于频繁，请 ${messageCooldownSeconds} 秒后再试。` : status
  const directCallPeerId = directCall ? directCallPeer(directCall, account.id).id : ''
  const directCallBelongsToSelectedFriend = Boolean(directCall && directCallPeerId === selectedFriendKey)
  const showOutOfThreadDirectCallBanner = Boolean(
    (directCall && !directCallBelongsToSelectedFriend) ||
      (!directCall && (directCallActionError || directCallNotice)),
  )
  const directCallIncoming = Boolean(directCall && directCall.status === 'ringing' && directCall.toId === account.id)
  const directCallOutgoing = Boolean(directCall && directCall.status === 'ringing' && directCall.fromId === account.id)
  const directCallActive = directCall?.status === 'accepted'
  const directVoiceActive = directCallActive || directVoiceStatus === 'connecting' || directVoiceStatus === 'connected' || directVoiceStatus === 'demo'
  const directCallUnavailable = directCallBusy || directCallIncoming || directCallOutgoing || directVoiceActive

  useNativeBackHandler(() => {
    if (emojiOpen) {
      setEmojiOpen(false)
      return true
    }
    if (selectedDirectMessageId) {
      setSelectedDirectMessageId('')
      return true
    }
    if (directReplyTarget) {
      setDirectReplyTarget(null)
      return true
    }
    if (historyOpen) {
      setHistoryOpen(false)
      return true
    }
    if (mobileFriendsOpen) {
      setMobileFriendsOpen(false)
      return true
    }
    return false
  }, 60)

  const clearDirectLongPress = () => {
    if (directLongPressTimerRef.current !== null) {
      window.clearTimeout(directLongPressTimerRef.current)
      directLongPressTimerRef.current = null
    }
    directLongPressStartRef.current = null
  }

  const markSelectedFriendRead = useCallback((messageId: string) => {
    const friendId = selectedFriendKeyRef.current
    if (!friendId || !messageId || markedReadMessageIdRef.current === messageId) {
      return
    }
    markedReadMessageIdRef.current = messageId
    void onMarkReadRef.current(friendId, messageId).catch(() => {
      markedReadMessageIdRef.current = ''
    })
  }, [])

  const updateDirectScrollBottomState = useCallback(() => {
    const list = messageListRef.current
    if (!list) {
      return
    }
    const awayFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight > 96
    directStickToBottomRef.current = !awayFromBottom
    setShowDirectScrollBottom(awayFromBottom)
    if (!awayFromBottom) {
      markSelectedFriendRead(latestIncomingVisibleMessageId)
    }
  }, [latestIncomingVisibleMessageId, markSelectedFriendRead])

  const scrollDirectToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const list = messageListRef.current
    if (!list) {
      return
    }
    preserveScrollRef.current = null
    scrollModeRef.current = 'bottom'
    list.scrollTo({ top: list.scrollHeight, behavior })
    directStickToBottomRef.current = true
    setShowDirectScrollBottom(false)
    markSelectedFriendRead(latestIncomingVisibleMessageId)
  }, [latestIncomingVisibleMessageId, markSelectedFriendRead])

  const setSelectedDraft = useCallback((action: SetStateAction<string>) => {
    const friendId = selectedFriendKeyRef.current
    if (!friendId) {
      return
    }
    setDraftsByFriend((current) => {
      const previous = current[friendId] ?? ''
      const nextValue = resolveStateAction(action, previous)
      const pendingRetry = pendingDirectMessageRetryRef.current.get(friendId)
      if (!pendingRetry || pendingRetry.text !== nextValue.trim()) {
        pendingDirectMessageRetryRef.current.delete(friendId)
      }
      if (!nextValue) {
        const next = { ...current }
        delete next[friendId]
        return next
      }
      return { ...current, [friendId]: nextValue }
    })
  }, [])

  const setDraftForFriend = useCallback((friendId: string, action: SetStateAction<string>) => {
    if (!friendId) {
      return
    }
    setDraftsByFriend((current) => {
      const previous = current[friendId] ?? ''
      const nextValue = resolveStateAction(action, previous)
      if (!nextValue) {
        const next = { ...current }
        delete next[friendId]
        return next
      }
      return { ...current, [friendId]: nextValue }
    })
  }, [])

  const setStatusForFriend = useCallback((friendId: string, nextStatus: string) => {
    if (!friendId) {
      return
    }
    setStatusByFriend((current) => {
      if (!nextStatus) {
        if (!current[friendId]) {
          return current
        }
        const next = { ...current }
        delete next[friendId]
        return next
      }
      return { ...current, [friendId]: nextStatus }
    })
  }, [])

  const clearLoadStatusForFriend = useCallback((friendId: string) => {
    if (!friendId) {
      return
    }
    setStatusByFriend((current) => {
      const previous = current[friendId] ?? ''
      if (previous !== '聊天记录加载失败。' && previous !== '更早的聊天记录加载失败。') {
        return current
      }
      const next = { ...current }
      delete next[friendId]
      return next
    })
  }, [])

  const setSelectedStatus = useCallback(
    (nextStatus: string) => {
      setStatusForFriend(selectedFriendKeyRef.current, nextStatus)
    },
    [setStatusForFriend],
  )

  const setFriendSending = useCallback((friendId: string, sending: boolean) => {
    if (!friendId) {
      return
    }
    const next = new Set(sendingFriendIdsRef.current)
    if (sending) {
      next.add(friendId)
    } else {
      next.delete(friendId)
    }
    sendingFriendIdsRef.current = next
    setSendingFriendIds(Array.from(next))
  }, [])

  useEffect(() => clearDirectLongPress, [])

  useEffect(() => {
    onMarkReadRef.current = onMarkRead
  }, [onMarkRead])

  useEffect(() => {
    if (!messageCooldownUntil) {
      return
    }
    const timer = window.setInterval(() => {
      const timestamp = Date.now()
      setMessageCooldownUntil((current) => (current > 0 && current <= timestamp ? 0 : current))
      setDirectCooldownTick(timestamp)
    }, 500)
    return () => window.clearInterval(timer)
  }, [messageCooldownUntil])

  useEffect(() => {
    if (selectedFriendStillExists || !effectiveSelectedFriendId) {
      return
    }
    const timer = window.setTimeout(() => setSelectedFriendId(effectiveSelectedFriendId), 0)
    return () => window.clearTimeout(timer)
  }, [effectiveSelectedFriendId, selectedFriendStillExists])

  useLayoutEffect(() => {
    directMessageLoadSeqRef.current += 1
    selectedFriendKeyRef.current = selectedFriendKey
    markedReadMessageIdRef.current = ''
    loadingOlderMessagesRef.current = false
    preserveScrollRef.current = null
    scrollModeRef.current = 'bottom'
    directStickToBottomRef.current = true
    pendingRevealDirectMessageIdRef.current = ''
    setSelectedDirectMessageId('')
    setDirectReplyTarget(selectedFriendKey ? pendingDirectMessageRetryRef.current.get(selectedFriendKey)?.replyTo ?? null : null)
    setEmojiOpen(false)
    setHistoryOpen(false)
    setLoadingMessages(false)
    setLoadingOlderMessages(false)
    setShowDirectScrollBottom(false)
  }, [selectedFriendKey])

  const loadOlderMessages = async () => {
    if (!selectedFriendKey || !hasMoreMessages || loadingOlderMessagesRef.current || messages.length === 0) {
      return
    }
    loadingOlderMessagesRef.current = true
    const requestSeq = directMessageLoadSeqRef.current
    const requestFriendId = selectedFriendKey
    const list = messageListRef.current
    if (list) {
      preserveScrollRef.current = { top: list.scrollTop, height: list.scrollHeight }
      scrollModeRef.current = 'preserve'
    }
    setLoadingOlderMessages(true)
    try {
      const page = await loadDirectMessages(token, selectedFriendKey, {
        limit: 20,
        before: messages[0].id,
      })
      if (selectedFriendKeyRef.current !== requestFriendId || directMessageLoadSeqRef.current !== requestSeq) {
        return
      }
      setMessages((current) => mergeDirectMessageList(current, page.messages ?? []))
      setHasMoreMessages(page.hasMore)
      clearLoadStatusForFriend(requestFriendId)
    } catch {
      if (selectedFriendKeyRef.current !== requestFriendId || directMessageLoadSeqRef.current !== requestSeq) {
        return
      }
      setStatusForFriend(requestFriendId, '更早的聊天记录加载失败。')
      preserveScrollRef.current = null
      scrollModeRef.current = 'none'
    } finally {
      if (selectedFriendKeyRef.current === requestFriendId && directMessageLoadSeqRef.current === requestSeq) {
        loadingOlderMessagesRef.current = false
        setLoadingOlderMessages(false)
      }
    }
  }

  const revealVisibleDirectMessage = useCallback((messageId: string, behavior: ScrollBehavior = 'smooth') => {
    const list = messageListRef.current
    const selector = `[data-direct-message-id="${escapeAttributeValue(messageId)}"]`
    const element = list?.querySelector<HTMLElement>(selector)
    if (!element) {
      return false
    }
    element.scrollIntoView({ block: 'center', behavior })
    directStickToBottomRef.current = false
    setSelectedDirectMessageId(messageId)
    setShowDirectScrollBottom(true)
    setSelectedStatus('')
    return true
  }, [setSelectedStatus])

  const loadUntilDirectMessageVisible = useCallback(
    async (targetMessageId: string) => {
      if (!selectedFriendKey || !hasMoreMessages || loadingOlderMessagesRef.current || visibleMessages.length === 0) {
        return false
      }
      const list = messageListRef.current
      if (list) {
        preserveScrollRef.current = { top: list.scrollTop, height: list.scrollHeight }
        scrollModeRef.current = 'preserve'
      }
      loadingOlderMessagesRef.current = true
      setLoadingOlderMessages(true)
      try {
        const requestSeq = directMessageLoadSeqRef.current
        const requestFriendId = selectedFriendKey
        let before = visibleMessages[0]?.id
        let hasMore: boolean = hasMoreMessages
        let found = false
        let accumulatedMessages: DirectMessage[] = []
        for (let pageIndex = 0; pageIndex < 10 && hasMore && before; pageIndex += 1) {
          const page = await loadDirectMessages(token, requestFriendId, {
            limit: 20,
            before,
          })
          if (selectedFriendKeyRef.current !== requestFriendId || directMessageLoadSeqRef.current !== requestSeq) {
            return false
          }
          const olderMessages = page.messages ?? []
          if (olderMessages.length === 0) {
            hasMore = false
            break
          }
          accumulatedMessages = mergeDirectMessageList(accumulatedMessages, olderMessages)
          found = found || olderMessages.some((message) => message.id === targetMessageId)
          before = olderMessages[0]?.id
          hasMore = Boolean(page.hasMore)
          if (found) {
            break
          }
        }
        setMessages((current) => mergeDirectMessageList(current, accumulatedMessages))
        setHasMoreMessages(hasMore)
        setStatusForFriend(requestFriendId, found ? '' : hasMore ? '原消息还在更早记录中，请再次点击继续定位。' : '原消息已不在当前聊天记录中。')
        return found
      } catch {
        preserveScrollRef.current = null
        scrollModeRef.current = 'none'
        setStatusForFriend(selectedFriendKey, '加载原消息失败，请检查网络后重试。')
        return false
      } finally {
        loadingOlderMessagesRef.current = false
        setLoadingOlderMessages(false)
      }
    },
    [hasMoreMessages, selectedFriendKey, setMessages, setStatusForFriend, token, visibleMessages],
  )

  const scrollToDirectMessage = useCallback((messageId: string) => {
    if (!directMessageIds.has(messageId)) {
      if (hasMoreMessages) {
        void loadUntilDirectMessageVisible(messageId).then((found) => {
          if (!found) {
            return
          }
          pendingRevealDirectMessageIdRef.current = messageId
          preserveScrollRef.current = null
          scrollModeRef.current = 'none'
          setSelectedStatus('正在定位原消息。')
        })
        setSelectedStatus('正在加载原消息。')
        return
      }
      setSelectedStatus('原消息已不在当前聊天记录中。')
      return
    }
    if (!revealVisibleDirectMessage(messageId)) {
      setSelectedStatus('原消息暂不可见，请先加载更早记录。')
    }
  }, [directMessageIds, hasMoreMessages, loadUntilDirectMessageVisible, revealVisibleDirectMessage, setSelectedStatus])

  useLayoutEffect(() => {
    const list = messageListRef.current
    if (!list) {
      return
    }
    const pendingRevealDirectMessageId = pendingRevealDirectMessageIdRef.current
    if (pendingRevealDirectMessageId) {
      preserveScrollRef.current = null
      scrollModeRef.current = 'none'
      if (revealVisibleDirectMessage(pendingRevealDirectMessageId, 'auto')) {
        pendingRevealDirectMessageIdRef.current = ''
        updateDirectScrollBottomState()
        return
      }
    }
    if (scrollModeRef.current === 'preserve' && preserveScrollRef.current) {
      const previous = preserveScrollRef.current
      list.scrollTop = list.scrollHeight - previous.height + previous.top
      preserveScrollRef.current = null
      scrollModeRef.current = 'none'
      updateDirectScrollBottomState()
      return
    }
    if (scrollModeRef.current === 'bottom' || directStickToBottomRef.current) {
      scrollDirectToBottom('auto')
      scrollModeRef.current = 'none'
      markSelectedFriendRead(latestIncomingVisibleMessageId)
      return
    }
    updateDirectScrollBottomState()
  }, [latestIncomingVisibleMessageId, latestVisibleMessageId, markSelectedFriendRead, revealVisibleDirectMessage, scrollDirectToBottom, selectedFriendKey, updateDirectScrollBottomState, visibleMessages.length])

  useEffect(() => {
    if (!selectedFriendKey) {
      return
    }

    let disposed = false
    const effectSeq = directMessageLoadSeqRef.current
    const loadLatestMessages = async (replace = false) => {
      const list = messageListRef.current
      const nearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 96
      directStickToBottomRef.current = nearBottom
      scrollModeRef.current = replace || nearBottom ? 'bottom' : 'none'
      if (replace) {
        setLoadingMessages(true)
      }
      const requestFriendId = selectedFriendKey
      try {
        const page = await loadDirectMessages(token, selectedFriendKey, { limit: 20 })
        if (disposed || selectedFriendKeyRef.current !== requestFriendId || directMessageLoadSeqRef.current !== effectSeq) {
          return
        }
        const loadedMessages = page.messages ?? []
        setMessages((current) => (replace ? loadedMessages : mergeDirectMessageList(current, loadedMessages)))
        if (replace) {
          setHasMoreMessages(page.hasMore)
        }
        clearLoadStatusForFriend(requestFriendId)
      } catch {
        if (disposed || selectedFriendKeyRef.current !== requestFriendId || directMessageLoadSeqRef.current !== effectSeq) {
          return
        }
        setStatusForFriend(requestFriendId, '聊天记录加载失败。')
      } finally {
        if (!disposed && replace && selectedFriendKeyRef.current === requestFriendId && directMessageLoadSeqRef.current === effectSeq) {
          setLoadingMessages(false)
        }
      }
    }
    const load = () => {
      if (!disposed && document.visibilityState === 'visible') {
        void loadLatestMessages(false)
      }
    }
    const loadWhenFocused = () => {
      if (!disposed) {
        void loadLatestMessages(false)
      }
    }
    const initialLoadTimer = window.setTimeout(() => {
      if (!disposed) {
        void loadLatestMessages(true)
      }
    }, 0)
    const timer = window.setInterval(load, 10_000)
    window.addEventListener('focus', loadWhenFocused)
    document.addEventListener('visibilitychange', load)
    return () => {
      disposed = true
      window.clearTimeout(initialLoadTimer)
      window.clearInterval(timer)
      window.removeEventListener('focus', loadWhenFocused)
      document.removeEventListener('visibilitychange', load)
    }
  }, [clearLoadStatusForFriend, selectedFriendKey, setMessages, setStatusForFriend, token])

  useEffect(() => {
    if (!latestDirectMessageId) {
      return
    }
    const list = messageListRef.current
    const nearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 96
    directStickToBottomRef.current = nearBottom
    scrollModeRef.current = nearBottom ? 'bottom' : 'none'
    if (nearBottom) {
      markSelectedFriendRead(latestIncomingVisibleMessageId)
    }
  }, [latestDirectMessageId, latestIncomingVisibleMessageId, latestVisibleMessageId, markSelectedFriendRead])

  const directMessageAuthor = useCallback(
    (message: DirectMessage) => (message.fromId === account.id ? account.displayName : selectedFriend?.displayName ?? '好友'),
    [account.displayName, account.id, selectedFriend?.displayName],
  )

  const startDirectReply = () => {
    if (!selectedDirectMessage) {
      return
    }
    setDirectReplyTarget({
      id: selectedDirectMessage.id,
      author: directMessageAuthor(selectedDirectMessage),
      text: selectedDirectMessage.text.slice(0, 160),
    })
    setSelectedStatus('')
    setSelectedDirectMessageId('')
    window.setTimeout(() => messageListRef.current?.parentElement?.querySelector<HTMLTextAreaElement>('.direct-input textarea')?.focus(), 0)
  }

  const submit = async () => {
    const text = draft.trim()
    if (!selectedFriend || !text || sendingFriendIdsRef.current.has(selectedFriend.id)) {
      return
    }
    if (messageCooldownSeconds > 0) {
      setStatusForFriend(selectedFriend.id, `发送过于频繁，请 ${messageCooldownSeconds} 秒后再试。`)
      return
    }
    const sendingFriendId = selectedFriend.id
    const pendingRetry = pendingDirectMessageRetryRef.current.get(sendingFriendId)
    const replyToId = activeDirectReplyTarget?.id
    const clientMessageId =
      pendingRetry && pendingRetry.text === text && pendingRetry.replyToId === replyToId
        ? pendingRetry.clientMessageId
        : buildId('dm')
    pendingDirectMessageRetryRef.current.delete(sendingFriendId)
    setFriendSending(sendingFriendId, true)
    setDraftForFriend(sendingFriendId, '')
    setStatusForFriend(sendingFriendId, '')
    try {
      const message = await sendDirectMessage(token, sendingFriendId, text, {
        clientMessageId,
        replyToId,
      })
      if (selectedFriendKeyRef.current === sendingFriendId) {
        scrollModeRef.current = 'bottom'
        setMessages((current) => mergeDirectMessageList(current, [message]))
        setDirectReplyTarget(null)
        setSelectedDirectMessageId('')
      }
    } catch (error) {
      pendingDirectMessageRetryRef.current.set(sendingFriendId, {
        clientMessageId,
        friendId: sendingFriendId,
        replyTo: activeDirectReplyTarget ?? undefined,
        replyToId,
        text,
      })
      const cooldownUntil = cooldownUntilFrom(error)
      if (cooldownUntil) {
        setMessageCooldownUntil(cooldownUntil)
      }
      setDraftForFriend(sendingFriendId, (current) => (current.trim() ? current : text))
      setStatusForFriend(sendingFriendId, `发送失败：${formatErrorWithRetry(error, '请检查网络后重试')}`)
    } finally {
      setFriendSending(sendingFriendId, false)
    }
  }

  const submitDirectCallAction = (eventName: DirectCallActionName, friendId: string, callId?: string) => {
    setSelectedStatus('')
    void onDirectCallAction(eventName, friendId, callId).catch(() => undefined)
  }

  return (
    <div className="page-stack chat-page">
      <header className="page-header">
        <div>
          <p>好友消息</p>
          <h1>聊天</h1>
        </div>
      </header>
      {showOutOfThreadDirectCallBanner && (
        <DirectCallBanner
          account={account}
          actionError={directCallActionError}
          busy={directCallBusy}
          className="global-call-banner chat-page-call-banner"
          directAudioPlaybackBlocked={directAudioPlaybackBlocked}
          directCall={directCall}
          directCallNotice={directCallNotice}
          directVoiceMuted={directVoiceMuted}
          directVoiceNote={directVoiceNote}
          directVoiceStatus={directVoiceStatus}
          onAction={onDirectCallAction}
          onRecoverDirectVoice={onRecoverDirectVoice}
          onRetryDirectVoice={onRetryDirectVoice}
          onToggleDirectVoiceMute={onToggleDirectVoiceMute}
        />
      )}
      <section className={`chat-shell panel${collapsed ? ' collapsed' : ''}${mobileFriendsOpen ? ' friends-open' : ''}`}>
        <aside className="chat-friends" aria-label="好友会话">
          <button className="mobile-friend-close" type="button" onClick={() => setMobileFriendsOpen(false)}>
            <PanelLeftClose size={17} aria-hidden="true" />
            收起好友
          </button>
          <button className="chat-collapse" type="button" onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
            {!collapsed && '收起'}
          </button>
          {!collapsed && (
            <label className="chat-search">
              <Search size={15} aria-hidden="true" />
              <input
                placeholder="搜索好友"
                value={friendQuery}
                onChange={(event) => setFriendQuery(event.target.value)}
              />
            </label>
          )}
          <div className="chat-friend-list">
            {filteredFriends.map((friend) => {
              const preview = friend.lastMessage
                ? `${friend.lastMessage.fromId === account.id ? '我: ' : ''}${friend.lastMessage.text}`
                : friend.email
              const unreadCount = friend.unreadCount ?? 0
              return (
                <button
                  className={selectedFriend?.id === friend.id ? 'active' : ''}
                  key={friend.id}
                  type="button"
                  onClick={() => {
                    setSelectedFriendId(friend.id)
                    setMessages([])
                    setHasMoreMessages(false)
                    setMobileFriendsOpen(false)
                    setHistoryOpen(false)
                  }}
                  title={friend.displayName}
                >
                  <span className="friend-avatar-wrap">
                    <AvatarView name={friend.displayName} value={friend.avatar} />
                    {collapsed && unreadCount > 0 && <i aria-label={`${unreadCount} 条未读消息`} />}
                  </span>
                  {!collapsed && (
                    <span className="friend-chat-copy">
                      <strong>{friend.displayName}</strong>
                      <small>{preview}</small>
                    </span>
                  )}
                  {!collapsed && unreadCount > 0 && (
                    <span className="friend-unread">{formatBadgeCount(unreadCount)}</span>
                  )}
                </button>
              )
            })}
          </div>
          {accepted.length === 0 && <p className="muted">暂无好友，先到账户页添加好友。</p>}
          {accepted.length > 0 && filteredFriends.length === 0 && <p className="muted">没有匹配的好友。</p>}
        </aside>
        <section className={`${chatStatus ? 'direct-chat has-status' : 'direct-chat'}${activeDirectReplyTarget ? ' has-reply' : ''}`}>
          {selectedFriend ? (
            <>
              <header className="direct-chat-header">
                <div>
                  <span>
                    <strong>{selectedFriend.displayName}</strong>
                    <small>{selectedFriend.email}</small>
                  </span>
                </div>
                <div className="chat-tools">
                  <button className="mobile-friends-toggle" type="button" title="好友列表" onClick={() => setMobileFriendsOpen(true)}>
                    <PanelLeftOpen size={17} aria-hidden="true" />
                  </button>
                  <button type="button" title="聊天记录" onClick={() => setHistoryOpen((value) => !value)}>
                    <Clock size={17} aria-hidden="true" />
                  </button>
                  <button
                    disabled={directCallUnavailable}
                    type="button"
                    title="语音通话"
                    onClick={() => submitDirectCallAction('direct-call:invite', selectedFriend.id)}
                  >
                    <PhoneCall size={17} aria-hidden="true" />
                  </button>
                </div>
              </header>
              {directCallBelongsToSelectedFriend && (
                <DirectCallBanner
                  account={account}
                  actionError={directCallActionError}
                  busy={directCallBusy}
                  directAudioPlaybackBlocked={directAudioPlaybackBlocked}
                  directCall={directCall}
                  directCallNotice={directCallNotice}
                  directVoiceMuted={directVoiceMuted}
                  directVoiceNote={directVoiceNote}
                  directVoiceStatus={directVoiceStatus}
                  onAction={onDirectCallAction}
                  onRecoverDirectVoice={onRecoverDirectVoice}
                  onRetryDirectVoice={onRetryDirectVoice}
                  onToggleDirectVoiceMute={onToggleDirectVoiceMute}
                />
              )}
              {historyOpen && (
                <div className="chat-history-panel">
                  {visibleMessages.length === 0 ? '暂无聊天记录' : `已载入 ${visibleMessages.length} 条聊天记录${hasMoreMessages ? '，上滑继续加载' : ''}`}
                </div>
              )}
              <div
                className="direct-messages"
                ref={messageListRef}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) {
                    setSelectedDirectMessageId('')
                  }
                }}
                onScroll={(event) => {
                  updateDirectScrollBottomState()
                  if (hasMoreMessages && !loadingOlderMessages && event.currentTarget.scrollTop < 48) {
                    void loadOlderMessages()
                  }
                }}
              >
                {hasMoreMessages && (
                  <button
                    className="load-more-messages"
                    disabled={loadingOlderMessages}
                    type="button"
                    onClick={() => void loadOlderMessages()}
                  >
                    {loadingOlderMessages ? '加载中' : '加载更早消息'}
                  </button>
                )}
                {loadingMessages && visibleMessages.length === 0 && <p className="empty-state">正在加载聊天记录。</p>}
                {visibleMessages.map((message) => {
                  const mine = message.fromId === account.id
                  const selected = selectedDirectMessageId === message.id
                  return (
                    <article
                      className={`${mine ? 'mine' : ''}${selected ? ' selected' : ''}`}
                      data-direct-message-id={message.id}
                      key={message.id}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setSelectedDirectMessageId(message.id)
                      }}
                      onClick={() => {
                        setSelectedDirectMessageId((current) => (current === message.id ? '' : message.id))
                      }}
                      onPointerCancel={clearDirectLongPress}
                      onPointerDown={(event) => {
                        clearDirectLongPress()
                        directLongPressStartRef.current = { x: event.clientX, y: event.clientY }
                        directLongPressTimerRef.current = window.setTimeout(() => {
                          setSelectedDirectMessageId(message.id)
                          directLongPressTimerRef.current = null
                          directLongPressStartRef.current = null
                        }, 450)
                      }}
                      onPointerLeave={clearDirectLongPress}
                      onPointerMove={(event) => {
                        const start = directLongPressStartRef.current
                        if (!start) {
                          return
                        }
                        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
                          clearDirectLongPress()
                        }
                      }}
                      onPointerUp={clearDirectLongPress}
                    >
                      {message.replyTo && (
                        <button
                          className="message-reply-link direct-reply-link"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            scrollToDirectMessage(message.replyTo!.id)
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <span>回复 {message.replyTo.author}</span>
                          <small>{message.replyTo.text}</small>
                        </button>
                      )}
                      <p>{message.text}</p>
                      {selected && <small>已选中消息</small>}
                      <span>{formatClock(message.createdAt)}</span>
                    </article>
                  )
                })}
                {!loadingMessages && visibleMessages.length === 0 && <p className="empty-state">还没有消息。</p>}
              </div>
              {showDirectScrollBottom && (
                <button className="scroll-to-bottom direct" type="button" title="回到最新消息" onClick={() => scrollDirectToBottom()}>
                  <ArrowDown size={18} aria-hidden="true" />
                </button>
              )}
              {selectedDirectMessage && (
                <div className="message-action-bar direct-message-action-bar">
                  <span>{directMessageAuthor(selectedDirectMessage)}</span>
                  <button type="button" onClick={startDirectReply}>
                    <MessageCircle size={15} aria-hidden="true" />
                    回复
                  </button>
                  <button type="button" title="取消选择" onClick={() => setSelectedDirectMessageId('')}>
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
              )}
              {chatStatus && <p className="chat-status">{chatStatus}</p>}
              <div className="direct-input">
                <div className="emoji-popover-wrap">
                  <button disabled={sendingMessage} type="button" title="emoji" onClick={() => setEmojiOpen((value) => !value)}>
                    <Smile size={18} aria-hidden="true" />
                  </button>
                  {emojiOpen && (
                    <div className="emoji-popover">
                      {['😀', '😂', '👍', '🎲', '🔥', '❤️'].map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => {
                            setSelectedDraft((value) => `${value}${emoji}`)
                            setEmojiOpen(false)
                          }}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {activeDirectReplyTarget && (
                  <div className="reply-composer direct-reply-composer">
                    <button type="button" onClick={() => scrollToDirectMessage(activeDirectReplyTarget.id)}>
                      <span>回复 {activeDirectReplyTarget.author}</span>
                      <small>{activeDirectReplyTarget.text}</small>
                    </button>
                    <button type="button" title="取消回复" onClick={() => setDirectReplyTarget(null)}>
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
                )}
                <textarea
                  disabled={sendingMessage}
                  maxLength={2000}
                  placeholder="输入消息"
                  rows={2}
                  value={draft}
                  onChange={(event) => setSelectedDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void submit()
                    }
                  }}
                />
                <button
                  className="primary-action"
                  disabled={sendingMessage || messageCooldownSeconds > 0 || !draft.trim()}
                  type="button"
                  title={sendingMessage ? '发送中' : messageCooldownSeconds > 0 ? `请 ${messageCooldownSeconds} 秒后再试` : '发送'}
                  onClick={() => void submit()}
                >
                  <Send size={18} aria-hidden="true" />
                </button>
              </div>
            </>
          ) : (
            <p className="empty-state">暂无可聊天好友。</p>
          )}
        </section>
      </section>
    </div>
  )
}

function FriendManagement({
  friends,
  onAccept,
  onRemove,
  onRequest,
}: {
  friends: FriendSummary[]
  onAccept: (friendId: string) => Promise<void>
  onRemove: (friendId: string) => Promise<void>
  onRequest: (email: string) => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const accepted = friends.filter((friend) => friend.direction === 'friend')
  const incoming = friends.filter((friend) => friend.direction === 'incoming')
  const outgoing = friends.filter((friend) => friend.direction === 'outgoing')

  return (
    <section className="workspace-grid social-grid">
      <section className="panel">
        <header className="panel-title">
          <UserPlus size={18} aria-hidden="true" />
          <h2>添加好友</h2>
        </header>
        <form
          className="form-grid padded"
          onSubmit={(event) => {
            event.preventDefault()
            setError('')
            void onRequest(email)
              .then(() => setEmail(''))
              .catch(() => setError('找不到该邮箱，或申请已存在。'))
          }}
        >
          <label className="field">
            <span>对方邮箱</span>
            <input inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-action" type="submit">
            <UserPlus size={17} aria-hidden="true" />
            发送申请
          </button>
        </form>
      </section>
      <section className="panel">
        <header className="panel-title">
          <Users size={18} aria-hidden="true" />
          <h2>好友申请</h2>
        </header>
        <FriendList friends={incoming} onAccept={onAccept} onRemove={onRemove} title="待我同意" />
        <FriendList friends={outgoing} onAccept={onAccept} onRemove={onRemove} title="等待对方同意" />
      </section>
      <section className="panel">
        <header className="panel-title">
          <MessageCircle size={18} aria-hidden="true" />
          <h2>好友列表</h2>
        </header>
        <FriendList friends={accepted} onAccept={onAccept} onRemove={onRemove} title="已添加好友" />
      </section>
    </section>
  )
}

function FriendList({
  title,
  friends,
  onAccept,
  onRemove,
}: {
  title: string
  friends: FriendSummary[]
  onAccept: (friendId: string) => Promise<void>
  onRemove: (friendId: string) => Promise<void>
}) {
  return (
    <div className="friend-section">
      <h3>{title}</h3>
      {friends.length === 0 ? (
        <p className="muted">暂无记录</p>
      ) : (
        friends.map((friend) => (
          <article className="friend-row" key={friend.id}>
            <AvatarView name={friend.displayName} value={friend.avatar} />
            <div>
              <strong>{friend.displayName}</strong>
              <span>{friend.lastMessage?.text ?? friend.email}</span>
            </div>
            <div className="friend-actions">
              {friend.direction === 'friend' && (friend.unreadCount ?? 0) > 0 && (
                <span className="friend-unread inline">{formatBadgeCount(friend.unreadCount ?? 0)}</span>
              )}
              {friend.direction === 'incoming' && (
                <button type="button" onClick={() => void onAccept(friend.id)}>
                  <Check size={16} aria-hidden="true" />
                  同意
                </button>
              )}
              <button
                className="danger-action"
                type="button"
                onClick={() => {
                  const action = friend.direction === 'friend' ? '解除好友关系' : friend.direction === 'incoming' ? '拒绝申请' : '撤销申请'
                  if (window.confirm(`确认${action}？`)) {
                    void onRemove(friend.id)
                  }
                }}
              >
                {friend.direction === 'friend' ? <Trash2 size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
                {friend.direction === 'friend' ? '删除' : friend.direction === 'incoming' ? '拒绝' : '撤销'}
              </button>
            </div>
          </article>
        ))
      )}
    </div>
  )
}

function ScriptsPage({
  account,
  scripts,
  token,
  onRefresh,
}: {
  account: Account
  scripts: TrpgScriptSummary[]
  token: string
  onRefresh: () => Promise<void>
}) {
  const [selectedScript, setSelectedScript] = useState<TrpgScript | null>(null)
  const [editorView, setEditorView] = useState<ScriptEditorView>('overview')
  const [selectedChapterId, setSelectedChapterId] = useState('')
  const [importTitle, setImportTitle] = useState('')
  const [importText, setImportText] = useState('')
  const [status, setStatus] = useState('')
  const [deletingScriptId, setDeletingScriptId] = useState('')
  const [scriptBusyAction, setScriptBusyAction] = useState('')
  const [scriptConflict, setScriptConflict] = useState<ScriptConflictState | null>(null)
  const [scriptDirty, setScriptDirty] = useState(false)
  const scriptEditVersionRef = useRef(0)
  const selectedScriptRef = useRef<TrpgScript | null>(null)
  const scriptDirtyRef = useRef(false)
  const scriptEditorRef = useRef<HTMLElement | null>(null)

  const scrollScriptEditorIntoView = useCallback(() => {
    window.setTimeout(() => {
      const forceMobile = document.documentElement.classList.contains('force-mobile')
      const narrowViewport = window.matchMedia('(max-width: 900px)').matches
      if (!forceMobile && !narrowViewport) {
        return
      }
      scriptEditorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }, [])

  const setScriptDraftDirty = (dirty: boolean) => {
    scriptDirtyRef.current = dirty
    setScriptDirty(dirty)
  }

  const replaceSelectedScript = (script: TrpgScript | null) => {
    const nextScript = script ? sanitizeScriptForEditor(script) : null
    scriptEditVersionRef.current = 0
    selectedScriptRef.current = nextScript
    setScriptDraftDirty(false)
    setScriptConflict(null)
    setSelectedScript(nextScript)
  }

  const editSelectedScript = (updater: (current: TrpgScript | null) => TrpgScript | null) => {
    scriptEditVersionRef.current += 1
    setScriptDraftDirty(true)
    setSelectedScript((current) => {
      const next = updater(current)
      selectedScriptRef.current = next
      return next
    })
  }

  useEffect(() => {
    if (!scriptDirty) {
      return
    }
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload)
    }
  }, [scriptDirty])

  const confirmDiscardScriptDraft = (action = '切换') => {
    if (scriptConflict && !window.confirm('当前剧本存在保存冲突，本地草稿尚未另存。确认丢弃草稿并继续？')) {
      return false
    }
    if (scriptDirtyRef.current && !window.confirm(`当前剧本有未保存编辑，确认丢弃草稿并${action}？`)) {
      return false
    }
    return true
  }

  useNativeBackHandler(() => {
    if (!selectedScriptRef.current) {
      return false
    }
    if (!confirmDiscardScriptDraft('返回列表')) {
      return true
    }
    replaceSelectedScript(null)
    setEditorView('overview')
    setSelectedChapterId('')
    setStatus('')
    return true
  }, 60)

  const startLocalScript = () => {
    if (!confirmDiscardScriptDraft('新建剧本')) {
      return
    }
    const draft = makeLocalScript(account)
    replaceSelectedScript(draft)
    setEditorView('overview')
    setSelectedChapterId(draft.chapters[0]?.id ?? '')
    setStatus('')
    scrollScriptEditorIntoView()
  }

  const loadSelectedScript = async (scriptId: string) => {
    if (!confirmDiscardScriptDraft('切换剧本')) {
      return
    }
    setScriptBusyAction(`load:${scriptId}`)
    setStatus('')
    try {
      const script = await loadScript(scriptId, token)
      replaceSelectedScript(script)
      setEditorView('overview')
      setSelectedChapterId(script.chapters[0]?.id ?? '')
      scrollScriptEditorIntoView()
    } catch (error) {
      setStatus(`加载剧本失败：${describeError(error, '请检查网络后重试')}`)
    } finally {
      setScriptBusyAction('')
    }
  }

  const saveSelectedScript = async () => {
    const scriptToSave = selectedScriptRef.current
    if (!scriptToSave) {
      return
    }
    const invalidDice = invalidScriptDiceProfiles(scriptToSave)
    if (invalidDice.length > 0) {
      setEditorView('dice')
      setStatus(`保存前请修正骰子公式：${invalidDice.map((dice) => dice.label || '未命名骰子').join('、')}`)
      scrollScriptEditorIntoView()
      return
    }
    setScriptBusyAction('save')
    setStatus('')
    try {
      const saveVersion = scriptEditVersionRef.current
      const saved = scriptToSave.id.startsWith('local-')
        ? await createScript(token, scriptToSave)
        : await updateScript(token, scriptToSave.id, scriptToSave)
      if (scriptEditVersionRef.current === saveVersion) {
        replaceSelectedScript(saved)
        setStatus('已保存')
      } else {
        setSelectedScript((current) => {
          const next =
            current?.id === scriptToSave.id
              ? {
                  ...current,
                  id: saved.id,
                  ownerId: saved.ownerId,
                  ownerName: saved.ownerName,
                  createdAt: saved.createdAt,
                  updatedAt: saved.updatedAt,
                  version: saved.version,
                }
              : current
          selectedScriptRef.current = next
          return next
        })
        setScriptDraftDirty(true)
        setStatus('已保存；保存期间的新编辑已保留，请再次保存最新改动')
      }
      await onRefresh()
    } catch (error) {
      const conflict = scriptConflictFromError(error)
      if (conflict && conflict.current.id === scriptToSave.id) {
        setScriptConflict(conflict)
        setStatus('保存冲突：服务器版本已更新，本地草稿已保留。')
        return
      }
      setStatus(`保存失败：${describeError(error, '请检查网络或权限')}`)
    } finally {
      setScriptBusyAction('')
    }
  }

  const reloadServerScriptVersion = () => {
    if (!scriptConflict) {
      return
    }
    if (!window.confirm('重新加载会丢弃当前本地草稿。确认加载服务器版本？')) {
      return
    }
    replaceSelectedScript(scriptConflict.current)
    setSelectedChapterId(scriptConflict.current.chapters[0]?.id ?? '')
    setStatus(`已加载服务器版本 v${scriptConflict.currentVersion}`)
  }

  const saveConflictDraftAsCopy = async () => {
    const draft = selectedScriptRef.current
    if (!draft) {
      return
    }
    setScriptBusyAction('save-copy')
    setStatus('')
    try {
      const copied = await createScript(token, {
        title: draft.title.endsWith(' 副本') ? draft.title : `${draft.title} 副本`,
        system: draft.system,
        visibility: draft.visibility,
        summary: draft.summary,
        tags: draft.tags,
        coverUrl: draft.coverUrl,
        maps: draft.maps,
        characters: draft.characters,
        diceProfiles: draft.diceProfiles,
        chapters: draft.chapters,
      })
      replaceSelectedScript(copied)
      setSelectedChapterId(copied.chapters[0]?.id ?? '')
      await onRefresh()
      setStatus('已另存为副本')
    } catch (error) {
      setStatus(`另存副本失败：${describeError(error, '请检查网络或权限')}`)
    } finally {
      setScriptBusyAction('')
    }
  }

  const removeSelectedScript = async (script: TrpgScriptSummary) => {
    if (selectedScript?.id === script.id && !confirmDiscardScriptDraft('删除剧本')) {
      return
    }
    if (!script.canEdit || !window.confirm('删除后会移除这个剧本，已创建的房间不会被删除。确认删除？')) {
      return
    }
    setDeletingScriptId(script.id)
    try {
      await deleteScript(token, script.id)
      if (selectedScript?.id === script.id) {
        replaceSelectedScript(null)
        setSelectedChapterId('')
      }
      await onRefresh()
      setStatus('剧本已删除')
    } catch {
      setStatus('删除剧本失败，请稍后重试。')
    } finally {
      setDeletingScriptId('')
    }
  }

  const updateMap = (mapId: string, patch: Partial<ScriptMap>) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            maps: current.maps.map((item) => (item.id === mapId ? sanitizeScriptMap({ ...item, ...patch }) : item)),
          }
        : current,
    )
  }

  const updateMapFeature = (mapId: string, featureId: string, patch: Partial<MapFeature>) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            maps: current.maps.map((map) =>
              map.id === mapId
                ? {
                    ...map,
                    features: (map.features ?? []).map((feature) =>
                      feature.id === featureId
                        ? sanitizeMapFeatureForBounds({ ...feature, ...patch }, map.width, map.height)
                        : feature,
                    ),
                  }
                : map,
            ),
          }
        : current,
    )
  }

  const addMapFeature = (mapId: string) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            maps: current.maps.map((map) =>
              map.id === mapId
                ? {
                    ...map,
                    features: [
                      ...(map.features ?? []),
                      {
                        id: buildId('feature'),
                        type: 'wall',
                        label: '墙体',
                        x: 1,
                        y: 1,
                        w: Math.min(4, map.width),
                        h: 1,
                      },
                    ],
                  }
                : map,
            ),
          }
        : current,
    )
  }

  const removeMapFeature = (mapId: string, featureId: string) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            maps: current.maps.map((map) =>
              map.id === mapId
                ? {
                    ...map,
                    features: (map.features ?? []).filter((feature) => feature.id !== featureId),
                  }
                : map,
            ),
          }
        : current,
    )
  }

  const updateMapToken = (mapId: string, tokenId: string, patch: Partial<MapToken>) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            maps: current.maps.map((map) =>
              map.id === mapId
                ? {
                    ...map,
                    tokens: (map.tokens ?? []).map((token) =>
                      token.id === tokenId ? sanitizeMapTokenForBounds({ ...token, ...patch }, map.width, map.height) : token,
                    ),
                  }
                : map,
            ),
          }
        : current,
    )
  }

  const addMapToken = (mapId: string) => {
    editSelectedScript((current) => {
      const firstCharacterId = current?.characters[0]?.id
      if (!current || !firstCharacterId) {
        return current
      }
      return {
        ...current,
        maps: current.maps.map((map) =>
          map.id === mapId
            ? {
                ...map,
                tokens: [
                  ...(map.tokens ?? []),
                  {
                    id: buildId('token'),
                    characterId: firstCharacterId,
                    label: current.characters[0]?.name.slice(0, 2) || '棋',
                    color: '#187a6d',
                    x: 1,
                    y: 1,
                    status: 'ready',
                  },
                ],
              }
            : map,
        ),
      }
    })
  }

  const removeMapToken = (mapId: string, tokenId: string) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            maps: current.maps.map((map) =>
              map.id === mapId
                ? {
                    ...map,
                    tokens: (map.tokens ?? []).filter((token) => token.id !== tokenId),
                  }
                : map,
            ),
          }
        : current,
    )
  }

  const updateScriptCharacter = (characterId: string, patch: Partial<ScriptCharacter>) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            characters: current.characters.map((item) => (item.id === characterId ? { ...item, ...patch } : item)),
          }
        : current,
    )
  }

  const updateDice = (diceId: string, patch: Partial<DiceProfile>) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            diceProfiles: current.diceProfiles.map((item) => (item.id === diceId ? { ...item, ...patch } : item)),
          }
        : current,
    )
  }

  const updateChapter = (chapterId: string, patch: Partial<ScriptChapter>) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            chapters: current.chapters.map((chapter) =>
              chapter.id === chapterId ? { ...chapter, ...patch } : chapter,
            ),
          }
        : current,
    )
  }

  const updateBlock = (
    chapterId: string,
    blockId: string,
    updater: (block: ScriptBlock, script: TrpgScript) => ScriptBlock,
  ) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            chapters: current.chapters.map((chapter) =>
              chapter.id === chapterId
                ? {
                    ...chapter,
                    blocks: chapter.blocks.map((block) =>
                      block.id === blockId ? updater(block, current) : block,
                    ),
                  }
                : chapter,
            ),
          }
        : current,
    )
  }

  const removeMap = (mapId: string) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            maps: current.maps.filter((map) => map.id !== mapId),
            chapters: current.chapters.map((chapter) => ({
              ...chapter,
              blocks: chapter.blocks.filter((block) => block.type !== 'map' || block.mapId !== mapId),
            })),
          }
        : current,
    )
    setStatus('地图已删除，引用它的章节块也已移除。')
  }

  const removeScriptCharacter = (characterId: string) => {
    editSelectedScript((current) =>
      current
        ? {
          ...current,
          characters: current.characters.filter((character) => character.id !== characterId),
          maps: current.maps.map((map) => ({
            ...map,
            tokens: (map.tokens ?? []).filter((token) => token.characterId !== characterId),
          })),
          chapters: current.chapters.map((chapter) => ({
            ...chapter,
            blocks: chapter.blocks.filter(
                (block) => block.type !== 'character' || block.characterId !== characterId,
              ),
            })),
          }
        : current,
    )
    setStatus('人物已删除，引用它的章节块也已移除。')
  }

  const removeDice = (diceId: string) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            diceProfiles: current.diceProfiles.filter((dice) => dice.id !== diceId),
            chapters: current.chapters.map((chapter) => ({
              ...chapter,
              blocks: chapter.blocks.filter((block) => block.type !== 'check' || block.diceId !== diceId),
            })),
          }
        : current,
    )
    setStatus('骰子已删除，引用它的判定块也已移除。')
  }

  const addChapter = () => {
    const chapter: ScriptChapter = {
      id: buildId('chapter'),
      title: `新章节 ${(selectedScript?.chapters.length ?? 0) + 1}`,
      blocks: [emptyScriptBlock('narrative')],
    }
    editSelectedScript((current) =>
      current ? { ...current, chapters: [...current.chapters, chapter] } : current,
    )
    setSelectedChapterId(chapter.id)
  }

  const removeChapter = (chapterId: string) => {
    editSelectedScript((current) => {
      if (!current) {
        return current
      }
      const chapters = current.chapters.filter((chapter) => chapter.id !== chapterId)
      setSelectedChapterId(chapters[0]?.id ?? '')
      return { ...current, chapters }
    })
  }

  const moveChapter = (chapterId: string, direction: -1 | 1) => {
    editSelectedScript((current) => {
      if (!current) {
        return current
      }
      const index = current.chapters.findIndex((chapter) => chapter.id === chapterId)
      return { ...current, chapters: moveItem(current.chapters, index, direction) }
    })
  }

  const addBlock = (chapterId: string, type: ScriptBlock['type']) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            chapters: current.chapters.map((chapter) =>
              chapter.id === chapterId
                ? { ...chapter, blocks: [...chapter.blocks, scriptBlockFor(current, type)] }
                : chapter,
            ),
          }
        : current,
    )
  }

  const removeBlock = (chapterId: string, blockId: string) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            chapters: current.chapters.map((chapter) =>
              chapter.id === chapterId
                ? { ...chapter, blocks: chapter.blocks.filter((block) => block.id !== blockId) }
                : chapter,
            ),
          }
        : current,
    )
  }

  const moveBlock = (chapterId: string, blockId: string, direction: -1 | 1) => {
    editSelectedScript((current) =>
      current
        ? {
            ...current,
            chapters: current.chapters.map((chapter) => {
              if (chapter.id !== chapterId) {
                return chapter
              }
              const index = chapter.blocks.findIndex((block) => block.id === blockId)
              return { ...chapter, blocks: moveItem(chapter.blocks, index, direction) }
            }),
          }
        : current,
    )
  }

  const selectedChapter = selectedScript?.chapters.find((chapter) => chapter.id === selectedChapterId) ?? selectedScript?.chapters[0]
  const invalidDiceIds = new Set((selectedScript ? invalidScriptDiceProfiles(selectedScript) : []).map((dice) => dice.id))

  const renderBlockEditor = (chapter: ScriptChapter, block: ScriptBlock, blockIndex: number) => (
    <article className="block-editor" key={block.id}>
      <div className="block-editor-head">
        <input
          value={block.title}
          onChange={(event) =>
            updateBlock(chapter.id, block.id, (current) => ({ ...current, title: event.target.value }))
          }
        />
        <select
          value={block.type}
          onChange={(event) => {
            const type = event.target.value as ScriptBlock['type']
            updateBlock(chapter.id, block.id, (current, script) => scriptBlockFor(script, type, current))
          }}
        >
          <option value="narrative">正文</option>
          <option disabled={selectedScript?.maps.length === 0} value="map">地图</option>
          <option disabled={selectedScript?.characters.length === 0} value="character">人物</option>
          <option disabled={selectedScript?.diceProfiles.length === 0} value="check">判定</option>
        </select>
        <div className="order-buttons">
          <button
            disabled={blockIndex === 0}
            type="button"
            title="上移块"
            onClick={() => moveBlock(chapter.id, block.id, -1)}
          >
            <ArrowUp size={15} aria-hidden="true" />
          </button>
          <button
            disabled={blockIndex === chapter.blocks.length - 1}
            type="button"
            title="下移块"
            onClick={() => moveBlock(chapter.id, block.id, 1)}
          >
            <ArrowDown size={15} aria-hidden="true" />
          </button>
        </div>
        <button type="button" title="删除块" onClick={() => removeBlock(chapter.id, block.id)}>
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>
      {block.type === 'narrative' && (
        <textarea
          rows={5}
          placeholder="朗读文本、线索、场景描述"
          value={block.markdown}
          onChange={(event) =>
            updateBlock(chapter.id, block.id, (current) =>
              current.type === 'narrative' ? { ...current, markdown: event.target.value } : current,
            )
          }
        />
      )}
      {block.type === 'map' && selectedScript && (
        <div className="block-fields">
          <label className="field">
            <span>选择地图</span>
            <select
              value={block.mapId}
              onChange={(event) =>
                updateBlock(chapter.id, block.id, (current) =>
                  current.type === 'map' ? { ...current, mapId: event.target.value } : current,
                )
              }
            >
              {selectedScript.maps.map((map) => (
                <option key={map.id} value={map.id}>
                  {map.name}
                </option>
              ))}
            </select>
          </label>
          <textarea
            rows={3}
            placeholder="地图切换说明、暗门、可见线索"
            value={block.notes}
            onChange={(event) =>
              updateBlock(chapter.id, block.id, (current) =>
                current.type === 'map' ? { ...current, notes: event.target.value } : current,
              )
            }
          />
        </div>
      )}
      {block.type === 'character' && selectedScript && (
        <div className="block-fields">
          <label className="field">
            <span>选择人物</span>
            <select
              value={block.characterId}
              onChange={(event) =>
                updateBlock(chapter.id, block.id, (current) =>
                  current.type === 'character' ? { ...current, characterId: event.target.value } : current,
                )
              }
            >
              {selectedScript.characters.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </select>
          </label>
          <textarea
            rows={3}
            placeholder="登场方式、公开台词、玩家可见线索"
            value={block.notes}
            onChange={(event) =>
              updateBlock(chapter.id, block.id, (current) =>
                current.type === 'character' ? { ...current, notes: event.target.value } : current,
              )
            }
          />
        </div>
      )}
      {block.type === 'check' && selectedScript && (
        <div className="block-fields check-block-fields">
          <label className="field">
            <span>选择已有骰子</span>
            <select
              value={block.diceId}
              onChange={(event) =>
                updateBlock(chapter.id, block.id, (current) =>
                  current.type === 'check' ? { ...current, diceId: event.target.value } : current,
                )
              }
            >
              {selectedScript.diceProfiles.map((dice) => (
                <option key={dice.id} value={dice.id}>
                  {dice.label} / {dice.formula}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>难度/阈值</span>
            <input
              min={1}
              type="number"
              value={block.difficulty}
              onChange={(event) =>
                updateBlock(chapter.id, block.id, (current) =>
                  current.type === 'check' ? { ...current, difficulty: Number(event.target.value) } : current,
                )
              }
            />
          </label>
          <textarea
            rows={2}
            placeholder="成功结果"
            value={block.onPass}
            onChange={(event) =>
              updateBlock(chapter.id, block.id, (current) =>
                current.type === 'check' ? { ...current, onPass: event.target.value } : current,
              )
            }
          />
          <textarea
            rows={2}
            placeholder="失败结果"
            value={block.onFail}
            onChange={(event) =>
              updateBlock(chapter.id, block.id, (current) =>
                current.type === 'check' ? { ...current, onFail: event.target.value } : current,
              )
            }
          />
        </div>
      )}
    </article>
  )

  const editorContent = () => {
    if (!selectedScript) {
      return <div className="empty-state">选择一个剧本，或新建剧本开始编辑。</div>
    }

    if (editorView === 'overview') {
      return (
        <div className="editor-page-grid">
          <label className="field">
            <span>标题</span>
            <input
              value={selectedScript.title}
              onChange={(event) => editSelectedScript((current) => (current ? { ...current, title: event.target.value } : current))}
            />
          </label>
          <label className="field">
            <span>规则</span>
            <input
              value={selectedScript.system}
              onChange={(event) => editSelectedScript((current) => (current ? { ...current, system: event.target.value } : current))}
            />
          </label>
          <label className="field">
            <span>可见性</span>
            <select
              value={selectedScript.visibility}
              onChange={(event) =>
                editSelectedScript((current) =>
                  current
                    ? {
                        ...current,
                        visibility: event.target.value as 'public' | 'private',
                      }
                    : current,
                )
              }
            >
              <option value="private">私有</option>
              <option value="public">公开</option>
            </select>
          </label>
          <label className="field wide">
            <span>简介</span>
            <textarea
              rows={4}
              value={selectedScript.summary}
              onChange={(event) => editSelectedScript((current) => (current ? { ...current, summary: event.target.value } : current))}
            />
          </label>
          <label className="field wide">
            <span>标签，用逗号分隔</span>
            <input
              value={selectedScript.tags.join(', ')}
              onChange={(event) =>
                editSelectedScript((current) =>
                  current
                    ? {
                        ...current,
                        tags: event.target.value
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean)
                          .slice(0, 12),
                      }
                    : current,
                )
              }
            />
          </label>
        </div>
      )
    }

    if (editorView === 'maps') {
      return (
        <div className="resource-list">
          <button
            className="toolbar-button"
            type="button"
            onClick={() =>
              editSelectedScript((current) =>
                current
                  ? {
                      ...current,
                      maps: [...current.maps, { id: buildId('map'), name: '新地图', width: 12, height: 8, notes: '' }],
                    }
                  : current,
              )
            }
          >
            <CirclePlus size={16} aria-hidden="true" />
            新增地图
          </button>
          {selectedScript.maps.map((map) => (
            <article className="resource-card" key={map.id}>
              <header>
                <Map size={17} aria-hidden="true" />
                <strong>{map.name || '未命名地图'}</strong>
                <button type="button" title="删除地图" onClick={() => removeMap(map.id)}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </header>
              <div className="mini-editor">
                <input value={map.name} onChange={(event) => updateMap(map.id, { name: event.target.value })} />
                <input min={mapMinSize} max={mapMaxWidth} type="number" value={map.width} onChange={(event) => updateMap(map.id, { width: parseGridInput(event.target.value, mapMinSize, mapMaxWidth) })} />
                <input min={mapMinSize} max={mapMaxHeight} type="number" value={map.height} onChange={(event) => updateMap(map.id, { height: parseGridInput(event.target.value, mapMinSize, mapMaxHeight) })} />
                <textarea rows={3} value={map.notes} onChange={(event) => updateMap(map.id, { notes: event.target.value })} />
              </div>
              <div
                className="script-map-preview"
                style={{ '--cols': map.width, '--rows': map.height } as CSSProperties}
              >
                {(map.features ?? []).map((feature) => (
                  <span
                    className={`map-feature ${feature.type}`}
                    key={feature.id}
                    style={mapFeaturePreviewStyle(map, feature)}
                  >
                    {feature.label}
                  </span>
                ))}
                {(map.tokens ?? []).map((token) => (
                  <span
                    className={`script-map-token ${token.status}`}
                    key={token.id}
                    style={mapTokenPreviewStyle(map, token)}
                    title={`${token.label} / ${mapTokenStatusLabel[token.status]}`}
                  >
                    {token.label || '棋'}
                  </span>
                ))}
              </div>
              <div className="map-object-editor">
                <section>
                  <header>
                    <strong>地图要素</strong>
                    <button type="button" onClick={() => addMapFeature(map.id)}>
                      <CirclePlus size={15} aria-hidden="true" />
                      新增
                    </button>
                  </header>
                  {(map.features ?? []).length === 0 ? (
                    <p className="empty-state">暂无墙体、门、掩体或危险区。</p>
                  ) : (
                    (map.features ?? []).map((feature) => (
                      <div className="map-object-row feature-row" key={feature.id}>
                        <select
                          value={feature.type}
                          onChange={(event) => updateMapFeature(map.id, feature.id, { type: event.target.value as MapFeature['type'] })}
                        >
                          {(Object.keys(mapFeatureTypeLabel) as MapFeature['type'][]).map((type) => (
                            <option key={type} value={type}>{mapFeatureTypeLabel[type]}</option>
                          ))}
                        </select>
                        <input
                          aria-label="要素标签"
                          value={feature.label}
                          onChange={(event) => updateMapFeature(map.id, feature.id, { label: event.target.value })}
                        />
                        <input aria-label="X" min={1} max={map.width} type="number" value={feature.x} onChange={(event) => updateMapFeature(map.id, feature.id, { x: parseGridInput(event.target.value, 1, map.width) })} />
                        <input aria-label="Y" min={1} max={map.height} type="number" value={feature.y} onChange={(event) => updateMapFeature(map.id, feature.id, { y: parseGridInput(event.target.value, 1, map.height) })} />
                        <input aria-label="宽" min={1} max={map.width} type="number" value={feature.w} onChange={(event) => updateMapFeature(map.id, feature.id, { w: parseGridInput(event.target.value, 1, map.width) })} />
                        <input aria-label="高" min={1} max={map.height} type="number" value={feature.h} onChange={(event) => updateMapFeature(map.id, feature.id, { h: parseGridInput(event.target.value, 1, map.height) })} />
                        <button type="button" title="删除地图要素" onClick={() => removeMapFeature(map.id, feature.id)}>
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                    ))
                  )}
                </section>
                <section>
                  <header>
                    <strong>棋子 / NPC</strong>
                    <button disabled={selectedScript.characters.length === 0} type="button" onClick={() => addMapToken(map.id)}>
                      <CirclePlus size={15} aria-hidden="true" />
                      新增
                    </button>
                  </header>
                  {selectedScript.characters.length === 0 && <p className="empty-state">先在人物页创建角色或 NPC，再放置棋子。</p>}
                  {(map.tokens ?? []).length === 0 ? (
                    <p className="empty-state">暂无地图棋子。</p>
                  ) : (
                    (map.tokens ?? []).map((token) => (
                      <div className="map-object-row token-row" key={token.id}>
                        <select
                          value={token.characterId}
                          onChange={(event) => updateMapToken(map.id, token.id, { characterId: event.target.value })}
                        >
                          {selectedScript.characters.map((character) => (
                            <option key={character.id} value={character.id}>{character.name}</option>
                          ))}
                        </select>
                        <input
                          aria-label="棋子标签"
                          value={token.label}
                          onChange={(event) => updateMapToken(map.id, token.id, { label: event.target.value })}
                        />
                        <input
                          aria-label="棋子颜色"
                          type="color"
                          value={/^#[0-9a-f]{6}$/i.test(token.color) ? token.color : '#187a6d'}
                          onChange={(event) => updateMapToken(map.id, token.id, { color: event.target.value })}
                        />
                        <select
                          value={token.status}
                          onChange={(event) => updateMapToken(map.id, token.id, { status: event.target.value as MapToken['status'] })}
                        >
                          {(Object.keys(mapTokenStatusLabel) as MapToken['status'][]).map((status) => (
                            <option key={status} value={status}>{mapTokenStatusLabel[status]}</option>
                          ))}
                        </select>
                        <input aria-label="棋子X" min={1} max={map.width} type="number" value={token.x} onChange={(event) => updateMapToken(map.id, token.id, { x: parseGridInput(event.target.value, 1, map.width) })} />
                        <input aria-label="棋子Y" min={1} max={map.height} type="number" value={token.y} onChange={(event) => updateMapToken(map.id, token.id, { y: parseGridInput(event.target.value, 1, map.height) })} />
                        <button type="button" title="删除地图棋子" onClick={() => removeMapToken(map.id, token.id)}>
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                    ))
                  )}
                </section>
              </div>
            </article>
          ))}
        </div>
      )
    }

    if (editorView === 'characters') {
      return (
        <div className="resource-list">
          <button
            className="toolbar-button"
            type="button"
            onClick={() =>
              editSelectedScript((current) =>
                current
                  ? {
                      ...current,
                      characters: [
                        ...current.characters,
                        {
                          id: buildId('sc'),
                          name: '新人物',
                          count: 1,
                          parameters: '',
                          story: '',
                          occupation: '',
                          publicSummary: '',
                          privateBrief: '',
                          recommendedSkills: [],
                        },
                      ],
                    }
                  : current,
              )
            }
          >
            <CirclePlus size={16} aria-hidden="true" />
            新增人物
          </button>
          {selectedScript.characters.map((character) => (
            <article className="resource-card" key={character.id}>
              <header>
                <Activity size={17} aria-hidden="true" />
                <strong>{character.name || '未命名人物'}</strong>
                <button type="button" title="删除人物" onClick={() => removeScriptCharacter(character.id)}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </header>
              <div className="mini-editor character-mini">
                <input value={character.name} onChange={(event) => updateScriptCharacter(character.id, { name: event.target.value })} />
                <input min={1} type="number" value={character.count} onChange={(event) => updateScriptCharacter(character.id, { count: Number(event.target.value) })} />
                <input
                  placeholder="推荐职业，如 记者 / 医生 / 私家侦探"
                  value={character.occupation ?? ''}
                  onChange={(event) => updateScriptCharacter(character.id, { occupation: event.target.value })}
                />
                <textarea
                  rows={3}
                  placeholder="公开人设：玩家在招募/车卡前可看到的身份、动机、关系"
                  value={character.publicSummary ?? ''}
                  onChange={(event) => updateScriptCharacter(character.id, { publicSummary: event.target.value })}
                />
                <textarea rows={3} placeholder="人物参数，如 HP 10 / SAN 50 / 侦查 60" value={character.parameters} onChange={(event) => updateScriptCharacter(character.id, { parameters: event.target.value })} />
                <textarea
                  rows={3}
                  placeholder="推荐技能，每行一个，例如：侦查:25"
                  value={formatRecommendedSkills(character)}
                  onChange={(event) => updateScriptCharacter(character.id, { recommendedSkills: parseRecommendedSkills(event.target.value) })}
                />
                <textarea rows={4} placeholder="公开背景、关系、出场动机" value={character.story} onChange={(event) => updateScriptCharacter(character.id, { story: event.target.value })} />
                <textarea
                  rows={3}
                  placeholder="KP 私密备注：隐藏目标、真相、限制条件"
                  value={character.privateBrief ?? ''}
                  onChange={(event) => updateScriptCharacter(character.id, { privateBrief: event.target.value })}
                />
              </div>
            </article>
          ))}
        </div>
      )
    }

    if (editorView === 'dice') {
      return (
        <div className="resource-list">
          <button
            className="toolbar-button"
            type="button"
            onClick={() =>
              editSelectedScript((current) =>
                current
                  ? {
                      ...current,
                      diceProfiles: [
                        ...current.diceProfiles,
                        { id: buildId('dice'), label: '新骰子', formula: '1d20', probability: 0.5 },
                      ],
                    }
                  : current,
              )
            }
          >
            <CirclePlus size={16} aria-hidden="true" />
            新增骰子
          </button>
          {selectedScript.diceProfiles.map((dice) => (
            <article className={invalidDiceIds.has(dice.id) ? 'resource-card has-error' : 'resource-card'} key={dice.id}>
              <header>
                <Dice5 size={17} aria-hidden="true" />
                <strong>{dice.label || '未命名骰子'}</strong>
                <button type="button" title="删除骰子" onClick={() => removeDice(dice.id)}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </header>
              <div className="mini-editor dice-mini">
                <input value={dice.label} onChange={(event) => updateDice(dice.id, { label: event.target.value })} />
                <input
                  aria-invalid={invalidDiceIds.has(dice.id)}
                  value={dice.formula}
                  onChange={(event) => updateDice(dice.id, { formula: event.target.value })}
                />
                <input max={1} min={0} step={0.01} type="number" value={dice.probability} onChange={(event) => updateDice(dice.id, { probability: Number(event.target.value) })} />
              </div>
              {invalidDiceIds.has(dice.id) && (
                <p className="field-error">骰子公式格式错误，请使用 1d100、2d6+1、1d100&lt;=60、1d20&gt;=10 或 .ra 侦查。</p>
              )}
            </article>
          ))}
        </div>
      )
    }

    return (
      <div className="chapters-editor">
        <aside className="chapter-list">
          <button className="toolbar-button" type="button" onClick={addChapter}>
            <CirclePlus size={16} aria-hidden="true" />
            新增章节
          </button>
          {selectedScript.chapters.map((chapter) => (
            <button
              className={chapter.id === selectedChapter?.id ? 'active' : ''}
              key={chapter.id}
              type="button"
              onClick={() => setSelectedChapterId(chapter.id)}
            >
              <span>{chapter.title || '未命名章节'}</span>
              <small>{chapter.blocks.length} 个块</small>
            </button>
          ))}
        </aside>
        <section className="chapter-editor">
          {!selectedChapter ? (
            <p className="empty-state">先新增一个章节。</p>
          ) : (
            <>
              <div className="chapter-header">
                <input
                  value={selectedChapter.title}
                  onChange={(event) => updateChapter(selectedChapter.id, { title: event.target.value })}
                />
                <div className="order-buttons">
                  <button
                    disabled={selectedScript.chapters.findIndex((chapter) => chapter.id === selectedChapter.id) === 0}
                    type="button"
                    title="上移章节"
                    onClick={() => moveChapter(selectedChapter.id, -1)}
                  >
                    <ArrowUp size={15} aria-hidden="true" />
                  </button>
                  <button
                    disabled={selectedScript.chapters.findIndex((chapter) => chapter.id === selectedChapter.id) === selectedScript.chapters.length - 1}
                    type="button"
                    title="下移章节"
                    onClick={() => moveChapter(selectedChapter.id, 1)}
                  >
                    <ArrowDown size={15} aria-hidden="true" />
                  </button>
                </div>
                <button type="button" title="删除章节" onClick={() => removeChapter(selectedChapter.id)}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
              <div className="block-add-row">
                <button type="button" onClick={() => addBlock(selectedChapter.id, 'narrative')}>正文</button>
                <button type="button" disabled={selectedScript.maps.length === 0} onClick={() => addBlock(selectedChapter.id, 'map')}>地图</button>
                <button type="button" disabled={selectedScript.characters.length === 0} onClick={() => addBlock(selectedChapter.id, 'character')}>人物</button>
                <button type="button" disabled={selectedScript.diceProfiles.length === 0} onClick={() => addBlock(selectedChapter.id, 'check')}>判定</button>
              </div>
              {selectedChapter.blocks.map((block, index) => renderBlockEditor(selectedChapter, block, index))}
              {selectedChapter.blocks.length === 0 && <p className="empty-state">这个章节还没有内容块。</p>}
            </>
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p>剧本库</p>
          <h1>创建与上传剧本</h1>
        </div>
        <button className="toolbar-button" disabled={Boolean(scriptBusyAction)} type="button" onClick={startLocalScript}>
          <CirclePlus size={17} aria-hidden="true" />
          新建
        </button>
      </header>
      <section className="script-layout">
        <aside className="panel script-list-panel">
          <header className="panel-title">
            <BookOpen size={18} aria-hidden="true" />
            <h2>我的与公开剧本</h2>
          </header>
          <div className="script-list">
            {scripts.map((script) => (
              <article className="script-list-item" key={script.id}>
                <button
                  disabled={Boolean(scriptBusyAction)}
                  type="button"
                  onClick={() => void loadSelectedScript(script.id)}
                >
                  <strong>{script.title}</strong>
                  <span>
                    {script.system} / {script.visibility === 'public' ? '公开' : '私有'}
                  </span>
                  <small>{script.summary || '暂无简介'}</small>
                </button>
                {script.canEdit && (
                  <button
                    disabled={deletingScriptId === script.id}
                    title="删除剧本"
                    type="button"
                    onClick={() => void removeSelectedScript(script)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                )}
              </article>
            ))}
          </div>
          <div className="import-box">
            <h3>上传文本剧本</h3>
            <input placeholder="剧本标题" value={importTitle} onChange={(event) => setImportTitle(event.target.value)} />
            <input
              type="file"
              accept=".txt,.md"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) {
                  return
                }
                if (!importTitle) {
                  setImportTitle(file.name.replace(/\.[^.]+$/, ''))
                }
                void file.text()
                  .then(setImportText)
                  .catch(() => setStatus('读取文件失败，请确认文件可访问且为文本格式。'))
              }}
            />
            <textarea
              placeholder="也可以直接粘贴剧本文本"
              rows={5}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
            />
            <button
              disabled={scriptBusyAction === 'import'}
              type="button"
              onClick={async () => {
                if (!importTitle.trim() || !importText.trim()) {
                  setStatus('请填写标题和文本')
                  return
                }
                if (!confirmDiscardScriptDraft('导入剧本')) {
                  return
                }
                setScriptBusyAction('import')
                setStatus('')
                try {
                  const imported = await importScript(token, {
                    title: importTitle,
                    system: 'COC 7th',
                    rawText: importText,
                  })
                  replaceSelectedScript(imported)
                  setImportTitle('')
                  setImportText('')
                  await onRefresh()
                  setStatus('导入完成')
                  scrollScriptEditorIntoView()
                } catch (error) {
                  setStatus(`导入失败：${describeError(error, '请检查剧本文本或网络')}`)
                } finally {
                  setScriptBusyAction('')
                }
              }}
            >
              <Upload size={16} aria-hidden="true" />
              导入
            </button>
            {status && !selectedScript && <p className="status-line script-list-status">{status}</p>}
          </div>
        </aside>

        <section className="panel script-editor" ref={scriptEditorRef}>
          <header className="panel-title">
            <Settings size={18} aria-hidden="true" />
            <h2>{selectedScript ? selectedScript.title : '剧本编辑器'}</h2>
            {scriptDirty && !scriptConflict && <span className="script-dirty-pill">未保存</span>}
            <button disabled={!selectedScript || invalidDiceIds.size > 0 || Boolean(scriptConflict) || scriptBusyAction === 'save'} type="button" onClick={() => void saveSelectedScript()}>
              <Save size={16} aria-hidden="true" />
              {scriptBusyAction === 'save' ? '保存中' : '保存'}
            </button>
          </header>
          {selectedScript && (
            <nav className="editor-nav" aria-label="剧本编辑页">
              {(Object.keys(scriptEditorViewLabel) as ScriptEditorView[]).map((view) => (
                <button
                  className={editorView === view ? 'active' : ''}
                  key={view}
                  type="button"
                  onClick={() => setEditorView(view)}
                >
                  {view === 'overview' && <Settings size={15} aria-hidden="true" />}
                  {view === 'maps' && <Map size={15} aria-hidden="true" />}
                  {view === 'characters' && <Activity size={15} aria-hidden="true" />}
                  {view === 'dice' && <Dice5 size={15} aria-hidden="true" />}
                  {view === 'chapters' && <ListTree size={15} aria-hidden="true" />}
                  {scriptEditorViewLabel[view]}
                </button>
              ))}
            </nav>
          )}
          {scriptConflict && selectedScript && (
            <div className="script-conflict-panel" role="alert">
              <div>
                <strong>服务器版本已更新</strong>
                <span>本地草稿已保留。可以重新加载服务器版本，或把当前草稿另存为副本。</span>
              </div>
              <button disabled={Boolean(scriptBusyAction)} type="button" onClick={reloadServerScriptVersion}>
                重新加载服务器版本
              </button>
              <button disabled={Boolean(scriptBusyAction)} type="button" onClick={() => void saveConflictDraftAsCopy()}>
                另存为副本
              </button>
            </div>
          )}
          <div className="editor-body">
            {editorContent()}
            {status && <p className="status-line">{status}</p>}
          </div>
        </section>
      </section>
    </div>
  )
}

function AccountPage({
  account,
  friends,
  onAccept,
  onRemove,
  onRequest,
  onSignOut,
  onUpdate,
}: {
  account: Account
  friends: FriendSummary[]
  onAccept: (friendId: string) => Promise<void>
  onRemove: (friendId: string) => Promise<void>
  onRequest: (email: string) => Promise<void>
  onSignOut: () => void
  onUpdate: (input: { displayName?: string; avatar?: string; password?: string; currentPassword?: string }) => Promise<void>
}) {
  const [activeTab, setActiveTab] = useState<AccountTab>('friends')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [displayName, setDisplayName] = useState(account.displayName)
  const [avatar, setAvatar] = useState(account.avatar)
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [status, setStatus] = useState('')
  const [avatarBusy, setAvatarBusy] = useState(false)
  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) {
      return
    }
    if (!isPotentialAvatarImage(file)) {
      setStatus('请选择常见图片文件，支持 PNG / JPG / WebP。')
      return
    }
    if (file.size > avatarSourceMaxBytes) {
      setStatus('头像图片不能超过 8MB。')
      return
    }
    setAvatarBusy(true)
    try {
      setAvatar(await makeAvatarUrl(file))
      setStatus('头像已载入，保存后生效。')
    } catch {
      setStatus('头像处理失败，请换一张图片。')
    } finally {
      setAvatarBusy(false)
    }
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p>账号中心</p>
          <h1>账户</h1>
        </div>
        <button className="icon-button" title="账户设置" type="button" onClick={() => setSettingsOpen((value) => !value)}>
          <Settings size={18} aria-hidden="true" />
        </button>
      </header>
      <section className="panel profile-panel account-overview">
        <div className="profile-card">
          <AvatarView className="large-avatar" name={account.displayName} value={account.avatar} />
          <div>
            <strong>{account.displayName}</strong>
            <span>{account.email}</span>
          </div>
          <button
            className="icon-button account-signout"
            title="退出登录"
            type="button"
            onClick={() => {
              if (window.confirm('确认退出当前账号？')) {
                onSignOut()
              }
            }}
          >
            <LogOut size={17} aria-hidden="true" />
          </button>
        </div>
        {settingsOpen && (
        <div className="form-grid padded">
          <label className="field">
            <span>用户名</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <div className="field">
            <span>头像图片</span>
            <div className="file-picker">
              <label className={`file-picker-trigger${avatarBusy ? ' disabled' : ''}`}>
                <Upload size={16} aria-hidden="true" />
                选择图片
                <input
                  accept="image/png,image/jpeg,image/webp"
                  className="file-input-hidden"
                  disabled={avatarBusy}
                  type="file"
                  onChange={(event) => {
                    void handleAvatarFile(event.target.files?.[0])
                    event.target.value = ''
                  }}
                />
              </label>
              <small>{avatarBusy ? '处理中' : 'PNG / JPG / WebP'}</small>
            </div>
          </div>
          <label className="field">
            <span>当前密码</span>
            <div className="password-row">
              <input
                autoComplete="current-password"
                placeholder="修改密码时必填"
                type={showCurrentPassword ? 'text' : 'password'}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
              <button
                type="button"
                title={showCurrentPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowCurrentPassword((value) => !value)}
              >
                {showCurrentPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
          </label>
          <label className="field">
            <span>新密码</span>
            <div className="password-row">
              <input
                placeholder="不修改可留空"
                type={showNewPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                title={showNewPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowNewPassword((value) => !value)}
              >
                {showNewPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
          </label>
          {status && <p className="status-line">{status}</p>}
          <div className="profile-actions">
            <button
              className="primary-action"
              disabled={avatarBusy}
              type="button"
              onClick={async () => {
                if (password && !currentPassword) {
                  setStatus('修改密码需要输入当前密码。')
                  return
                }

                try {
                  await onUpdate({
                    displayName,
                    avatar,
                    password: password || undefined,
                    currentPassword: password ? currentPassword : undefined,
                  })
                  setCurrentPassword('')
                  setPassword('')
                  setStatus('已保存')
                } catch (error) {
                  const apiError = asApiError(error)
                  setStatus(
                    apiError.message === 'Current password is incorrect'
                      ? '当前密码不正确。'
                      : '保存失败，请检查输入后重试。',
                  )
                }
              }}
            >
              {avatarBusy ? <ImageIcon size={17} aria-hidden="true" /> : <Save size={17} aria-hidden="true" />}
              {avatarBusy ? '处理头像' : '保存设置'}
            </button>
          </div>
        </div>
        )}
      </section>
      <nav className="account-tabs" aria-label="账户二级菜单">
        <button className={activeTab === 'friends' ? 'active' : ''} type="button" onClick={() => setActiveTab('friends')}>
          <Users size={17} aria-hidden="true" />
          好友管理
        </button>
      </nav>
      {activeTab === 'friends' && (
        <FriendManagement friends={friends} onAccept={onAccept} onRemove={onRemove} onRequest={onRequest} />
      )}
    </div>
  )
}

function RoomInviteButton({
  friends,
  onInviteFriend,
}: {
  friends: FriendSummary[]
  onInviteFriend: (friendId: string) => Promise<void>
}) {
  const accepted = friends.filter((friend) => friend.direction === 'friend')
  const [open, setOpen] = useState(false)
  const [friendId, setFriendId] = useState('')
  const [status, setStatus] = useState('')

  useNativeBackHandler(() => {
    if (!open) {
      return false
    }
    setOpen(false)
    return true
  }, 70)

  return (
    <div className="room-invite">
      <button className="icon-button" title="邀请好友" type="button" onClick={() => setOpen((value) => !value)}>
        <UserPlus size={18} aria-hidden="true" />
      </button>
      {open && (
        <div className="room-invite-menu">
          <label className="field">
            <span>邀请好友</span>
            <select value={friendId} onChange={(event) => setFriendId(event.target.value)}>
              <option value="">选择好友</option>
              {accepted.map((friend) => (
                <option key={friend.id} value={friend.id}>
                  {friend.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary-action"
            disabled={!friendId}
            type="button"
            onClick={async () => {
              try {
                await onInviteFriend(friendId)
                setStatus('已邀请')
                setOpen(false)
              } catch {
                setStatus('邀请失败')
              }
            }}
          >
            邀请
          </button>
          {status && <p className="status-line">{status}</p>}
        </div>
      )}
    </div>
  )
}

function RoomPage(props: {
  account: Account
  audioPlaybackBlocked: boolean
  boardStyle?: CSSProperties
  chatDraft: string
  confirmedRoomMessage: ConfirmedRoomMessageSignal | null
  currentRoomRole: UserRole
  diceFormula: string
  friends: FriendSummary[]
  handleBoardClick: (event: PointerEvent<HTMLDivElement>) => void
  handleSignOut: () => void
  handleVitalsChange: (character: Character, hp: number, sanity: number) => Promise<void>
  handleVoicePrimary: () => Promise<void>
  lastRoll: string
  noiseSuppression: boolean
  onBack: () => void
  onDisconnectVoice: () => void
  onCloseRoom: () => Promise<void>
  onRollDice: (formula?: string, options?: { replyToId?: string; diceId?: string }) => Promise<boolean>
  onSendMessage: (options?: { replyToId?: string }) => Promise<boolean>
  onSetChatDraft: (value: string) => void
  onSetDiceFormula: (value: string) => void
  onSetNoiseSuppression: (value: boolean) => void
  onSetRoomTab: (value: RoomTab) => void
  onSetSelectedTokenId: (value: string) => void
  onSetVoiceVolume: (id: string, volume: number) => void
  onStartAudioPlayback: () => Promise<void>
  onReturnRoomVoice: () => Promise<void>
  onInviteFriend: (friendId: string) => Promise<void>
  onRoomUpdated: (room: RoomState) => void
  roomMessageToasts: RoomMessageToast[]
  room: RoomState | null
  roomChatStatus: string
  roomDiceCooldownSeconds: number
  roomMessageCooldownSeconds: number
  roomTab: RoomTab
  roomVoiceReturnAvailable: boolean
  sessionToken: string
  selectedCharacter: Character | null
  selectedToken: MapToken | null
  selectedTokenId: string
  updateToken: (token: MapToken, x: number, y: number) => void
  voiceMuted: boolean
  voiceNote: string
  voiceStatus: VoiceStatus
  voiceVolumes: Record<string, number>
}) {
  const { room, roomTab } = props
  const [membersOpen, setMembersOpen] = useState(false)
  const membersMenuRef = useRef<HTMLDivElement | null>(null)

  useNativeBackHandler(() => {
    if (!membersOpen) {
      return false
    }
    setMembersOpen(false)
    return true
  }, 70)

  useEffect(() => {
    if (!membersOpen) {
      return
    }
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target
      if (target instanceof Node && membersMenuRef.current?.contains(target)) {
        return
      }
      setMembersOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer)
    }
  }, [membersOpen])

  if (!room) {
    return (
      <LoadingPanel
        actionLabel="返回大厅"
        message="房间数据仍在同步，或当前房间已关闭/删除。"
        onAction={props.onBack}
        title="正在载入房间"
      />
    )
  }
  const preparationPhase = room.phase !== 'playing' && room.phase !== 'closed'
  const playingPhase = room.phase === 'playing'
  const activeRoomTab = roomTab === 'flow' && room.phase === 'closed' ? 'map' : roomTab
  const canInviteFriends = room.visibility === 'public' || room.ownerId === props.account.id
  const canCloseRoom = room.online && room.ownerId === props.account.id

  return (
    <main className={`room-shell room-tab-${activeRoomTab}`}>
      <header className="room-header">
        <button className="icon-button" type="button" onClick={props.onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div className="room-title-block">
          <p>{room.system} / {room.visibility === 'private' ? '私密房' : '公开房'} / {roomPhaseLabel[room.phase]}</p>
          <h1>{room.name}</h1>
        </div>
        <div className="room-header-actions">
          <span className="room-role-pill">{roleLabel[props.currentRoomRole]}</span>
          <button className="voice-status-button" type="button" onClick={() => props.onSetRoomTab('voice')}>
            <AudioLines size={17} aria-hidden="true" />
            <span>{props.voiceStatus === 'connected' ? '语音已连' : '语音'}</span>
          </button>
          <div className="room-members-menu" ref={membersMenuRef}>
            <button className="icon-button" title="查看玩家" type="button" onClick={() => setMembersOpen((value) => !value)}>
              <Users size={17} aria-hidden="true" />
            </button>
            {membersOpen && (
              <div className="room-members-popover">
                <strong>已加入玩家</strong>
                {room.members.length === 0 ? (
                  <p className="muted">暂无在线玩家。</p>
                ) : (
                  room.members.map((member) => (
                    <article key={member.accountId}>
                      <AvatarView name={member.displayName} value={member.avatar} />
                      <span>
                        <strong>{member.displayName}</strong>
                        <small>{roleLabel[member.role]} / {formatClock(member.lastSeenAt)}</small>
                      </span>
                    </article>
                  ))
                )}
              </div>
            )}
          </div>
          {canInviteFriends && (
            <RoomInviteButton friends={props.friends} onInviteFriend={props.onInviteFriend} />
          )}
          {canCloseRoom && (
            <button className="icon-button room-close-button" title="关闭房间" type="button" onClick={() => void props.onCloseRoom()}>
              <DoorOpen size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <section className="room-content">
        {preparationPhase && activeRoomTab === 'flow' ? (
          <RoomFlowTab {...props} room={room} />
        ) : playingPhase && activeRoomTab === 'flow' ? (
          <RoomHostTab {...props} room={room} />
        ) : (
          <>
            {activeRoomTab === 'map' && <MapTab {...props} room={room} />}
            {activeRoomTab === 'chat' && <ChatTab {...props} room={room} />}
            {activeRoomTab === 'characters' && <CharactersTab {...props} room={room} />}
            {activeRoomTab === 'voice' && <VoiceTab {...props} room={room} />}
          </>
        )}
      </section>
      {activeRoomTab !== 'chat' && <RoomMessageToasts messages={props.roomMessageToasts} />}

      <nav className={room.phase === 'closed' ? 'room-tabs closed' : 'room-tabs'} aria-label="房间内导航">
        {room.phase !== 'closed' && (
          <button
            aria-label={playingPhase ? (room.ownerId === props.account.id ? '主持' : '剧情') : '流程'}
            title={playingPhase ? (room.ownerId === props.account.id ? '主持' : '剧情') : '流程'}
            className={activeRoomTab === 'flow' ? 'active' : ''}
            type="button"
            onClick={() => props.onSetRoomTab('flow')}
          >
            <ListTree size={19} aria-hidden="true" />
            {playingPhase ? (room.ownerId === props.account.id ? '主持' : '剧情') : '流程'}
          </button>
        )}
        <button aria-label="地图" title="地图" className={activeRoomTab === 'map' ? 'active' : ''} type="button" onClick={() => props.onSetRoomTab('map')}>
          <Map size={19} aria-hidden="true" />
          地图
        </button>
        <button aria-label="聊天" title="聊天" className={activeRoomTab === 'chat' ? 'active' : ''} type="button" onClick={() => props.onSetRoomTab('chat')}>
          <MessageCircle size={19} aria-hidden="true" />
          聊天
        </button>
        <button aria-label="角色" title="角色" className={activeRoomTab === 'characters' ? 'active' : ''} type="button" onClick={() => props.onSetRoomTab('characters')}>
          <Activity size={19} aria-hidden="true" />
          角色
        </button>
        <button aria-label="语音" title="语音" className={activeRoomTab === 'voice' ? 'active' : ''} type="button" onClick={() => props.onSetRoomTab('voice')}>
          <AudioLines size={19} aria-hidden="true" />
          语音
        </button>
      </nav>
    </main>
  )
}

function RoomFlowTab(props: Parameters<typeof RoomPage>[0] & { room: RoomState }) {
  const { account, room, sessionToken } = props
  const canManageFlow = room.ownerId === account.id
  const mySheet = room.characterSheets.find((sheet) => sheet.ownerId === account.id) ?? null
  const draftSourceKey = [
    account.id,
    mySheet?.id ?? 'new',
    mySheet?.status ?? 'draft',
    mySheet?.confirmedAt ?? '',
    mySheet?.updatedAt ?? '',
    room.scriptCharacters[0]?.id ?? '',
  ].join(':')
  const preparationSourceKey = [
    room.id,
    room.summary ?? '',
    ...room.scriptCharacters.map((character) =>
      [
        character.id,
        character.name,
        character.count,
        character.parameters,
        character.story,
        character.occupation ?? '',
        character.publicSummary ?? '',
        character.privateBrief ?? '',
        formatRecommendedSkills(character),
      ].join('\u0001'),
    ),
  ].join('\u0002')
  const createDraft = useCallback(
    () => buildDraftSheet(account, mySheet, room.scriptCharacters[0]?.id),
    [account, mySheet, room.scriptCharacters],
  )
  const createPrepDraft = useCallback(() => buildPreparationDraft(room), [room])
  const [draft, setDraft] = useKeyedState<CharacterSheet>(draftSourceKey, createDraft)
  const [prepDraft, setPrepDraft] = useKeyedState<RoomPreparationDraft>(
    preparationSourceKey,
    createPrepDraft,
  )
  const [status, setStatus] = useState('')
  const [flowBusyAction, setFlowBusyAction] = useState('')
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({})
  const recruitedPlayers = (room.roster ?? []).filter((member) => member.accountId !== room.ownerId)
  const recruitedPlayerIds = new Set(recruitedPlayers.map((member) => member.accountId))
  const recruitedSheets = room.characterSheets.filter((sheet) => recruitedPlayerIds.has(sheet.ownerId))
  const historicalSheets = room.characterSheets.filter((sheet) => !recruitedPlayerIds.has(sheet.ownerId))
  const isRosterPlayer = recruitedPlayerIds.has(account.id)
  const approvedCount = recruitedSheets.filter((sheet) => sheet.status === 'approved').length
  const confirmedCount = recruitedSheets.filter((sheet) => sheet.status === 'approved' && sheet.confirmedAt).length
  const submittedCount = recruitedSheets.filter((sheet) => sheet.status === 'submitted').length
  const recruitedPlayersNotSubmitted = recruitedPlayers.filter((member) => {
    const sheet = room.characterSheets.find((item) => item.ownerId === member.accountId)
    return !sheet || sheet.status === 'draft' || sheet.status === 'rejected'
  })
  const recruitedPlayersNotApproved = recruitedPlayers.filter(
    (member) => room.characterSheets.find((item) => item.ownerId === member.accountId)?.status !== 'approved',
  )
  const recruitedPlayersNotConfirmed = recruitedPlayers.filter((member) => {
    const sheet = room.characterSheets.find((item) => item.ownerId === member.accountId)
    return sheet?.status !== 'approved' || !sheet.confirmedAt
  })
  const recruitedPlayersApprovedNotConfirmed = recruitedPlayers.filter((member) => {
    const sheet = room.characterSheets.find((item) => item.ownerId === member.accountId)
    return sheet?.status === 'approved' && !sheet.confirmedAt
  })
  const recruitingBlocker = recruitedPlayers.length === 0 ? '还不能进入车卡：至少需要 1 名玩家加入名单。' : ''
  const canEnterReview = submittedCount > 0 && recruitedPlayersNotSubmitted.length === 0
  const canEnterCasting = confirmedCount > 0 && submittedCount === 0 && recruitedPlayersNotConfirmed.length === 0
  const formatMemberNames = (members: typeof recruitedPlayers) =>
    members.map((member) => member.displayName || member.accountId || '未命名玩家').join('、')
  const reviewBlocker =
    submittedCount === 0
      ? '还不能进入集中审核：至少需要 1 张已提交角色卡。'
      : recruitedPlayersNotSubmitted.length > 0
        ? `还不能进入集中审核：以下玩家未提交或需修改：${formatMemberNames(recruitedPlayersNotSubmitted)}。`
        : ''
  const castingBlocker =
    submittedCount > 0
      ? '还不能进入选角导入：仍有待审核角色卡。'
      : approvedCount === 0
        ? '还不能进入选角导入：至少需要 1 张已通过角色卡。'
        : recruitedPlayersNotConfirmed.length > 0
          ? `还不能进入选角导入：以下玩家还没有确认已通过角色卡：${formatMemberNames(recruitedPlayersNotConfirmed)}。`
          : ''
  const playingBlocker =
    submittedCount > 0
      ? '还不能开团：仍有待审核角色卡。'
      : approvedCount === 0
        ? '还不能开团：至少需要 1 张已通过角色卡。'
        : recruitedPlayersNotConfirmed.length > 0
          ? `还不能开团：以下玩家还没有确认已通过角色卡：${formatMemberNames(recruitedPlayersNotConfirmed)}。`
          : ''
  const savedPreparationIssues = roomPreparationIssues(room.summary ?? '', room.scriptCharacters)
  const draftPreparationIssues = roomPreparationIssues(prepDraft.summary, prepDraft.scriptCharacters)
  const savedPreparationBlocker = savedPreparationIssues.length > 0
    ? `还不能招募：${savedPreparationIssues.join('；')}。`
    : ''
  const currentFlowBlocker =
    room.phase === 'module_locked' || room.phase === 'module_editing'
      ? savedPreparationBlocker
      : room.phase === 'chargen'
      ? reviewBlocker
      : room.phase === 'review'
        ? castingBlocker
        : room.phase === 'casting'
          ? playingBlocker
          : ''
  const flowBusy = Boolean(flowBusyAction)
  const flowBusyRef = useRef(false)
  const selectedScriptCharacter = draft.scriptCharacterId
    ? room.scriptCharacters.find((character) => character.id === draft.scriptCharacterId) ?? null
    : null
  const selectedScriptCharacterAvailability = selectedScriptCharacter
    ? scriptCharacterAvailability(room, selectedScriptCharacter, draft.id)
    : null
  const selectedScriptCharacterFull = Boolean(selectedScriptCharacterAvailability?.full)
  const sheetValidation = useMemo(() => validateClientCharacterSheet(draft), [draft])
  const sheetLocked =
    flowBusy ||
    room.phase === 'casting' ||
    mySheet?.status === 'submitted' ||
    mySheet?.status === 'approved'
  const sheetLockReason = flowBusy
    ? '正在处理流程操作，暂不能编辑。'
    : mySheet?.status === 'submitted'
      ? '角色卡已提交，等待 KP 审核；如需修改请等待 KP 驳回。'
      : mySheet?.status === 'approved' && room.phase === 'casting'
        ? '角色卡已通过，等待 KP 导入角色属性。'
        : mySheet?.status === 'approved'
          ? '角色卡已通过，进入导入阶段前不可修改。'
          : room.phase === 'casting'
            ? 'KP 正在导入角色，暂不能修改角色卡。'
            : ''
  const sheetSubmitBlocker = selectedScriptCharacterFull
    ? '此人设名额已满，不能提交；请选择其他人设或原创调查员。'
    : !sheetValidation.ok
      ? '请先修正车卡预检问题。'
      : sheetLockReason

  const runFlowAction = async (action: string, task: () => Promise<void>) => {
    if (flowBusyRef.current) {
      return
    }
    flowBusyRef.current = true
    setFlowBusyAction(action)
    setStatus('')
    try {
      await task()
    } catch (error) {
      setStatus(`${action}失败：${describeError(error, '请检查网络或当前流程权限')}`)
    } finally {
      flowBusyRef.current = false
      setFlowBusyAction('')
    }
  }

  const patchPreparationCharacter = (characterId: string, patch: Partial<ScriptCharacter>) => {
    setPrepDraft((current) => ({
      ...current,
      scriptCharacters: current.scriptCharacters.map((character) =>
        character.id === characterId ? { ...character, ...patch } : character,
      ),
    }))
  }

  const addPreparationCharacter = () => {
    setPrepDraft((current) => ({
      ...current,
      scriptCharacters: [
        ...current.scriptCharacters,
        {
          id: buildId('script-character'),
          name: '新角色人设',
          count: 1,
          parameters: '',
          story: '',
          occupation: '',
          publicSummary: '',
          privateBrief: '',
          recommendedSkills: [],
        },
      ],
    }))
  }

  const removePreparationCharacter = (characterId: string) => {
    setPrepDraft((current) => ({
      ...current,
      scriptCharacters: current.scriptCharacters.filter((character) => character.id !== characterId),
    }))
  }

  const patchDraft = (patch: Partial<CharacterSheet>) => {
    setDraft((current) => buildDraftSheet(account, { ...current, ...patch }))
  }

  const patchAttributes = (key: keyof Coc7Attributes, value: number) => {
    setDraft((current) => {
      const attributes = { ...current.attributes, [key]: value }
      return buildDraftSheet(account, { ...current, attributes })
    })
  }

  const patchSkill = (key: string, field: 'occupation' | 'interest', value: number) => {
    setDraft((current) => ({
      ...current,
      skills: current.skills.map((skill) =>
        skill.key === key ? { ...skill, [field]: Math.max(0, Number.isFinite(value) ? value : 0) } : skill,
      ),
    }))
  }

  const setPhase = async (phase: RoomPhase) => {
    await runFlowAction(`进入「${roomPhaseLabel[phase]}」`, async () => {
      const nextRoom = await updateRoomPhase(sessionToken, room.id, phase)
      props.onRoomUpdated(nextRoom)
      setStatus(`已进入「${roomPhaseLabel[phase]}」`)
    })
  }

  const savePreparation = async () => {
    await runFlowAction('保存模组设定', async () => {
      const savedRoom = await updateRoomPreparation(sessionToken, room.id, prepDraft)
      props.onRoomUpdated(savedRoom)
      setPrepDraft(buildPreparationDraft(savedRoom))
      setStatus('模组剧情与角色人设已保存')
    })
  }

  const savePreparationAndRecruit = async () => {
    await runFlowAction('保存设定并招募PL', async () => {
      const savedRoom = await updateRoomPreparation(sessionToken, room.id, prepDraft)
      const nextRoom = await updateRoomPhase(sessionToken, savedRoom.id, 'recruiting')
      props.onRoomUpdated(nextRoom)
      setPrepDraft(buildPreparationDraft(nextRoom))
      setStatus('已保存设定并进入招募PL')
    })
  }

  const saveDraft = async () => {
    await runFlowAction('保存角色卡', async () => {
      const result = await saveCharacterSheet(sessionToken, room.id, draft)
      props.onRoomUpdated(result.room)
      setDraft(result.sheet)
      setStatus(result.validation.ok ? '角色卡草稿已保存' : result.validation.errors.join('；'))
    })
  }

  const submitDraft = async () => {
    if (!sheetValidation.ok) {
      setStatus(`角色卡预检未通过：${sheetValidation.errors.join('；')}`)
      return
    }
    await runFlowAction('提交角色卡', async () => {
      const result = await submitCharacterSheet(sessionToken, room.id, draft)
      props.onRoomUpdated(result.room)
      setDraft(result.sheet)
      setStatus(result.validation.ok ? '角色卡已提交给KP审核' : result.validation.errors.join('；'))
    })
  }

  const confirmDraft = async () => {
    await runFlowAction('确认角色卡', async () => {
      const result = await confirmCharacterSheet(sessionToken, room.id)
      props.onRoomUpdated(result.room)
      setDraft(result.sheet)
      setStatus('已确认使用此角色，等待 KP 进入选角导入')
    })
  }

  const reviewSheet = async (sheet: CharacterSheet, nextStatus: 'approved' | 'rejected') => {
    await runFlowAction(nextStatus === 'approved' ? '通过角色卡' : '驳回角色卡', async () => {
      const result = await reviewCharacterSheet(sessionToken, room.id, sheet.id, {
        status: nextStatus,
        reviewerNotes: reviewNotes[sheet.id] ?? '',
      })
      props.onRoomUpdated(result.room)
      setStatus(nextStatus === 'approved' && result.validation.ok ? '角色卡已通过' : result.validation.errors.join('；') || '已驳回角色卡')
    })
  }

  const importSheets = async () => {
    await runFlowAction('导入角色并开团', async () => {
      const nextRoom = await importApprovedCharacterSheets(sessionToken, room.id)
      props.onRoomUpdated(nextRoom)
      props.onSetRoomTab('flow')
      setStatus('已导入角色属性并进入跑团')
    })
  }

  return (
    <section className="panel full-panel room-flow-panel">
      <header className="panel-title">
        <BookOpen size={18} aria-hidden="true" />
        <h2>跑团流程</h2>
      </header>
      <div className="flow-steps">
        {flowPhaseOrder.map((phase) => {
          const phaseIndex = flowPhaseOrder.indexOf(phase)
          const currentIndex = flowPhaseOrder.indexOf(room.phase)
          const stepState = phase === room.phase ? 'active' : phaseIndex < currentIndex ? 'done' : 'future'
          return (
            <span
              aria-label={`流程阶段：${roomPhaseLabel[phase]}，${stepState === 'active' ? '当前阶段' : stepState === 'done' ? '已完成' : '未开始'}`}
              className={stepState}
              key={phase}
              title={stepState === 'future' ? '流程按顺序推进，满足条件后由 KP 进入下一阶段。' : undefined}
            >
              {roomPhaseLabel[phase]}
            </span>
          )
        })}
      </div>

      <div className="flow-layout">
        <section className="flow-main">
          {(room.phase === 'module_locked' || room.phase === 'module_editing' || room.phase === 'recruiting') && (
            <div className="flow-section">
              <h3>{room.scriptId ? '已关联模组' : '未关联剧本，按空白团准备'}</h3>
              <p>{room.summary || 'KP可以先确认模组、人设与公开背景，再开始招募玩家。'}</p>
              {room.phase === 'module_editing' && canManageFlow && (
                <RoomPreparationEditor
                  busy={flowBusy}
                  draft={prepDraft}
                  onAddCharacter={addPreparationCharacter}
                  onPatchCharacter={patchPreparationCharacter}
                  onPatchSummary={(summary) => setPrepDraft((current) => ({ ...current, summary }))}
                  onRemoveCharacter={removePreparationCharacter}
                  readinessIssues={draftPreparationIssues}
                  onSave={savePreparation}
                  onSaveAndRecruit={savePreparationAndRecruit}
                />
              )}
              <div className="script-role-list">
                {room.scriptCharacters.length === 0 ? (
                  <p className="empty-state">暂无预设角色。PL车卡时可以创建原创调查员。</p>
                ) : (
                  room.scriptCharacters.map((character) => (
                    <article key={character.id}>
                      {(() => {
                        const availability = scriptCharacterAvailability(room, character, mySheet?.id)
                        return (
                          <>
                            <strong>{character.name}</strong>
                            <span>
                              {character.occupation || '职业待定'} / 已选 {availability.used} / {availability.total}
                            </span>
                          </>
                        )
                      })()}
                      <p>{scriptCharacterBrief(character)}</p>
                    </article>
                  ))
                )}
              </div>
              {canManageFlow && (
                <div className="flow-actions">
                  {room.phase === 'module_locked' && (
                    <>
                      <button disabled={flowBusy} type="button" onClick={() => void setPhase('module_editing')}>修改人设剧情</button>
                      <button
                        aria-describedby={savedPreparationBlocker ? 'module-recruit-blocker' : undefined}
                        disabled={flowBusy || savedPreparationIssues.length > 0}
                        className="primary-action"
                        title={savedPreparationBlocker || undefined}
                        type="button"
                        onClick={() => void setPhase('recruiting')}
                      >
                        确认模组并招募
                      </button>
                      {savedPreparationBlocker && <p className="flow-blocker inline" id="module-recruit-blocker">{savedPreparationBlocker}</p>}
                    </>
                  )}
                  {room.phase === 'recruiting' && (
                    <>
                      <button
                        aria-describedby={recruitingBlocker ? 'recruiting-chargen-blocker' : undefined}
                        disabled={flowBusy || Boolean(recruitingBlocker)}
                        className="primary-action"
                        title={recruitingBlocker || undefined}
                        type="button"
                        onClick={() => void setPhase('chargen')}
                      >
                        关闭报名，进入车卡
                      </button>
                      {recruitingBlocker && <p className="flow-blocker warning inline" id="recruiting-chargen-blocker">{recruitingBlocker}</p>}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {(room.phase === 'chargen' || room.phase === 'review' || room.phase === 'casting') && !canManageFlow && isRosterPlayer && (
            <CharacterSheetEditor
              draft={draft}
              disabled={sheetLocked}
              lockReason={sheetLockReason}
              confirmDisabled={flowBusy || room.phase !== 'review'}
              selectedScriptCharacter={selectedScriptCharacter}
              selectedScriptCharacterAvailability={selectedScriptCharacterAvailability}
              submitDisabled={sheetLocked || selectedScriptCharacterFull || !sheetValidation.ok}
              submitBlocker={sheetSubmitBlocker}
              validation={sheetValidation}
              onConfirm={confirmDraft}
              onPatchAttributes={patchAttributes}
              onPatchDraft={patchDraft}
              onPatchSkill={patchSkill}
              onSave={saveDraft}
              onSubmit={submitDraft}
              room={room}
            />
          )}

          {(room.phase === 'chargen' || room.phase === 'review' || room.phase === 'casting') && !canManageFlow && !isRosterPlayer && (
            <div className="flow-section">
              <h3>旁观访问</h3>
              <p>你可以查看房间内容与参与聊天，但当前不在本团玩家名单中，不能提交或确认角色卡。</p>
            </div>
          )}

          {(room.phase === 'chargen' || room.phase === 'review' || room.phase === 'casting') && canManageFlow && (
            <div className="flow-section">
              <h3>KP审核台</h3>
              <p>通过前先看职业点、兴趣点、信用评级与背景说明；非本职技能投入需要在背景里写 `[skill:技能名]`。</p>
              <div className="sheet-review-list">
                {recruitedSheets.length === 0 ? (
                  <p className="empty-state">还没有玩家提交角色卡。</p>
                ) : (
                  recruitedSheets.map((sheet) => (
                    <article key={sheet.id}>
                      <header>
                        <strong>{sheet.name}</strong>
                      <span>{sheet.ownerName} / {sheet.occupation} / {characterSheetFlowLabel(sheet)}</span>
                      </header>
                      <p>{sheet.background.description || '未填写背景'}</p>
                      <small>
                        职业点 {occupationUsed(sheet)} / 兴趣点 {interestUsed(sheet)} / HP {sheet.derived.hp} / SAN {sheet.derived.san}
                      </small>
                      {sheet.status === 'submitted' ? (
                        <>
                          <textarea
                            disabled={flowBusy || room.phase !== 'review'}
                            placeholder="审核备注，驳回时说明需要修改的点"
                            rows={2}
                            value={reviewNotes[sheet.id] ?? sheet.reviewerNotes ?? ''}
                            onChange={(event) => setReviewNotes((current) => ({ ...current, [sheet.id]: event.target.value }))}
                          />
                          <div className="flow-actions">
                            <button disabled={flowBusy || room.phase !== 'review'} type="button" onClick={() => void reviewSheet(sheet, 'rejected')}>驳回</button>
                            <button disabled={flowBusy || room.phase !== 'review'} className="primary-action" type="button" onClick={() => void reviewSheet(sheet, 'approved')}>通过</button>
                          </div>
                        </>
                      ) : (
                        <p className="status-line">
                          {sheet.status === 'approved'
                            ? sheet.confirmedAt ? '此角色卡已通过且玩家已确认。' : '此角色卡已通过，等待玩家确认。'
                            : sheet.status === 'rejected'
                              ? sheet.reviewerNotes || '已驳回，等待玩家修改后重新提交。'
                              : '草稿尚未提交，KP暂不能审核。'}
                        </p>
                      )}
                    </article>
                  ))
                )}
              </div>
              {historicalSheets.length > 0 && (
                <details className="history-sheet-list">
                  <summary>历史角色卡 {historicalSheets.length}</summary>
                  <div className="sheet-review-list">
                    {historicalSheets.map((sheet) => (
                      <article key={sheet.id}>
                        <header>
                          <strong>{sheet.name}</strong>
                          <span>{sheet.ownerName} / {sheet.occupation} / 历史卡 / {characterSheetFlowLabel(sheet)}</span>
                        </header>
                        <p>{sheet.background.description || '未填写背景'}</p>
                        <p className="status-line">此角色卡不属于当前玩家名单，只保留历史记录，不能在当前流程中审核或导入。</p>
                      </article>
                    ))}
                  </div>
                </details>
              )}
              <div className="flow-actions">
                {room.phase === 'chargen' && (
                  <>
                    {reviewBlocker && <p className="flow-blocker warning">{reviewBlocker}</p>}
                    <button disabled={flowBusy || !canEnterReview} type="button" onClick={() => void setPhase('review')}>
                      进入集中审核
                    </button>
                  </>
                )}
                {room.phase === 'review' && (
                  <>
                    {castingBlocker && <p className="flow-blocker warning">{castingBlocker}</p>}
                    <button disabled={flowBusy || !canEnterCasting} type="button" onClick={() => void setPhase('casting')}>
                      进入选角导入
                    </button>
                  </>
                )}
                {room.phase === 'casting' && (
                  <>
                    {playingBlocker && <p className="flow-blocker warning">{playingBlocker}</p>}
                    <button disabled={flowBusy || !canEnterCasting} className="primary-action" type="button" onClick={() => void importSheets()}>
                      导入角色并开团
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        <aside className="flow-side">
          <strong>{roomPhaseLabel[room.phase]}</strong>
          <span>在线 {room.members.length} / 名单 {recruitedPlayers.length} / 待审核 {submittedCount} / 已通过 {approvedCount} / 已确认 {confirmedCount}</span>
          {recruitedPlayersNotSubmitted.length > 0 && <p>未提交：{recruitedPlayersNotSubmitted.map((member) => member.displayName).join('、')}</p>}
          {room.phase !== 'chargen' && recruitedPlayersNotApproved.length > 0 && <p>未通过：{recruitedPlayersNotApproved.map((member) => member.displayName).join('、')}</p>}
          {recruitedPlayersApprovedNotConfirmed.length > 0 && room.phase !== 'chargen' && <p>待确认：{recruitedPlayersApprovedNotConfirmed.map((member) => member.displayName).join('、')}</p>}
          {mySheet && <p>我的角色卡：{characterSheetFlowLabel(mySheet)}{mySheet.reviewerNotes ? `，${mySheet.reviewerNotes}` : ''}</p>}
          {currentFlowBlocker && <p className="flow-blocker">{currentFlowBlocker}</p>}
          {flowBusyAction && <p className="status-line">正在处理：{flowBusyAction}</p>}
          {status && <p className="status-line">{status}</p>}
        </aside>
      </div>
    </section>
  )
}

function RoomPreparationEditor({
  busy,
  draft,
  onAddCharacter,
  onPatchCharacter,
  onPatchSummary,
  onRemoveCharacter,
  readinessIssues,
  onSave,
  onSaveAndRecruit,
}: {
  busy: boolean
  draft: RoomPreparationDraft
  onAddCharacter: () => void
  onPatchCharacter: (characterId: string, patch: Partial<ScriptCharacter>) => void
  onPatchSummary: (summary: string) => void
  onRemoveCharacter: (characterId: string) => void
  readinessIssues: string[]
  onSave: () => Promise<void>
  onSaveAndRecruit: () => Promise<void>
}) {
  return (
    <div className="module-prep-editor">
      <label className="field wide">
        <span>公开剧情</span>
        <textarea
          disabled={busy}
          rows={4}
          value={draft.summary}
          onChange={(event) => onPatchSummary(event.target.value)}
          placeholder="写给玩家看的开场前提、调查目标、禁忌事项和招募说明"
        />
      </label>
      <div className="module-prep-heading">
        <strong>角色人设</strong>
        <button disabled={busy} type="button" onClick={onAddCharacter}>
          <CirclePlus size={16} aria-hidden="true" />
          新增
        </button>
      </div>
      <div className="module-prep-list">
        {draft.scriptCharacters.map((character) => (
          <article key={character.id}>
            <header>
              <input
                disabled={busy}
                value={character.name}
                onChange={(event) => onPatchCharacter(character.id, { name: event.target.value })}
                placeholder="角色人设名称"
              />
              <input
                disabled={busy}
                min={1}
                type="number"
                value={character.count}
                onChange={(event) => onPatchCharacter(character.id, { count: Number(event.target.value) })}
                title="可用人数"
              />
              <button disabled={busy} className="icon-button" type="button" onClick={() => onRemoveCharacter(character.id)} title="删除人设">
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </header>
            <div className="editor-page-grid">
              <label className="field">
                <span>推荐职业</span>
                <input
                  disabled={busy}
                  value={character.occupation ?? ''}
                  onChange={(event) => onPatchCharacter(character.id, { occupation: event.target.value })}
                  placeholder="记者、医生、私家侦探..."
                />
              </label>
              <label className="field">
                <span>推荐技能</span>
                <textarea
                  disabled={busy}
                  rows={2}
                  value={formatRecommendedSkills(character)}
                  onChange={(event) => onPatchCharacter(character.id, { recommendedSkills: parseRecommendedSkills(event.target.value) })}
                  placeholder="侦查:50&#10;图书馆使用:60"
                />
              </label>
            </div>
            <label className="field wide">
              <span>公开人设</span>
              <textarea
                disabled={busy}
                rows={3}
                value={character.publicSummary ?? ''}
                onChange={(event) => onPatchCharacter(character.id, { publicSummary: event.target.value })}
                placeholder="玩家招募与选角时能看到的人设摘要"
              />
            </label>
            <label className="field wide">
              <span>剧情与背景</span>
              <textarea
                disabled={busy}
                rows={4}
                value={character.story}
                onChange={(event) => onPatchCharacter(character.id, { story: event.target.value })}
                placeholder="和模组有关的背景、关系、动机与可公开剧情"
              />
            </label>
            <label className="field wide">
              <span>KP私密备注</span>
              <textarea
                disabled={busy}
                rows={3}
                value={character.privateBrief ?? ''}
                onChange={(event) => onPatchCharacter(character.id, { privateBrief: event.target.value })}
                placeholder="只给KP参考的秘密、反转、隐藏动机或审核提醒"
              />
            </label>
            <label className="field wide">
              <span>人物参数</span>
              <textarea
                disabled={busy}
                rows={3}
                value={character.parameters}
                onChange={(event) => onPatchCharacter(character.id, { parameters: event.target.value })}
                placeholder="HP 10 / SAN 50 / 侦查 60 / 信用评级 30"
              />
            </label>
          </article>
        ))}
      </div>
      {readinessIssues.length > 0 && (
        <p className="flow-blocker">招募前还需要：{readinessIssues.join('；')}。</p>
      )}
      <div className="flow-actions">
        <button disabled={busy} type="button" onClick={() => void onSave()}>
          <Save size={16} aria-hidden="true" />
          保存设定
        </button>
        <button disabled={busy || readinessIssues.length > 0} className="primary-action" type="button" onClick={() => void onSaveAndRecruit()}>
          保存并招募PL
        </button>
      </div>
    </div>
  )
}

function CharacterSheetEditor({
  draft,
  disabled,
  lockReason,
  confirmDisabled,
  onPatchAttributes,
  onPatchDraft,
  onPatchSkill,
  onConfirm,
  onSave,
  onSubmit,
  room,
  selectedScriptCharacter,
  selectedScriptCharacterAvailability,
  submitDisabled,
  submitBlocker,
  validation,
}: {
  draft: CharacterSheet
  disabled: boolean
  lockReason?: string
  confirmDisabled: boolean
  onPatchAttributes: (key: keyof Coc7Attributes, value: number) => void
  onPatchDraft: (patch: Partial<CharacterSheet>) => void
  onPatchSkill: (key: string, field: 'occupation' | 'interest', value: number) => void
  onConfirm: () => Promise<void>
  onSave: () => Promise<void>
  onSubmit: () => Promise<void>
  room: RoomState
  selectedScriptCharacter: ScriptCharacter | null
  selectedScriptCharacterAvailability: { used: number; total: number; full: boolean } | null
  submitDisabled: boolean
  submitBlocker?: string
  validation: ClientCharacterSheetValidation
}) {
  return (
    <div className="flow-section sheet-editor">
      <h3>PL车卡</h3>
      {lockReason && <p className="sheet-lock-note">{lockReason}</p>}
      {draft.status === 'approved' && !draft.confirmedAt && (
        <div className="sheet-confirm-panel" role="status">
          <div>
            <strong>KP 已通过此角色卡</strong>
            <span>确认后，KP 才能把你的属性导入骰娘并进入开团流程。</span>
          </div>
          <button className="primary-action" disabled={confirmDisabled} type="button" onClick={() => void onConfirm()}>
            确认使用此角色
          </button>
        </div>
      )}
      <div className="editor-page-grid">
        <label className="field">
          <span>选择人设</span>
          <select
            disabled={disabled}
            value={draft.scriptCharacterId ?? ''}
            onChange={(event) => {
              const scriptCharacterId = event.target.value || undefined
              const scriptCharacter = room.scriptCharacters.find((character) => character.id === scriptCharacterId)
              onPatchDraft({
                scriptCharacterId,
                occupation: scriptCharacter?.occupation || draft.occupation,
                background: scriptCharacter && !draft.background.description.trim()
                  ? { ...draft.background, description: scriptCharacterBrief(scriptCharacter) }
                  : draft.background,
              })
            }}
          >
            <option value="">原创调查员</option>
            {room.scriptCharacters.map((character) => {
              const availability = scriptCharacterAvailability(room, character, draft.id)
              return (
                <option disabled={availability.full && draft.scriptCharacterId !== character.id} key={character.id} value={character.id}>
                  {character.name} ({availability.used}/{availability.total})
                </option>
              )
            })}
          </select>
        </label>
        <label className="field">
          <span>姓名</span>
          <input disabled={disabled} value={draft.name} onChange={(event) => onPatchDraft({ name: event.target.value })} />
        </label>
        <label className="field">
          <span>职业</span>
          <select disabled={disabled} value={draft.occupation} onChange={(event) => onPatchDraft({ occupation: event.target.value })}>
            {coc7OccupationOptions.map((occupation) => <option key={occupation}>{occupation}</option>)}
          </select>
        </label>
        <label className="field">
          <span>年龄</span>
          <input disabled={disabled} max={90} min={15} type="number" value={draft.age} onChange={(event) => onPatchDraft({ age: Number(event.target.value) })} />
        </label>
        <label className="field">
          <span>性别</span>
          <input disabled={disabled} value={draft.sex} onChange={(event) => onPatchDraft({ sex: event.target.value })} />
        </label>
        <label className="field">
          <span>居住地</span>
          <input disabled={disabled} value={draft.residence} onChange={(event) => onPatchDraft({ residence: event.target.value })} />
        </label>
      </div>
      {selectedScriptCharacter && selectedScriptCharacterAvailability && (
        <div className={selectedScriptCharacterAvailability.full ? 'script-character-help warning' : 'script-character-help'}>
          <strong>{selectedScriptCharacter.name}</strong>
          <span>
            已选 {selectedScriptCharacterAvailability.used} / {selectedScriptCharacterAvailability.total}
            {selectedScriptCharacter.occupation ? ` / 推荐职业 ${selectedScriptCharacter.occupation}` : ''}
          </span>
          {scriptCharacterBrief(selectedScriptCharacter) && <p>{scriptCharacterBrief(selectedScriptCharacter)}</p>}
          {(selectedScriptCharacter.recommendedSkills ?? []).length > 0 && (
            <small>
              推荐技能：{selectedScriptCharacter.recommendedSkills?.map((skill) => `${skill.name}${skill.base}`).join('、')}
            </small>
          )}
          {selectedScriptCharacterAvailability.full && <em>此人设名额已满，不能提交为该人设。</em>}
        </div>
      )}
      <div className={validation.ok ? 'sheet-validation ready' : 'sheet-validation warning'} role="status">
        <header>
          <strong>车卡预检</strong>
          <span>
            职业点 {occupationUsed(draft)} / {validation.occupationPool}，兴趣点 {interestUsed(draft)} / {validation.interestPool}，信用评级 {validation.creditMin}-{validation.creditMax}
          </span>
        </header>
        {validation.ok ? (
          <p>点数、职业范围和背景说明已满足提交条件。</p>
        ) : (
          <ul>
            {validation.errors.slice(0, 5).map((error) => (
              <li key={error}>{error}</li>
            ))}
            {validation.errors.length > 5 && <li>还有 {validation.errors.length - 5} 项问题，请继续修正。</li>}
          </ul>
        )}
      </div>
      <div className="attribute-grid">
        {coc7AttributeLabels.map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <input disabled={disabled} max={90} min={key === 'siz' ? 40 : 15} type="number" value={draft.attributes[key]} onChange={(event) => onPatchAttributes(key, Number(event.target.value))} />
          </label>
        ))}
      </div>
      <div className="skill-table">
        <header>
          <span>技能</span>
          <span>基础</span>
          <span>职业</span>
          <span>兴趣</span>
          <span>合计</span>
        </header>
        {draft.skills.map((skill) => (
          <div key={skill.key}>
            <span>{skill.name}</span>
            <span>{skill.base}</span>
            <input disabled={disabled} min={0} type="number" value={skill.occupation} onChange={(event) => onPatchSkill(skill.key, 'occupation', Number(event.target.value))} />
            <input disabled={disabled} min={0} type="number" value={skill.interest} onChange={(event) => onPatchSkill(skill.key, 'interest', Number(event.target.value))} />
            <strong>{skill.base + skill.occupation + skill.interest + skill.growth}</strong>
          </div>
        ))}
      </div>
      <label className="field wide">
        <span>背景说明</span>
        <textarea
          disabled={disabled}
          rows={4}
          value={draft.background.description}
          onChange={(event) => onPatchDraft({ background: { ...draft.background, description: event.target.value } })}
          placeholder="说明角色动机、与模组人设的关系；非本职技能可写 [skill:侦查] 这类来源标签。"
        />
      </label>
      {submitBlocker && <p className="sheet-lock-note warning">{submitBlocker}</p>}
      {draft.status === 'approved' && !draft.confirmedAt && (
        <p className="sheet-lock-note warning">KP 已通过此角色卡。确认后才会进入选角导入，确认前如需修改请联系 KP 驳回。</p>
      )}
      {draft.status === 'approved' && draft.confirmedAt && (
        <p className="sheet-lock-note">已确认使用此角色，等待 KP 导入角色属性。</p>
      )}
      <div className="flow-actions">
        <span>职业点 {occupationUsed(draft)} / {validation.occupationPool}，兴趣点 {interestUsed(draft)} / {validation.interestPool}，HP {draft.derived.hp}，SAN {draft.derived.san}</span>
        <button disabled={disabled} type="button" onClick={() => void onSave()}>保存草稿</button>
        <button className="primary-action" disabled={submitDisabled} type="button" onClick={() => void onSubmit()}>提交KP审核</button>
        {draft.status === 'approved' && !draft.confirmedAt && (
          <button className="primary-action" disabled={confirmDisabled} type="button" onClick={() => void onConfirm()}>确认使用此角色</button>
        )}
      </div>
    </div>
  )
}

function scriptBlockSummary(block: ScriptBlock, script: TrpgScript | null) {
  if (block.type === 'narrative') {
    return block.markdown || '空剧情段落'
  }
  if (block.type === 'map') {
    const map = script?.maps.find((item) => item.id === block.mapId)
    return [map?.name, block.notes || map?.notes].filter(Boolean).join(' / ') || '切换到指定地图'
  }
  if (block.type === 'character') {
    const character = script?.characters.find((item) => item.id === block.characterId)
    return [character?.name, block.notes || character?.publicSummary].filter(Boolean).join(' / ') || '公开角色信息'
  }
  const dice = script?.diceProfiles.find((item) => item.id === block.diceId)
  return `${dice?.label ?? '骰子'} / 难度 ${block.difficulty}`
}

function RoomPublicStoryPanel({ room }: { room: RoomState }) {
  const contents = room.publicContent ?? []
  return (
    <section className="public-story-panel" aria-label="已公开剧情">
      <header>
        <div>
          <strong>已公开剧情</strong>
          <span>{room.scene.name}</span>
        </div>
        <small>{contents.length} 条</small>
      </header>
      <div className="public-story-feed">
        {contents.length === 0 ? (
          <p className="empty-state">KP 还没有公开剧情、线索或判定。</p>
        ) : (
          contents.map((item) => (
            <article className={`public-story-item ${item.type}`} key={item.id}>
              <header>
                <span>{scriptBlockTypeLabel[item.type]}</span>
                <time>{formatClock(item.createdAt)}</time>
              </header>
              <strong>{item.title}</strong>
              <p>{item.markdown}</p>
            </article>
          ))
        )}
      </div>
    </section>
  )
}

function RoomHostTab(props: Parameters<typeof RoomPage>[0] & { room: RoomState }) {
  const { account, room, sessionToken } = props
  const canManage = room.ownerId === account.id
  const [loadedScript, setLoadedScript] = useState<TrpgScript | null>(null)
  const [selectedChapterId, setSelectedChapterId] = useState(room.progress.currentChapterId ?? '')
  const [busyAction, setBusyAction] = useState('')
  const [status, setStatus] = useState('')
  const script = canManage ? room.scriptSnapshot ?? loadedScript : null
  const selectedChapter = script?.chapters.find((chapter) => chapter.id === selectedChapterId) ?? script?.chapters[0] ?? null

  useEffect(() => {
    if (!canManage || !room.scriptId) {
      return
    }
    if (room.scriptSnapshot) {
      return
    }
    let disposed = false
    void loadScript(room.scriptId, sessionToken)
      .then((loadedScript) => {
        if (disposed) {
          return
        }
        setLoadedScript(loadedScript)
        setSelectedChapterId((current) => current || room.progress.currentChapterId || loadedScript.chapters[0]?.id || '')
        setStatus('')
      })
      .catch(() => {
        if (!disposed) {
          setStatus('主持剧本加载失败，请检查网络后重试。')
          setLoadedScript(null)
        }
      })
    return () => {
      disposed = true
    }
  }, [canManage, room.id, room.scriptId, room.scriptSnapshot, room.progress.currentChapterId, sessionToken])

  const isBlockPublished = (block: ScriptBlock) =>
    room.publicContent.some((item) => item.source?.chapterId === selectedChapter?.id && item.source?.blockId === block.id)

  const revealBlock = async (block: ScriptBlock) => {
    if (!selectedChapter) {
      return
    }
    setBusyAction(`reveal:${block.id}`)
    setStatus('')
    try {
      const nextRoom = await revealRoomScriptBlock(sessionToken, room.id, {
        chapterId: selectedChapter.id,
        blockId: block.id,
      })
      props.onRoomUpdated(nextRoom)
      setStatus(block.type === 'map' ? '已切换场景并公开给玩家。' : '已公开给玩家。')
    } catch (error) {
      setStatus(describeError(error, '公开失败，请检查网络后重试。'))
    } finally {
      setBusyAction('')
    }
  }

  const switchMap = async (map: ScriptMap) => {
    setBusyAction(`map:${map.id}`)
    setStatus('')
    try {
      const nextRoom = await switchRoomScriptMap(sessionToken, room.id, map.id)
      props.onRoomUpdated(nextRoom)
      setStatus(`已切换到「${map.name}」。`)
    } catch (error) {
      setStatus(describeError(error, '切换地图失败，请检查网络后重试。'))
    } finally {
      setBusyAction('')
    }
  }

  if (!canManage) {
    return (
      <section className="panel full-panel room-host-panel">
        <header className="panel-title">
          <BookOpen size={18} aria-hidden="true" />
          <h2>公开剧情</h2>
        </header>
        <RoomPublicStoryPanel room={room} />
      </section>
    )
  }

  return (
    <section className="panel full-panel room-host-panel">
      <header className="panel-title">
        <BookOpen size={18} aria-hidden="true" />
        <h2>KP主持台</h2>
      </header>
      {!room.scriptId ? (
        <p className="empty-state">这个房间没有关联剧本。KP 仍可使用地图、聊天和角色页手动推进。</p>
      ) : (
        <div className="host-runner-layout">
          <aside className="host-chapter-list">
            <strong>章节</strong>
            {script?.chapters.length ? (
              script.chapters.map((chapter) => (
                <button
                  className={chapter.id === selectedChapter?.id ? 'active' : ''}
                  key={chapter.id}
                  type="button"
                  onClick={() => setSelectedChapterId(chapter.id)}
                >
                  <span>{chapter.title}</span>
                  <small>{chapter.blocks.length} 项</small>
                </button>
              ))
            ) : (
              <p className="muted">{script ? '剧本还没有章节。' : '正在加载章节。'}</p>
            )}
            {script?.maps.length ? (
              <div className="host-map-list">
                <strong>地图</strong>
                {script.maps.map((map) => (
                  <button
                    className={room.scene.mapId === map.id ? 'active' : ''}
                    disabled={Boolean(busyAction)}
                    key={map.id}
                    type="button"
                    onClick={() => void switchMap(map)}
                  >
                    <Map size={15} aria-hidden="true" />
                    <span>{map.name}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </aside>
          <section className="host-block-list">
            <header>
              <div>
                <strong>{selectedChapter?.title ?? '未选择章节'}</strong>
                <span>{room.progress.currentBlockId ? '当前位置已保存' : '选择内容公开给玩家'}</span>
              </div>
              <small>{room.scene.name}</small>
            </header>
            {selectedChapter?.blocks.length ? (
              selectedChapter.blocks.map((block) => {
                const published = isBlockPublished(block)
                const current = room.progress.currentBlockId === block.id
                return (
                  <article className={current ? 'current' : ''} key={block.id}>
                    <div className="host-block-main">
                      <header>
                        <span>{scriptBlockTypeLabel[block.type]}</span>
                        {published && <small>已公开</small>}
                        {current && <small>当前位置</small>}
                      </header>
                      <strong>{block.title || scriptBlockTypeLabel[block.type]}</strong>
                      <p>{scriptBlockSummary(block, script)}</p>
                    </div>
                    <button disabled={Boolean(busyAction)} type="button" onClick={() => void revealBlock(block)}>
                      {block.type === 'map'
                        ? <Map size={15} aria-hidden="true" />
                        : block.type === 'check'
                          ? <Dice5 size={15} aria-hidden="true" />
                          : <Check size={15} aria-hidden="true" />}
                      {published ? '更新公开' : block.type === 'map' ? '切换并公开' : '公开'}
                    </button>
                  </article>
                )
              })
            ) : (
              <p className="empty-state">当前章节还没有可执行内容。</p>
            )}
          </section>
          <RoomPublicStoryPanel room={room} />
        </div>
      )}
      {status && <p className="status-line">{status}</p>}
    </section>
  )
}

function MapTab(props: Parameters<typeof RoomPage>[0] & { room: RoomState }) {
  const { room, selectedToken, selectedCharacter } = props
  const estimatedVoiceKbps = estimateOpusRoomKbps(room.players)

  return (
    <div className="room-grid map-grid">
      <section className="board-wrap">
        <div className="board-toolbar">
          <div>
            <Map size={18} aria-hidden="true" />
            <strong>{room.scene.name}</strong>
          </div>
          <span>点击地图移动选中棋子</span>
        </div>
        <div className="battle-board" onPointerDown={props.handleBoardClick} style={props.boardStyle}>
          {room.scene.features.map((feature) => (
            <div
              className={`map-feature ${feature.type}`}
              key={feature.id}
              style={{
                gridColumn: `${feature.x} / span ${feature.w}`,
                gridRow: `${feature.y} / span ${feature.h}`,
              }}
            >
              {feature.type === 'door' && <DoorOpen size={15} aria-hidden="true" />}
              {feature.type === 'hazard' && <ShieldAlert size={15} aria-hidden="true" />}
              <span>{feature.label}</span>
            </div>
          ))}
          {room.scene.tokens.map((token) => (
            <button
              className={token.id === props.selectedTokenId ? 'token selected' : 'token'}
              key={token.id}
              style={{
                gridColumn: token.x,
                gridRow: token.y,
                background: token.color,
              }}
              title={`选择 ${token.label}`}
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                props.onSetSelectedTokenId(token.id)
              }}
            >
              {token.label}
            </button>
          ))}
        </div>
      </section>
      <aside className="panel token-panel">
        <header className="panel-title">
          <Move size={18} aria-hidden="true" />
          <h2>棋子控制</h2>
        </header>
        {selectedToken && selectedCharacter ? (
          <div className="token-control">
            <AvatarView name={selectedCharacter.name} value={selectedCharacter.avatar} />
            <div className="token-control-main">
              <strong>{selectedCharacter.name}</strong>
              <span>
                {selectedCharacter.player} / 先攻 {selectedCharacter.initiative}
              </span>
            </div>
            <div className="token-vitals">
              <span>
                HP <strong>{selectedCharacter.hp}</strong>/{selectedCharacter.maxHp}
              </span>
              <span>
                SAN <strong>{selectedCharacter.sanity}</strong>/{selectedCharacter.maxSanity}
              </span>
            </div>
            <div className="stepper">
              <button type="button" title="左移" onClick={() => props.updateToken(selectedToken, selectedToken.x - 1, selectedToken.y)}>
                ←
              </button>
              <button type="button" title="上移" onClick={() => props.updateToken(selectedToken, selectedToken.x, selectedToken.y - 1)}>
                ↑
              </button>
              <button type="button" title="下移" onClick={() => props.updateToken(selectedToken, selectedToken.x, selectedToken.y + 1)}>
                ↓
              </button>
              <button type="button" title="右移" onClick={() => props.updateToken(selectedToken, selectedToken.x + 1, selectedToken.y)}>
                →
              </button>
            </div>
            <div className="quick-vitals">
              <button type="button" onClick={() => props.handleVitalsChange(selectedCharacter, selectedCharacter.hp - 1, selectedCharacter.sanity)}>
                HP -1
              </button>
              <button type="button" onClick={() => props.handleVitalsChange(selectedCharacter, selectedCharacter.hp + 1, selectedCharacter.sanity)}>
                HP +1
              </button>
              <button type="button" onClick={() => props.handleVitalsChange(selectedCharacter, selectedCharacter.hp, selectedCharacter.sanity - 1)}>
                SAN -1
              </button>
              <button type="button" onClick={() => props.handleVitalsChange(selectedCharacter, selectedCharacter.hp, selectedCharacter.sanity + 1)}>
                SAN +1
              </button>
            </div>
            <p className="muted">
              <Radio size={14} aria-hidden="true" />
              {estimatedVoiceKbps} kbps 语音估算
            </p>
          </div>
        ) : (
          <p className="empty-state">请选择一个棋子。</p>
        )}
      </aside>
    </div>
  )
}

function RoomMessageToasts({ messages }: { messages: RoomMessageToast[] }) {
  if (messages.length === 0) {
    return null
  }

  return (
    <div className="room-message-toasts">
      {messages.map((message) => (
        <article key={message.toastId}>
          <strong>{message.author}</strong>
          <p>{message.text}</p>
        </article>
      ))}
    </div>
  )
}

function ChatTab(props: Parameters<typeof RoomPage>[0] & { room: RoomState }) {
  const { room } = props
  const roomDiceProfiles = room.diceProfiles ?? []
  const [messagePage, setMessagePage] = useState(() => ({
    roomId: room.id,
    messages: room.messages.slice(-20),
    hasMore: room.messages.length >= 20,
  }))
  const [selectedMessageId, setSelectedMessageId] = useState('')
  const [replyTarget, setReplyTarget] = useState<ChatMessage['replyTo'] | null>(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [inlineStatus, setInlineStatus] = useState('')
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [sendingRoomMessage, setSendingRoomMessage] = useState(false)
  const [rollingRoomDice, setRollingRoomDice] = useState(false)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)
  const sendingRoomMessageRef = useRef(false)
  const rollingRoomDiceRef = useRef(false)
  const stickToBottomRef = useRef(true)
  const preserveScrollRef = useRef<{ top: number; height: number } | null>(null)
  const pendingRevealMessageIdRef = useRef('')
  const scrollModeRef = useRef<'bottom' | 'preserve' | 'none'>('bottom')
  const roomMessageKeyRef = useRef(room.id)
  const pagedMessages = messagePage.roomId === room.id ? messagePage.messages : room.messages.slice(-20)
  const visibleMessages = useMemo(() => mergeRoomMessageList(pagedMessages, room.messages), [pagedMessages, room.messages])
  const oldestVisibleMessageId = visibleMessages[0]?.id ?? ''
  const oldestPagedMessageId = pagedMessages[0]?.id ?? ''
  const roomMessageCooldownActive = props.roomMessageCooldownSeconds > 0
  const roomDiceCooldownActive = props.roomDiceCooldownSeconds > 0
  const roomChatStatusText = roomMessageCooldownActive
    ? `发送过于频繁，请 ${props.roomMessageCooldownSeconds} 秒后再试。`
    : props.roomChatStatus || inlineStatus
  const lastRollText = roomDiceCooldownActive
    ? `掷骰过于频繁，请 ${props.roomDiceCooldownSeconds} 秒后再试。`
    : props.lastRoll
  const hasMoreMessages =
    messagePage.roomId === room.id &&
    messagePage.hasMore &&
    (room.messages.length >= roomStateMessageLimit || !oldestVisibleMessageId || oldestVisibleMessageId === oldestPagedMessageId)
  const messageIds = useMemo(() => new Set(visibleMessages.map((message) => message.id)), [visibleMessages])
  const selectedMessage = selectedMessageId && messageIds.has(selectedMessageId) ? visibleMessages.find((message) => message.id === selectedMessageId) ?? null : null
  const activeReplyTarget = replyTarget && messageIds.has(replyTarget.id) ? replyTarget : null

  useNativeBackHandler(() => {
    if (selectedMessageId) {
      setSelectedMessageId('')
      return true
    }
    if (replyTarget) {
      setReplyTarget(null)
      return true
    }
    return false
  }, 60)

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartRef.current = null
  }

  useEffect(() => clearLongPress, [])

  useEffect(() => {
    roomMessageKeyRef.current = room.id
    pendingRevealMessageIdRef.current = ''
  }, [room.id])

  const updateScrollBottomState = useCallback(() => {
    const list = messageListRef.current
    if (!list) {
      return
    }
    const awayFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight > 96
    stickToBottomRef.current = !awayFromBottom
    setShowScrollBottom(awayFromBottom)
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const list = messageListRef.current
    if (!list) {
      return
    }
    preserveScrollRef.current = null
    scrollModeRef.current = 'bottom'
    list.scrollTo({ top: list.scrollHeight, behavior })
    stickToBottomRef.current = true
    setShowScrollBottom(false)
  }, [])

  const revealVisibleMessage = useCallback((messageId: string, behavior: ScrollBehavior = 'smooth') => {
    const list = messageListRef.current
    const selector = `[data-message-id="${escapeAttributeValue(messageId)}"]`
    const element = list?.querySelector<HTMLElement>(selector)
    if (!element) {
      return false
    }
    element.scrollIntoView({ block: 'center', behavior })
    stickToBottomRef.current = false
    setSelectedMessageId(messageId)
    setShowScrollBottom(true)
    setInlineStatus('')
    return true
  }, [])

  const loadOlderMessages = useCallback(
    async (targetMessageId?: string) => {
      if (!hasMoreMessages || loadingOlderMessages || visibleMessages.length === 0) {
        return false
      }
      const list = messageListRef.current
      if (list) {
        preserveScrollRef.current = { top: list.scrollTop, height: list.scrollHeight }
        scrollModeRef.current = 'preserve'
      }
      setLoadingOlderMessages(true)
      try {
        const requestRoomId = room.id
        const page = await loadRoomMessages(props.sessionToken, room.id, {
          limit: 20,
          before: visibleMessages[0].id,
        })
        if (roomMessageKeyRef.current !== requestRoomId) {
          return false
        }
        const olderMessages = page.messages ?? []
        if (olderMessages.length === 0) {
          preserveScrollRef.current = null
          scrollModeRef.current = 'none'
        }
        setMessagePage((current) => {
          const currentMessages = current.roomId === requestRoomId ? current.messages : []
          return {
            roomId: requestRoomId,
            messages: mergeRoomMessageList(currentMessages, olderMessages),
            hasMore: page.hasMore,
          }
        })
        setInlineStatus('')
        return Boolean(targetMessageId && olderMessages.some((message) => message.id === targetMessageId))
      } catch {
        preserveScrollRef.current = null
        scrollModeRef.current = 'none'
        setInlineStatus('更早的团内记录加载失败。')
        return false
      } finally {
        setLoadingOlderMessages(false)
      }
    },
    [hasMoreMessages, loadingOlderMessages, props.sessionToken, room.id, visibleMessages],
  )

  const loadUntilMessageVisible = useCallback(
    async (targetMessageId: string) => {
      if (!hasMoreMessages || loadingOlderMessages || visibleMessages.length === 0) {
        return false
      }
      const list = messageListRef.current
      if (list) {
        preserveScrollRef.current = { top: list.scrollTop, height: list.scrollHeight }
        scrollModeRef.current = 'preserve'
      }
      setLoadingOlderMessages(true)
      try {
        const requestRoomId = room.id
        let before = visibleMessages[0]?.id
        let hasMore: boolean = hasMoreMessages
        let found = false
        let accumulatedMessages: ChatMessage[] = []
        for (let pageIndex = 0; pageIndex < 10 && hasMore && before; pageIndex += 1) {
          const page = await loadRoomMessages(props.sessionToken, requestRoomId, {
            limit: 20,
            before,
          })
          if (roomMessageKeyRef.current !== requestRoomId) {
            return false
          }
          const olderMessages = page.messages ?? []
          if (olderMessages.length === 0) {
            hasMore = false
            break
          }
          accumulatedMessages = mergeRoomMessageList(accumulatedMessages, olderMessages)
          found = found || olderMessages.some((message) => message.id === targetMessageId)
          before = olderMessages[0]?.id
          hasMore = Boolean(page.hasMore)
          if (found) {
            break
          }
        }
        setMessagePage((current) => {
          const currentMessages = current.roomId === requestRoomId ? current.messages : []
          return {
            roomId: requestRoomId,
            messages: mergeRoomMessageList(currentMessages, accumulatedMessages),
            hasMore,
          }
        })
        setInlineStatus(found ? '' : hasMore ? '原消息还在更早记录中，请再次点击继续定位。' : '原消息已不在当前聊天记录中。')
        return found
      } catch {
        preserveScrollRef.current = null
        scrollModeRef.current = 'none'
        setInlineStatus('加载原消息失败，请检查网络后重试。')
        return false
      } finally {
        setLoadingOlderMessages(false)
      }
    },
    [hasMoreMessages, loadingOlderMessages, props.sessionToken, room.id, visibleMessages],
  )

  const scrollToMessage = useCallback((messageId: string) => {
    if (!messageIds.has(messageId)) {
      if (hasMoreMessages) {
        void loadUntilMessageVisible(messageId).then((found) => {
          if (!found) {
            return
          }
          pendingRevealMessageIdRef.current = messageId
          preserveScrollRef.current = null
          scrollModeRef.current = 'none'
          setInlineStatus('正在定位原消息。')
        })
        setInlineStatus('正在加载原消息。')
        return
      }
      setInlineStatus('原消息已不在当前聊天记录中。')
      return
    }
    if (!revealVisibleMessage(messageId)) {
      setInlineStatus('原消息暂不可见，请先加载更早记录。')
    }
  }, [hasMoreMessages, loadUntilMessageVisible, messageIds, revealVisibleMessage])

  useLayoutEffect(() => {
    const list = messageListRef.current
    if (!list) {
      return
    }
    const pendingRevealMessageId = pendingRevealMessageIdRef.current
    if (pendingRevealMessageId) {
      preserveScrollRef.current = null
      scrollModeRef.current = 'none'
      if (revealVisibleMessage(pendingRevealMessageId, 'auto')) {
        pendingRevealMessageIdRef.current = ''
        updateScrollBottomState()
        return
      }
    }
    if (scrollModeRef.current === 'preserve' && preserveScrollRef.current) {
      const previous = preserveScrollRef.current
      list.scrollTop = list.scrollHeight - previous.height + previous.top
      preserveScrollRef.current = null
      scrollModeRef.current = 'none'
      updateScrollBottomState()
      return
    }
    if (stickToBottomRef.current) {
      scrollToBottom('auto')
    } else {
      setShowScrollBottom(true)
    }
  }, [revealVisibleMessage, scrollToBottom, updateScrollBottomState, visibleMessages.length])

  useEffect(() => {
    let disposed = false
    const loadingTimer = window.setTimeout(() => {
      if (!disposed) {
        setLoadingMessages(true)
      }
    }, 0)
    scrollModeRef.current = 'bottom'
    void loadRoomMessages(props.sessionToken, room.id, { limit: 20 })
      .then((page) => {
        if (disposed) {
          return
        }
        setMessagePage({
          roomId: room.id,
          messages: page.messages ?? [],
          hasMore: page.hasMore,
        })
        setInlineStatus('')
      })
      .catch(() => {
        if (!disposed) {
          setInlineStatus('团内记录加载失败。')
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoadingMessages(false)
        }
      })
    return () => {
      disposed = true
      window.clearTimeout(loadingTimer)
    }
  }, [props.sessionToken, room.id])

  useEffect(() => {
    const signal = props.confirmedRoomMessage
    if (!signal || signal.roomId !== room.id) {
      return
    }
    setInlineStatus('')
    if (!signal.replyToId) {
      return
    }
    if (signal.kind === 'chat') {
      setReplyTarget((current) => (current?.id === signal.replyToId ? null : current))
    }
    setSelectedMessageId((current) => (current === signal.replyToId ? '' : current))
  }, [props.confirmedRoomMessage, room.id])

  const startReply = () => {
    if (!selectedMessage) {
      return
    }
    setReplyTarget({
      id: selectedMessage.id,
      author: selectedMessage.author,
      text: selectedMessage.text.slice(0, 160),
    })
    setInlineStatus('')
    setSelectedMessageId('')
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const runRoomDice = async (formula?: string, options: { replyToId?: string; diceId?: string } = {}) => {
    if (rollingRoomDiceRef.current || roomDiceCooldownActive) {
      return false
    }
    rollingRoomDiceRef.current = true
    setRollingRoomDice(true)
    try {
      return await props.onRollDice(formula, options)
    } finally {
      rollingRoomDiceRef.current = false
      setRollingRoomDice(false)
    }
  }

  const rollForSelectedMessage = async () => {
    if (!selectedMessage || rollingRoomDiceRef.current || roomDiceCooldownActive) {
      return
    }
    const succeeded = await runRoomDice(undefined, { replyToId: selectedMessage.id })
    if (succeeded) {
      setInlineStatus('')
      setSelectedMessageId('')
    }
  }

  const submit = async () => {
    if (!props.chatDraft.trim() || sendingRoomMessageRef.current || roomMessageCooldownActive) {
      return
    }
    sendingRoomMessageRef.current = true
    setSendingRoomMessage(true)
    let succeeded: boolean
    try {
      succeeded = await props.onSendMessage(activeReplyTarget ? { replyToId: activeReplyTarget.id } : undefined)
    } finally {
      sendingRoomMessageRef.current = false
      setSendingRoomMessage(false)
    }
    if (succeeded) {
      stickToBottomRef.current = true
      scrollModeRef.current = 'bottom'
      setInlineStatus('')
      setReplyTarget(null)
      setSelectedMessageId('')
      window.setTimeout(() => scrollToBottom(), 0)
    }
  }

  return (
    <section className={roomChatStatusText ? 'panel chat-panel full-panel has-status' : 'panel chat-panel full-panel'}>
      <header className="panel-title">
        <Send size={18} aria-hidden="true" />
        <h2>团内记录</h2>
      </header>
      <div className="dice-panel">
        <div className="dice-row">
          <Dice5 size={18} aria-hidden="true" />
          <input value={props.diceFormula} onChange={(event) => props.onSetDiceFormula(event.target.value)} />
          <button
            type="button"
            disabled={rollingRoomDice || roomDiceCooldownActive}
            title={roomDiceCooldownActive ? `请 ${props.roomDiceCooldownSeconds} 秒后再试` : undefined}
            onClick={() => void runRoomDice()}
          >
            {rollingRoomDice ? '掷骰中' : roomDiceCooldownActive ? `${props.roomDiceCooldownSeconds}s` : '掷骰'}
          </button>
        </div>
        <div className="quick-dice">
          {roomDiceProfiles.map((dice) => (
            <button
              key={dice.id}
              disabled={rollingRoomDice || roomDiceCooldownActive}
              title={`${dice.label}: ${dice.formula}`}
              type="button"
              onClick={() => void runRoomDice(dice.formula, { diceId: dice.id })}
            >
              <span>{dice.label}</span>
              <small>{dice.formula}</small>
            </button>
          ))}
          {quickDice.map((formula) => (
            <button key={formula} disabled={rollingRoomDice || roomDiceCooldownActive} type="button" onClick={() => void runRoomDice(formula)}>
              {formula}
            </button>
          ))}
        </div>
        {lastRollText && <p>{lastRollText}</p>}
      </div>
      <div
        className="messages"
        ref={messageListRef}
        onScroll={updateScrollBottomState}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            setSelectedMessageId('')
          }
        }}
      >
        {hasMoreMessages && (
          <button
            className="load-more-messages"
            disabled={loadingOlderMessages}
            type="button"
            onClick={() => void loadOlderMessages()}
          >
            {loadingOlderMessages ? '加载中' : '加载更早记录'}
          </button>
        )}
        {loadingMessages && visibleMessages.length === 0 && <p className="empty-state">正在加载团内记录。</p>}
        {visibleMessages.map((message, index) => {
          const selected = selectedMessageId === message.id
          return (
            <article
              className={`${message.role}${selected ? ' selected' : ''}`}
              data-message-id={message.id}
              key={message.id}
              onContextMenu={(event) => {
                event.preventDefault()
                setSelectedMessageId(message.id)
              }}
              onClick={() => {
                setSelectedMessageId((current) => (current === message.id ? '' : message.id))
              }}
              onPointerCancel={clearLongPress}
              onPointerDown={(event) => {
                clearLongPress()
                longPressStartRef.current = { x: event.clientX, y: event.clientY }
                longPressTimerRef.current = window.setTimeout(() => {
                  setSelectedMessageId(message.id)
                  longPressTimerRef.current = null
                  longPressStartRef.current = null
                }, 450)
              }}
              onPointerLeave={clearLongPress}
              onPointerMove={(event) => {
                const start = longPressStartRef.current
                if (!start) {
                  return
                }
                if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
                  clearLongPress()
                }
              }}
              onPointerUp={clearLongPress}
            >
              <div className="message-main">
                <header>
                  <span className="message-author-line">
                    <strong>{message.author}</strong>
                    {message.roll?.outcome && (
                      <span className={`roll-badge ${message.roll.outcome}`}>
                        {message.roll.outcome === 'success' ? '成功' : '失败'}
                      </span>
                    )}
                    {message.roll && !message.roll.outcome && <span className="roll-badge neutral">总计 {message.roll.total}</span>}
                  </span>
                </header>
                {message.replyTo && (
                  <button
                    className="message-reply-link"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      scrollToMessage(message.replyTo!.id)
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <span>回复 {message.replyTo.author}</span>
                    <small>{message.replyTo.text}</small>
                  </button>
                )}
                <p>{message.text}</p>
                {selected && (
                  <small>
                    已选中第 {index + 1} 条消息
                  </small>
                )}
              </div>
              <aside className="message-meta">
                <span>{roleLabel[message.role]}</span>
                <time>{formatClock(message.createdAt)}</time>
              </aside>
            </article>
          )
        })}
        {!loadingMessages && visibleMessages.length === 0 && <p className="empty-state">还没有团内记录。</p>}
      </div>
      {showScrollBottom && (
        <button className="scroll-to-bottom" type="button" title="回到最新消息" onClick={() => scrollToBottom()}>
          <ArrowDown size={18} aria-hidden="true" />
        </button>
      )}
      {selectedMessage && (
        <div className="message-action-bar">
          <span>{selectedMessage.author}</span>
          <button type="button" onClick={startReply}>
            <MessageCircle size={15} aria-hidden="true" />
            回复
          </button>
          <button type="button" disabled={rollingRoomDice || roomDiceCooldownActive} onClick={() => void rollForSelectedMessage()}>
            <Dice5 size={15} aria-hidden="true" />
            {rollingRoomDice ? '掷骰中' : roomDiceCooldownActive ? `${props.roomDiceCooldownSeconds}s` : '对此掷骰'}
          </button>
          <button type="button" title="取消选择" onClick={() => setSelectedMessageId('')}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {roomChatStatusText && (
        <p className="room-chat-status">{roomChatStatusText}</p>
      )}
      <form
        className="chat-input"
        onSubmit={async (event) => {
          event.preventDefault()
          await submit()
        }}
      >
        {activeReplyTarget && (
          <div className="reply-composer">
            <button type="button" onClick={() => scrollToMessage(activeReplyTarget.id)}>
              <span>回复 {activeReplyTarget.author}</span>
              <small>{activeReplyTarget.text}</small>
            </button>
            <button type="button" title="取消回复" onClick={() => setReplyTarget(null)}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          disabled={sendingRoomMessage}
          maxLength={2000}
          placeholder="输入行动、台词或判定结果"
          value={props.chatDraft}
          onChange={(event) => props.onSetChatDraft(event.target.value)}
        />
        <button
          type="submit"
          disabled={sendingRoomMessage || roomMessageCooldownActive || !props.chatDraft.trim()}
          title={sendingRoomMessage ? '发送中' : roomMessageCooldownActive ? `请 ${props.roomMessageCooldownSeconds} 秒后再试` : '发送'}
        >
          <Send size={18} aria-hidden="true" />
        </button>
      </form>
    </section>
  )
}

function CharactersTab(props: Parameters<typeof RoomPage>[0] & { room: RoomState }) {
  const { room } = props
  return (
    <section className="panel full-panel">
      <header className="panel-title">
        <Activity size={18} aria-hidden="true" />
        <h2>角色状态</h2>
      </header>
      <div className="character-list">
        {room.characters.map((character) => (
          <article className="character-row" key={character.id}>
            <AvatarView name={character.name} value={character.avatar} />
            <div className="character-main">
              <strong>{character.name}</strong>
              <span>{character.tags.join(' / ')}</span>
              <small>{character.notes}</small>
              {character.statBlock && (
                <div className="character-stat-row">
                  <span>MP {character.statBlock.mp}</span>
                  <span>MOV {character.statBlock.mov}</span>
                  <span>DB {character.statBlock.db}</span>
                </div>
              )}
            </div>
            {character.accountId === props.account.id && character.statBlock && (
              <div className="quick-checks">
                {['侦查', '聆听', '闪避', '图书馆使用', '信用评级'].map((skill) => (
                  <button key={skill} type="button" onClick={() => void props.onRollDice(`.ra ${skill}`)}>
                    {skill}
                  </button>
                ))}
              </div>
            )}
            <label>
              HP
              <input
                max={character.maxHp}
                min={0}
                type="number"
                value={character.hp}
                onChange={(event) =>
                  props.handleVitalsChange(character, Number(event.target.value), character.sanity)
                }
              />
            </label>
            <label>
              SAN
              <input
                max={character.maxSanity}
                min={0}
                type="number"
                value={character.sanity}
                onChange={(event) =>
                  props.handleVitalsChange(character, character.hp, Number(event.target.value))
                }
              />
            </label>
          </article>
        ))}
      </div>
    </section>
  )
}

function VoiceTab(props: Parameters<typeof RoomPage>[0] & { room: RoomState }) {
  const participants = props.room.voice.participants
  const joinedVoice = props.voiceStatus === 'connected' || props.voiceStatus === 'demo'
  return (
    <section className="panel voice-panel full-panel">
      <header className="panel-title">
        <AudioLines size={18} aria-hidden="true" />
        <h2>高清语音</h2>
      </header>
      <div className={`voice-meter ${props.voiceStatus}`}>
        <span />
        <span />
        <span />
        <strong>{props.voiceStatus === 'connected' ? 'LiveKit' : props.voiceStatus === 'demo' ? '频道状态' : '未连接'}</strong>
      </div>
      <div className="voice-settings">
        <label className="toggle-row">
          <input
            checked={props.noiseSuppression}
            type="checkbox"
            onChange={(event) => props.onSetNoiseSuppression(event.target.checked)}
          />
          <span>发言人系统降噪</span>
        </label>
        <p>{props.voiceNote}</p>
      </div>
      <div className="voice-actions">
        <button disabled={props.voiceStatus === 'connecting'} type="button" onClick={() => void props.handleVoicePrimary()}>
          {joinedVoice && !props.voiceMuted ? (
            <MicOff size={17} aria-hidden="true" />
          ) : (
            <Mic size={17} aria-hidden="true" />
          )}
          {joinedVoice
            ? props.voiceMuted
              ? '取消静音'
              : '静音'
            : props.voiceStatus === 'connecting'
              ? '连接中'
              : '加入语音'}
        </button>
        <button type="button" onClick={props.onDisconnectVoice}>
          <MicOff size={17} aria-hidden="true" />
          断开
        </button>
        {props.audioPlaybackBlocked && (
          <button className="voice-audio-recover" type="button" onClick={() => void props.onStartAudioPlayback()}>
            <Volume2 size={17} aria-hidden="true" />
            恢复语音
          </button>
        )}
        {props.roomVoiceReturnAvailable && (
          <button className="voice-return-room" type="button" onClick={() => void props.onReturnRoomVoice()}>
            <Radio size={17} aria-hidden="true" />
            回到房间语音
          </button>
        )}
      </div>
      <div className="voice-list">
        {participants.length === 0 && <p className="empty-state">等待其他玩家加入语音。</p>}
        {participants.map((participant) => {
          const volume = props.voiceVolumes[participant.id] ?? 100
          return (
            <div className={participant.speaking ? 'speaking voice-row' : 'voice-row'} key={participant.id}>
              <div>
                <span>{participant.name}</span>
                <em>{voiceQualityLabel(participant)}</em>
              </div>
              <label className="volume-control">
                {volume === 0 ? <VolumeX size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
                <input
                  max={100}
                  min={0}
                  type="range"
                  value={volume}
                  onChange={(event) => props.onSetVoiceVolume(participant.id, Number(event.target.value))}
                />
                <small>{volume}%</small>
              </label>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default App
