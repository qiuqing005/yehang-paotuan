export type UserRole = 'keeper' | 'player'
export type RoomVisibility = 'public' | 'private'
export type FriendStatus = 'pending' | 'accepted'
export type ScriptVisibility = 'public' | 'private'
export type RoomPhase =
  | 'module_locked'
  | 'module_editing'
  | 'recruiting'
  | 'chargen'
  | 'review'
  | 'casting'
  | 'playing'
  | 'closed'
export type CharacterSheetStatus = 'draft' | 'submitted' | 'approved' | 'rejected'
export type Coc7SuccessLevel = 'critical' | 'extreme' | 'hard' | 'regular' | 'failure' | 'fumble'

export type Account = {
  id: string
  email: string
  displayName: string
  avatar: string
  role: UserRole
  createdAt: string
  lastSeenAt: string
}

export type AuthSession = {
  token: string
  account: Account
}

export type FriendSummary = {
  id: string
  email: string
  displayName: string
  avatar: string
  role: UserRole
  status: FriendStatus
  direction: 'incoming' | 'outgoing' | 'friend'
  lastSeenAt: string
  unreadCount: number
  lastReadAt?: string
  lastReadMessageId?: string
  lastMessage?: DirectMessage
}

export type DirectMessage = {
  id: string
  clientMessageId?: string
  fromId: string
  toId: string
  text: string
  replyTo?: {
    id: string
    author: string
    text: string
  }
  createdAt: string
}

export type DirectMessagePage = {
  messages: DirectMessage[]
  hasMore: boolean
}

export type DirectCallStatus = 'ringing' | 'accepted' | 'rejected' | 'ended'

export type DirectCallEvent = {
  callId: string
  fromId: string
  fromName: string
  fromAvatar: string
  toId: string
  toName: string
  toAvatar: string
  status: DirectCallStatus
  createdAt: string
}

export type RoomMessagePage = {
  messages: ChatMessage[]
  hasMore: boolean
}

export type Character = {
  id: string
  accountId?: string
  sheetId?: string
  scriptCharacterId?: string
  name: string
  player: string
  avatar: string
  hp: number
  maxHp: number
  sanity: number
  maxSanity: number
  initiative: number
  tags: string[]
  notes: string
  statBlock?: RoomCharacterStatBlock
}

export type MapFeature = {
  id: string
  type: 'wall' | 'door' | 'cover' | 'hazard'
  label: string
  x: number
  y: number
  w: number
  h: number
}

export type MapToken = {
  id: string
  characterId: string
  label: string
  color: string
  x: number
  y: number
  status: 'ready' | 'wounded' | 'hidden' | 'npc'
}

export type SceneState = {
  mapId?: string
  name: string
  width: number
  height: number
  features: MapFeature[]
  tokens: MapToken[]
}

export type ChatMessage = {
  id: string
  roomId?: string
  clientMessageId?: string
  senderId?: string
  messageType?: 'chat' | 'dice'
  author: string
  role: UserRole
  text: string
  replyTo?: {
    id: string
    author: string
    text: string
  }
  roll?: DiceRollResult
  createdAt: string
}

export type RoomPublicationType = 'narrative' | 'map' | 'character' | 'check'

export type RoomPublicationSource = {
  scriptId?: string
  scriptVersion?: number
  chapterId?: string
  blockId?: string
  mapId?: string
  characterId?: string
  diceId?: string
}

export type RoomPublicContent = {
  id: string
  type: RoomPublicationType
  title: string
  markdown: string
  source?: RoomPublicationSource
  createdBy: string
  createdByName: string
  createdAt: string
}

export type RoomProgress = {
  scriptId?: string
  scriptVersion?: number
  currentChapterId?: string
  currentBlockId?: string
  currentParagraphIndex?: number
  activeMapId?: string
  updatedBy?: string
  updatedAt?: string
}

export type DiceRollResult = {
  formula: string
  total: number
  rolls: number[]
  modifier: number
  target?: number
  comparator?: '<=' | '>=' | '<' | '>' | '='
  outcome?: 'success' | 'failure'
  successLevel?: Coc7SuccessLevel
  text: string
}

export type DiceRollResponse = {
  message: ChatMessage
  roll: DiceRollResult
}

export type VoiceParticipant = {
  id: string
  name: string
  muted: boolean
  speaking: boolean
  quality: 'excellent' | 'good' | 'relay' | 'offline'
}

export type VoiceStateEvent = {
  roomId: string
  participants: VoiceParticipant[]
}

export type RoomScriptCharacterPreview = {
  id: string
  name: string
  count: number
  occupation?: string
  publicSummary: string
}

export type RoomMember = {
  accountId: string
  displayName: string
  avatar: string
  role: UserRole
  joinedAt: string
  lastSeenAt: string
  leftAt?: string
}

export type RoomSummary = {
  id: string
  name: string
  system: string
  phase: RoomPhase
  visibility: RoomVisibility
  ownerId: string
  ownerName: string
  players: number
  updatedAt: string
  scriptId?: string
  summary: string
  scriptCharacterPreviews: RoomScriptCharacterPreview[]
  online: boolean
  closedAt?: string | null
  closeAt?: string | null
  canJoin: boolean
}

export type RoomState = Omit<RoomSummary, 'canJoin' | 'scriptCharacterPreviews'> & {
  keeper: string
  summary: string
  memberIds: string[]
  members: RoomMember[]
  participantIds: string[]
  participants: RoomMember[]
  rosterIds: string[]
  roster: RoomMember[]
  rosterHistoryIds: string[]
  invitedAccountIds: string[]
  closeAt?: string | null
  scene: SceneState
  scriptSnapshot?: TrpgScript
  scriptCharacters: ScriptCharacter[]
  diceProfiles: DiceProfile[]
  progress: RoomProgress
  publicContent: RoomPublicContent[]
  characterSheets: CharacterSheet[]
  characters: Character[]
  messages: ChatMessage[]
  voice: {
    epoch?: string
    livekitConfigured: boolean
    participants: VoiceParticipant[]
  }
}

export type DiceProfile = {
  id: string
  label: string
  formula: string
  probability: number
}

export type ScriptCharacter = {
  id: string
  name: string
  count: number
  parameters: string
  story: string
  occupation?: string
  publicSummary?: string
  privateBrief?: string
  recommendedSkills?: Array<{ name: string; base: number }>
}

export type Coc7Attributes = {
  str: number
  con: number
  siz: number
  dex: number
  app: number
  int: number
  pow: number
  edu: number
  luck: number
}

export type Coc7Derived = {
  hp: number
  maxHp: number
  mp: number
  maxMp: number
  san: number
  maxSan: number
  mov: number
  db: string
  build: number
}

export type Coc7SkillPoint = {
  key: string
  name: string
  base: number
  occupation: number
  interest: number
  growth: number
}

export type Coc7Background = {
  description: string
  ideology: string
  significantPeople: string
  locations: string
  possessions: string
  traits: string
}

export type CharacterSheet = {
  id: string
  ownerId: string
  ownerName: string
  scriptCharacterId?: string
  status: CharacterSheetStatus
  name: string
  occupation: string
  age: number
  sex: string
  residence: string
  birthplace: string
  attributes: Coc7Attributes
  derived: Coc7Derived
  skills: Coc7SkillPoint[]
  background: Coc7Background
  reviewerNotes?: string
  reviewedAt?: string
  reviewedBy?: string
  confirmedAt?: string
  createdAt: string
  updatedAt: string
}

export type RoomCharacterStatBlock = Coc7Derived & {
  accountId: string
  attributes: Coc7Attributes
  skills: Record<string, number>
  skillNames: Record<string, string>
}

export type ScriptMap = {
  id: string
  name: string
  width: number
  height: number
  notes: string
  features?: MapFeature[]
  tokens?: MapToken[]
}

export type ScriptBlock =
  | { id: string; type: 'narrative'; title: string; markdown: string }
  | { id: string; type: 'map'; title: string; mapId: string; notes: string }
  | { id: string; type: 'character'; title: string; characterId: string; notes: string }
  | {
      id: string
      type: 'check'
      title: string
      diceId: string
      difficulty: number
      onPass: string
      onFail: string
    }

export type ScriptChapter = {
  id: string
  title: string
  blocks: ScriptBlock[]
}

export type TrpgScriptSummary = {
  id: string
  title: string
  system: string
  visibility: ScriptVisibility
  ownerId: string
  ownerName: string
  summary: string
  tags: string[]
  updatedAt: string
  version: number
  canEdit: boolean
}

export type TrpgScript = Omit<TrpgScriptSummary, 'canEdit'> & {
  coverUrl: string
  maps: ScriptMap[]
  characters: ScriptCharacter[]
  diceProfiles: DiceProfile[]
  chapters: ScriptChapter[]
  createdAt: string
}

export type VoiceTokenResponse = {
  configured: boolean
  identity?: string
  roomName?: string
  url?: string
  token?: string
  reason?: string
}
