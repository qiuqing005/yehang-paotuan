import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  Account,
  AuthSession,
  Character,
  CharacterSheet,
  CharacterSheetStatus,
  ChatMessage,
  DirectCallEvent,
  DirectMessage,
  DirectMessagePage,
  DiceProfile,
  FriendStatus,
  FriendSummary,
  MapFeature,
  MapToken,
  RoomMember,
  RoomMessagePage,
  RoomPhase,
  RoomProgress,
  RoomPublicContent,
  RoomState,
  RoomSummary,
  RoomVisibility,
  ScriptBlock,
  ScriptChapter,
  ScriptCharacter,
  ScriptMap,
  ScriptVisibility,
  TrpgScript,
  TrpgScriptSummary,
  UserRole,
  VoiceParticipant,
} from './types.js';
import {
  applySheetStatus,
  buildCharacterSheet,
  coc7SkillDefinitions,
  normalizeCharacterSheet,
  normalizeCoc7SkillKey,
  rollCoc7Check,
  statBlockFromSheet,
  validateCharacterSheet,
} from './coc7.js';

const now = () => new Date().toISOString();
const buildId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const legacyHashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
const hashSessionToken = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const normalizeEmail = (value: string) => value.trim().toLowerCase();

const seedRoomId = 'ember-inn';
const seedScriptId = 'script-ember-inn';
const systemOwnerId = 'system';
const seedDataEnabled =
  process.env.ENABLE_SEED_DATA === 'true' ||
  (process.env.NODE_ENV !== 'production' && process.env.ENABLE_SEED_DATA !== 'false');
const roomPhases: RoomPhase[] = ['module_locked', 'module_editing', 'recruiting', 'chargen', 'review', 'casting', 'playing', 'closed'];
const flowPhaseOrder: RoomPhase[] = ['module_locked', 'module_editing', 'recruiting', 'chargen', 'review', 'casting', 'playing'];
const userRoles: UserRole[] = ['keeper', 'player'];
const allowedRoomPhaseTransitions: Partial<Record<RoomPhase, RoomPhase[]>> = {
  module_locked: ['module_editing', 'recruiting'],
  module_editing: ['recruiting'],
  recruiting: ['chargen'],
  chargen: ['review'],
  review: ['casting'],
  casting: ['playing'],
};

type StoredAccount = Account & {
  passwordHash: string;
  passcodeHash?: string;
  handle?: string;
};

type StoredFriendship = {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: FriendStatus;
  createdAt: string;
  updatedAt: string;
};

type StoredDirectReadState = {
  accountId: string;
  friendId: string;
  lastReadAt: string;
  lastReadMessageId?: string;
};

type DirectCallSessionStatus = 'ringing' | 'accepted' | 'rejected' | 'ended' | 'expired';

type StoredDirectCallSession = {
  callId: string;
  callerId: string;
  calleeId: string;
  roomName: string;
  status: DirectCallSessionStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  callerVoiceTokenIssuedAt?: string;
  calleeVoiceTokenIssuedAt?: string;
  callerVoiceReadyAt?: string;
  calleeVoiceReadyAt?: string;
  callerLastSeenAt?: string;
  calleeLastSeenAt?: string;
};

type StoredEmailVerification = {
  email: string;
  codeHash: string;
  attempts: number;
  requestedAt: string;
  expiresAt: string;
};

type StoredSession = {
  accountId: string;
  createdAt: string;
  expiresAt: string;
};

type PersistedState = {
  rooms: RoomState[];
  accounts: StoredAccount[];
  sessions: Array<[string, string | StoredSession]>;
  friendships: StoredFriendship[];
  directMessages?: DirectMessage[];
  directReadStates?: StoredDirectReadState[];
  directCallSessions?: StoredDirectCallSession[];
  scripts: TrpgScript[];
  emailVerifications?: StoredEmailVerification[];
};

const clone = <T>(value: T): T => structuredClone(value);

function viewerIdFor(value?: Pick<Account, 'id'> | string | null) {
  return typeof value === 'string' ? value : value?.id;
}

function redactPlayerScriptCharacters<T extends { parameters?: string; story?: string; privateBrief?: string }>(characters: T[]): T[] {
  return characters.map((character) => ({
    ...character,
    parameters: '',
    story: '',
    privateBrief: '',
  }));
}

function exposeCharacterSheets(room: RoomState, viewer?: Pick<Account, 'id'> | string | null) {
  const viewerId = viewerIdFor(viewer);
  if (viewerId === room.ownerId) {
    return clone(room.characterSheets);
  }
  if (!viewerId) {
    return [];
  }
  return room.characterSheets
    .filter((sheet) => sheet.ownerId === viewerId)
    .map((sheet) => clone(sheet));
}

function safePublicationFromSource(
  room: RoomState,
  source: RoomPublicContent['source'] | undefined,
  author: Pick<Account, 'id' | 'displayName'>,
) {
  if (!source?.scriptId || !source.chapterId || !source.blockId) {
    return null;
  }
  const script = runtimeScriptForRoom(room);
  if (!script || script.id !== source.scriptId) {
    return null;
  }
  const found = findScriptBlock(script, source.chapterId, source.blockId);
  if (!found) {
    return null;
  }
  return publicationFromScriptBlock(script, found.chapter, found.block, author);
}

function scriptPublicationSourceFromMessage(message: ChatMessage): RoomPublicContent['source'] | undefined {
  const prefix = 'script-publication:';
  if (!message.clientMessageId?.startsWith(prefix)) {
    return undefined;
  }
  const [scriptId, chapterId, blockId] = message.clientMessageId.slice(prefix.length).split(':');
  if (!scriptId || !chapterId || !blockId) {
    return undefined;
  }
  return { scriptId, chapterId, blockId };
}

function exposeRoomMessage(room: RoomState, message: ChatMessage) {
  const next = { ...clone(message), roomId: message.roomId ?? room.id };
  const safePublication = safePublicationFromSource(
    room,
    scriptPublicationSourceFromMessage(message),
    { id: message.senderId ?? systemOwnerId, displayName: message.author },
  );
  if (safePublication?.type === 'character') {
    next.text = publicationMessageText(safePublication);
  }
  return next;
}

function exposeRecentRoomMessages(room: RoomState, viewer?: Pick<Account, 'id'> | string | null) {
  const viewerId = viewerIdFor(viewer);
  const cutoff = viewerId ? roomMessageHistoryCutoff(room, { id: viewerId }) : null;
  const visibleMessages = cutoff
    ? room.messages.filter((message) => Date.parse(message.createdAt) <= Date.parse(cutoff))
    : room.messages;
  return visibleMessages.slice(-roomStateMessageLimit).map((message) => exposeRoomMessage(room, message));
}

function exposeRoomProgress(room: RoomState, viewerId: string | undefined): RoomProgress {
  const progress = clone(room.progress ?? {});
  if (viewerId === room.ownerId) {
    return progress;
  }
  return {
    scriptId: progress.scriptId,
    scriptVersion: progress.scriptVersion,
    activeMapId: progress.activeMapId,
    updatedAt: progress.updatedAt,
  };
}

function exposeRoomPublicContent(room: RoomState) {
  return Array.isArray(room.publicContent)
    ? room.publicContent.map((item) => {
        const next = clone(item);
        if (next.source?.blockId === roomRolePackBlockId) {
          next.markdown = trimPublicationText(publicRolePackMarkdown(room));
        }
        const safePublication = safePublicationFromSource(
          room,
          next.source,
          { id: next.createdBy || systemOwnerId, displayName: next.createdByName || 'KP' },
        );
        if (safePublication?.type === 'character') {
          next.type = safePublication.type;
          next.title = safePublication.title;
          next.markdown = safePublication.markdown;
          next.source = safePublication.source;
        }
        return next;
      })
    : [];
}

function exposeScene(room: RoomState, viewerId: string | undefined) {
  const canSeeKeeperLayer = Boolean(viewerId && viewerId === room.ownerId);
  const visibleRoomCharacterIds = new Set(
    room.characters
      .filter((character) => canSeeKeeperLayer || !character.accountId || character.accountId === viewerId)
      .map((character) => character.id),
  );
  const scriptCharacterIds = new Set(room.scriptCharacters.map((character) => character.id));
  return {
    ...clone(room.scene),
    tokens: room.scene.tokens
      .filter((token) => {
        if (canSeeKeeperLayer) {
          return true;
        }
        if (token.status === 'hidden') {
          return false;
        }
        return visibleRoomCharacterIds.has(token.characterId)
          || (token.status === 'npc' && scriptCharacterIds.has(token.characterId));
      })
      .map((token) => clone(token)),
  };
}

function exposeCharacters(room: RoomState, viewerId: string | undefined) {
  const canSeeKeeperLayer = Boolean(viewerId && viewerId === room.ownerId);
  const visibleTokenCharacterIds = new Set(
    room.scene.tokens
      .filter((token) => token.status !== 'hidden')
      .map((token) => token.characterId),
  );
  return room.characters
    .filter((character) => {
      if (canSeeKeeperLayer) {
        return true;
      }
      if (character.accountId) {
        return true;
      }
      return visibleTokenCharacterIds.has(character.id)
        || Boolean(character.scriptCharacterId && visibleTokenCharacterIds.has(character.scriptCharacterId));
    })
    .map((character) => {
      const visible = canSeeKeeperLayer || character.accountId === viewerId;
      const next = clone(character);
      if (!visible) {
        next.notes = '';
        delete next.statBlock;
      }
      return next;
    });
}

function exposeRoom(room: RoomState, viewer?: Pick<Account, 'id'> | string | null): RoomState {
  const viewerId = viewerIdFor(viewer);
  const next = clone(room) as Partial<RoomState>;
  delete next.hiddenForAccountIds;
  if (viewerId !== room.ownerId && Array.isArray(next.scriptCharacters)) {
    next.scriptCharacters = redactPlayerScriptCharacters(next.scriptCharacters);
  }
  if (viewerId !== room.ownerId) {
    delete next.scriptSnapshot;
  }
  next.scene = exposeScene(room, viewerId);
  next.characters = exposeCharacters(room, viewerId);
  next.characterSheets = exposeCharacterSheets(room, viewer);
  next.messages = exposeRecentRoomMessages(room, viewer);
  next.progress = exposeRoomProgress(room, viewerId);
  next.publicContent = exposeRoomPublicContent(room);
  return next as RoomState;
}

function exposeScript(script: TrpgScript, viewer?: Pick<Account, 'id'> | string | null): TrpgScript {
  const next = clone(script);
  if (viewerIdFor(viewer) !== script.ownerId) {
    next.maps = [];
    next.diceProfiles = [];
    next.chapters = [];
    next.characters = redactPlayerScriptCharacters(next.characters);
  }
  return next;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, numberValue));
}

function scriptVersion(value: unknown, fallback = 1) {
  return boundedInt(value, fallback, 1, Number.MAX_SAFE_INTEGER);
}

function normalizeScriptCharacterDraft(
  input: Partial<ScriptCharacter>,
  fallback: Partial<ScriptCharacter> = {},
): ScriptCharacter {
  const id = input.id?.trim() || fallback.id || buildId('script-character');
  const name = input.name?.trim() || fallback.name?.trim() || '未命名人设';
  const count = boundedInt(input.count, fallback.count ?? 1, 1, 20);
  const recommendedSkills = Array.isArray(input.recommendedSkills)
    ? input.recommendedSkills
        .map((skill) => ({
          name: skill.name?.trim() ?? '',
          base: boundedInt(skill.base, 0, 0, 100),
        }))
        .filter((skill) => skill.name)
        .slice(0, 20)
    : fallback.recommendedSkills;

  return {
    id,
    name,
    count,
    parameters: input.parameters?.slice(0, 4000) ?? fallback.parameters ?? '',
    story: input.story?.slice(0, 8000) ?? fallback.story ?? '',
    occupation: input.occupation?.trim() || fallback.occupation || '',
    publicSummary: input.publicSummary?.slice(0, 2000) ?? fallback.publicSummary ?? '',
    privateBrief: input.privateBrief?.slice(0, 4000) ?? fallback.privateBrief ?? '',
    recommendedSkills,
  };
}

function normalizeDiceProfile(input: Partial<DiceProfile>, fallback: Partial<DiceProfile> = {}): DiceProfile {
  return {
    id: input.id?.trim() || fallback.id?.trim() || buildId('dice'),
    label: input.label?.trim() || fallback.label?.trim() || '骰子',
    formula: input.formula?.trim() || fallback.formula?.trim() || '1d100',
    probability: Math.max(0, Math.min(1, typeof input.probability === 'number' ? input.probability : fallback.probability ?? 0.5)),
  };
}

function normalizeDiceProfiles(input: unknown, fallback: DiceProfile[] = []) {
  return Array.isArray(input)
    ? input
        .map((profile, index) => normalizeDiceProfile(profile, fallback[index]))
        .filter((profile) => profile.label && profile.formula)
        .slice(0, 80)
    : fallback.map((profile) => normalizeDiceProfile(profile));
}

const mapFeatureTypes: MapFeature['type'][] = ['wall', 'door', 'cover', 'hazard'];
const mapTokenStatuses: MapToken['status'][] = ['ready', 'wounded', 'hidden', 'npc'];
const mapFeatureLabel: Record<MapFeature['type'], string> = {
  wall: '墙体',
  door: '门',
  cover: '掩体',
  hazard: '危险区',
};
const hexColorPattern = /^#[0-9a-f]{6}$/i;

function normalizeScriptMapFeature(input: Partial<MapFeature>, mapSize: { width: number; height: number }): MapFeature {
  const type = input.type && mapFeatureTypes.includes(input.type) ? input.type : 'wall';
  const x = boundedInt(input.x, 1, 1, mapSize.width);
  const y = boundedInt(input.y, 1, 1, mapSize.height);
  const maxWidth = Math.max(1, mapSize.width - x + 1);
  const maxHeight = Math.max(1, mapSize.height - y + 1);
  return {
    id: input.id?.trim() || buildId('feature'),
    type,
    label: input.label?.trim().slice(0, 120) || mapFeatureLabel[type],
    x,
    y,
    w: boundedInt(input.w, 1, 1, maxWidth),
    h: boundedInt(input.h, 1, 1, maxHeight),
  };
}

function normalizeScriptMapToken(
  input: Partial<MapToken>,
  mapSize: { width: number; height: number },
  charactersById: Map<string, ScriptCharacter>,
  index: number,
): MapToken | null {
  const characterId = input.characterId?.trim();
  const character = characterId ? charactersById.get(characterId) : undefined;
  if (!characterId || !character) {
    return null;
  }
  const color = input.color?.trim();
  return {
    id: input.id?.trim() || buildId('token'),
    characterId,
    label: input.label?.trim().slice(0, 80) || initials(character.name).slice(0, 2),
    color: color && hexColorPattern.test(color) ? color.toLowerCase() : tokenColors[index % tokenColors.length],
    x: boundedInt(input.x, 1, 1, mapSize.width),
    y: boundedInt(input.y, 1, 1, mapSize.height),
    status: input.status && mapTokenStatuses.includes(input.status) ? input.status : 'ready',
  };
}

function normalizeScriptMap(input: Partial<ScriptMap>, charactersById: Map<string, ScriptCharacter>): ScriptMap {
  const width = boundedInt(input.width, 12, 4, 40);
  const height = boundedInt(input.height, 8, 4, 30);
  const mapSize = { width, height };
  return {
    id: input.id?.trim() || buildId('map'),
    name: input.name?.trim().slice(0, 120) || '未命名地图',
    width,
    height,
    notes: input.notes?.slice(0, 2000) ?? '',
    features: Array.isArray(input.features)
      ? input.features.map((feature) => normalizeScriptMapFeature(feature, mapSize)).slice(0, 200)
      : [],
    tokens: Array.isArray(input.tokens)
      ? input.tokens
          .map((token, index) => normalizeScriptMapToken(token, mapSize, charactersById, index))
          .filter((token): token is MapToken => Boolean(token))
          .slice(0, 200)
      : [],
  };
}

function normalizeScriptBlock(
  input: Partial<ScriptBlock>,
  resources: { characters: ScriptCharacter[]; diceProfiles: DiceProfile[]; maps: ScriptMap[] },
): ScriptBlock | null {
  const id = input.id?.trim() || buildId('block');
  const title = input.title?.trim().slice(0, 120);
  if (input.type === 'map') {
    const mapId = input.mapId?.trim();
    if (!mapId || !resources.maps.some((map) => map.id === mapId)) {
      return null;
    }
    return {
      id,
      type: 'map',
      title: title || '地图块',
      mapId,
      notes: input.notes?.slice(0, 4000) ?? '',
    };
  }
  if (input.type === 'character') {
    const characterId = input.characterId?.trim();
    if (!characterId || !resources.characters.some((character) => character.id === characterId)) {
      return null;
    }
    return {
      id,
      type: 'character',
      title: title || '人物块',
      characterId,
      notes: input.notes?.slice(0, 4000) ?? '',
    };
  }
  if (input.type === 'check') {
    const diceId = input.diceId?.trim();
    if (!diceId || !resources.diceProfiles.some((dice) => dice.id === diceId)) {
      return null;
    }
    return {
      id,
      type: 'check',
      title: title || '判定块',
      diceId,
      difficulty: boundedInt(input.difficulty, 50, 0, 1000),
      onPass: input.onPass?.slice(0, 4000) ?? '',
      onFail: input.onFail?.slice(0, 4000) ?? '',
    };
  }
  const narrative = input as Partial<Extract<ScriptBlock, { type: 'narrative' }>>;
  return {
    id,
    type: 'narrative',
    title: title || '正文',
    markdown: narrative.markdown?.slice(0, 30000) ?? '',
  };
}

function normalizeScriptChapters(
  input: unknown,
  resources: { characters: ScriptCharacter[]; diceProfiles: DiceProfile[]; maps: ScriptMap[] },
) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((chapter): chapter is Partial<ScriptChapter> => Boolean(chapter && typeof chapter === 'object'))
    .map((chapter) => ({
      id: chapter.id?.trim() || buildId('chapter'),
      title: chapter.title?.trim().slice(0, 120) || '未命名章节',
      blocks: Array.isArray(chapter.blocks)
        ? chapter.blocks
            .map((block) => normalizeScriptBlock(block, resources))
            .filter((block): block is ScriptBlock => Boolean(block))
            .slice(0, 200)
        : [],
    }))
    .slice(0, 120);
}

function initials(value: string) {
  const compact = value.trim();
  if (!compact) {
    return 'PT';
  }
  return compact.slice(0, 2).toUpperCase();
}

function makeSeedRoom(): RoomState {
  return {
    id: seedRoomId,
    name: '灰烬旅店',
    system: 'COC 7th',
    phase: 'playing',
    visibility: 'public',
    ownerId: systemOwnerId,
    ownerName: '系统示例',
    scriptId: seedScriptId,
    players: 0,
    updatedAt: now(),
    online: true,
    closedAt: null,
    keeper: '阿青',
    summary: '暴雨夜里，调查员们在旅店二层听见墙内传来规律的敲击声。',
    memberIds: [],
    members: [],
    participantIds: [],
    participants: [],
    rosterIds: [],
    roster: [],
    rosterHistoryIds: [],
    hiddenForAccountIds: [],
    invitedAccountIds: [],
    closeAt: null,
    phaseBeforeClose: null,
    scriptSnapshot: undefined,
    scriptCharacters: [],
    diceProfiles: [],
    characterSheets: [],
    scene: {
      mapId: 'map-inn',
      name: '旅店二层走廊',
      width: 12,
      height: 8,
      features: [
        { id: 'wall-north', type: 'wall', label: '木墙', x: 1, y: 1, w: 12, h: 1 },
        { id: 'door-201', type: 'door', label: '201', x: 3, y: 2, w: 2, h: 1 },
        { id: 'cover-stairs', type: 'cover', label: '楼梯', x: 10, y: 6, w: 2, h: 2 },
        { id: 'hazard-lamp', type: 'hazard', label: '破碎油灯', x: 7, y: 4, w: 2, h: 1 },
      ],
      tokens: [
        {
          id: 'token-a',
          characterId: 'char-lin',
          label: '林',
          color: '#187a6d',
          x: 3,
          y: 5,
          status: 'ready',
        },
        {
          id: 'token-b',
          characterId: 'char-qiao',
          label: '乔',
          color: '#b85f32',
          x: 5,
          y: 6,
          status: 'wounded',
        },
        {
          id: 'token-c',
          characterId: 'npc-shadow',
          label: '?',
          color: '#4f5565',
          x: 9,
          y: 3,
          status: 'hidden',
        },
      ],
    },
    progress: {
      scriptId: seedScriptId,
      scriptVersion: 1,
      activeMapId: 'map-inn',
    },
    publicContent: [
      {
        id: 'public-seed-opening',
        type: 'narrative',
        title: '开场',
        markdown: '暴雨夜里，调查员们在旅店二层听见墙内传来规律的敲击声。',
        source: {
          scriptId: seedScriptId,
          scriptVersion: 1,
        },
        createdBy: systemOwnerId,
        createdByName: '阿青',
        createdAt: now(),
      },
    ],
    characters: [
      {
        id: 'char-lin',
        name: '林岚',
        player: '小林',
        avatar: 'LL',
        hp: 11,
        maxHp: 12,
        sanity: 58,
        maxSanity: 70,
        initiative: 65,
        tags: ['调查员', '医学'],
        notes: '随身带急救包和录音笔。',
      },
      {
        id: 'char-qiao',
        name: '乔远',
        player: '阿乔',
        avatar: 'QY',
        hp: 7,
        maxHp: 13,
        sanity: 44,
        maxSanity: 60,
        initiative: 52,
        tags: ['记者', '潜行'],
        notes: '刚在楼梯口摔伤，行动受限。',
      },
      {
        id: 'npc-shadow',
        name: '墙中影',
        player: 'KP',
        avatar: 'KP',
        hp: 9,
        maxHp: 9,
        sanity: 0,
        maxSanity: 0,
        initiative: 80,
        tags: ['NPC', '隐藏'],
        notes: '只对守秘人可见。',
      },
    ],
    messages: [
      {
        id: 'msg-1',
        author: '阿青',
        role: 'keeper',
        text: '油灯熄灭后，走廊尽头的门自己开了一条缝。',
        createdAt: now(),
      },
      {
        id: 'msg-2',
        author: '小林',
        role: 'player',
        text: '我蹲下检查地板上的煤油痕迹。',
        createdAt: now(),
      },
    ],
    voice: {
      epoch: buildVoiceEpoch(),
      livekitConfigured: false,
      participants: [
        { id: 'voice-1', name: '阿青', muted: false, speaking: true, quality: 'excellent' },
        { id: 'voice-2', name: '小林', muted: false, speaking: false, quality: 'good' },
        { id: 'voice-3', name: '阿乔', muted: true, speaking: false, quality: 'relay' },
      ],
    },
  };
}

function makeEmptyRoomBase(input: Partial<Pick<RoomState, 'id' | 'name' | 'system' | 'phase' | 'visibility' | 'ownerId' | 'ownerName' | 'keeper' | 'scriptId'>> = {}): RoomState {
  const ownerName = input.ownerName ?? input.keeper ?? '守秘人';
  return {
    id: input.id ?? buildId('room'),
    name: input.name?.trim() || '未命名房间',
    system: input.system?.trim() || 'COC 7th',
    phase: input.phase ?? 'module_locked',
    visibility: input.visibility ?? 'public',
    ownerId: input.ownerId ?? systemOwnerId,
    ownerName,
    scriptId: input.scriptId,
    players: 0,
    updatedAt: now(),
    online: true,
    closedAt: null,
    keeper: input.keeper ?? ownerName,
    summary: '',
    memberIds: [],
    members: [],
    participantIds: [],
    participants: [],
    rosterIds: [],
    roster: [],
    rosterHistoryIds: [],
    hiddenForAccountIds: [],
    invitedAccountIds: [],
    closeAt: null,
    phaseBeforeClose: null,
    scriptCharacters: [],
    diceProfiles: [],
    characterSheets: [],
    scene: {
      mapId: undefined,
      name: '空白地图',
      width: 12,
      height: 8,
      features: [],
      tokens: [],
    },
    progress: {
      scriptId: input.scriptId,
    },
    publicContent: [],
    characters: [],
    messages: [],
    voice: {
      epoch: buildVoiceEpoch(),
      livekitConfigured: false,
      participants: [],
    },
  };
}

function makeSeedScript(): TrpgScript {
  return {
    id: seedScriptId,
    title: '灰烬旅店',
    system: 'COC 7th',
    visibility: 'public',
    ownerId: systemOwnerId,
    ownerName: '系统示例',
    summary: '一晚可以跑完的旅店调查剧本，包含地图、NPC、线索和骰子判定。',
    tags: ['新手', '调查', '恐怖'],
    coverUrl: '',
    maps: [{ id: 'map-inn', name: '旅店二层', width: 12, height: 8, notes: '可直接作为默认房间地图。' }],
    characters: [
      {
        id: 'sc-npc-keeper',
        name: '旅店老板',
        count: 1,
        parameters: 'HP 10 / SAN 40 / 说服 55',
        story: '知道墙内旧密室的入口，但不愿主动说明。',
        occupation: '记者',
        publicSummary: '旅店相关人物，可作为调查线索联系人。',
        privateBrief: '知道墙内旧密室入口。',
        recommendedSkills: [{ name: '侦查', base: 25 }, { name: '聆听', base: 20 }],
      },
    ],
    diceProfiles: [
      { id: 'dice-coc', label: 'COC 百分骰', formula: '1d100', probability: 0.5 },
      { id: 'dice-damage', label: '轻伤伤害', formula: '1d6', probability: 0.35 },
    ],
    chapters: [
      {
        id: 'chapter-arrival',
        title: '抵达旅店',
        blocks: [
          {
            id: 'block-open',
            type: 'narrative',
            title: '开场描述',
            markdown: '暴雨封住了山路，调查员只能在灰烬旅店暂住一晚。',
          },
          {
            id: 'block-check',
            type: 'check',
            title: '聆听墙声',
            diceId: 'dice-coc',
            difficulty: 55,
            onPass: '听出敲击来自 201 房间后的墙体。',
            onFail: '只能确认声音来自二楼走廊尽头。',
          },
        ],
      },
    ],
    createdAt: now(),
    updatedAt: now(),
    version: 1,
  };
}

const rooms = new Map<string, RoomState>(seedDataEnabled ? [[seedRoomId, makeSeedRoom()]] : []);
const accounts = new Map<string, StoredAccount>();
const sessions = new Map<string, StoredSession>();
const friendships = new Map<string, StoredFriendship>();
const directMessages: DirectMessage[] = [];
const directReadStates = new Map<string, StoredDirectReadState>();
const directCallSessions = new Map<string, StoredDirectCallSession>();
type DirectCallCleanupEvent = DirectCallEvent & { liveKitRoomName?: string };
const pendingDirectCallEvents = new Map<string, DirectCallCleanupEvent>();
const emailVerifications = new Map<string, StoredEmailVerification>();
const scripts = new Map<string, TrpgScript>(seedDataEnabled ? [[seedScriptId, makeSeedScript()]] : []);
type ClosedRoomEvent = Pick<RoomState, 'id' | 'online' | 'closedAt'> & {
  roomId: string;
  liveKitRoomName?: string;
};
const pendingClosedRoomEvents = new Map<string, ClosedRoomEvent>();
const pendingStartupLiveKitRoomCleanups = new Set<string>();
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const stateFile = path.join(dataDir, 'state.json');
const stateBackupFile = `${stateFile}.bak`;
const dataDirLockFile = path.join(dataDir, 'server.lock');
const persistDebounceMs = 250;
const syncPersistEnabled =
  process.env.NODE_ENV === 'test' || process.env.PAOTUAN_SYNC_PERSIST === 'true';
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDirty = false;
const directCallRingTtlMs = 2 * 60_000;
const directCallAcceptedLeaseMs = 5 * 60_000;
const directCallTerminalRetentionMs = 10 * 60_000;
let persistVersion = 0;
let persistExitFlushRegistered = false;
let persistWriteChain: Promise<void> = Promise.resolve();
let dataDirLockFd: number | null = null;
const roomClosureDelayMs = 5 * 60 * 1000;
const maxRoomPublicContent = 300;
const roomStateMessageLimit = 50;
const emailVerificationTtlMs = 10 * 60 * 1000;
const emailVerificationCooldownMs = 60 * 1000;
const maxEmailVerificationAttempts = 5;
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const firstNonEmpty = (...values: Array<string | undefined>) =>
  values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
const configuredEmailVerificationSecret =
  firstNonEmpty(process.env.VERIFICATION_CODE_SECRET, process.env.EMAIL_VERIFICATION_SECRET, process.env.LIVEKIT_API_SECRET);
const emailVerificationSecret = configuredEmailVerificationSecret ?? randomBytes(32).toString('hex');

if (!configuredEmailVerificationSecret && process.env.NODE_ENV === 'production') {
  console.warn('VERIFICATION_CODE_SECRET is not configured; pending email codes will be invalid after restart.');
}

function isDataDirLockEnabled() {
  return process.env.NODE_ENV !== 'test' && process.env.PAOTUAN_DISABLE_DATA_DIR_LOCK !== 'true';
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ESRCH'
    );
  }
}

function readLockPid() {
  try {
    const raw = readFileSync(dataDirLockFile, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

function releaseDataDirLock() {
  if (dataDirLockFd === null) {
    return;
  }
  try {
    closeSync(dataDirLockFd);
  } catch {
    // Best-effort cleanup during process shutdown.
  }
  dataDirLockFd = null;
  try {
    rmSync(dataDirLockFile, { force: true });
  } catch {
    // Best-effort cleanup during process shutdown.
  }
}

function acquireDataDirLock() {
  if (!isDataDirLockEnabled()) {
    return;
  }
  mkdirSync(dataDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      dataDirLockFd = openSync(dataDirLockFile, 'wx');
      writeFileSync(dataDirLockFd, JSON.stringify({
        pid: process.pid,
        startedAt: now(),
      }, null, 2));
      process.once('exit', releaseDataDirLock);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== 'EEXIST') {
        throw error;
      }
      const pid = readLockPid();
      if (pid && pid !== process.pid && isProcessAlive(pid)) {
        throw new Error(`DATA_DIR is already locked by process ${pid}: ${dataDirLockFile}`);
      }
      rmSync(dataDirLockFile, { force: true });
    }
  }
}

acquireDataDirLock();

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function timingSafeHexEqual(actualHex: string, expectedHex: string) {
  if (actualHex.length !== expectedHex.length || actualHex.length % 2 !== 0) {
    return false;
  }

  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length || actual.length * 2 !== actualHex.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

function verifyPassword(password: string, storedHash: string) {
  if (storedHash.startsWith('scrypt:')) {
    const [, salt, expectedHash] = storedHash.split(':');
    if (!salt || !expectedHash || expectedHash.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(expectedHash)) {
      return false;
    }
    const actualHash = scryptSync(password, salt, expectedHash.length / 2);
    return timingSafeHexEqual(actualHash.toString('hex'), expectedHash);
  }

  return timingSafeHexEqual(legacyHashSecret(password), storedHash);
}

function isLegacyPasswordHash(storedHash: string) {
  return !storedHash.startsWith('scrypt:');
}

function safeAccount(account: StoredAccount): Account {
  const { passwordHash: _passwordHash, passcodeHash: _passcodeHash, handle: _handle, ...safe } = account;
  return clone(safe);
}

function syncRoomMembers(room: RoomState) {
  room.memberIds = room.members.map((member) => member.accountId);
  room.players = room.members.length;
}

function syncRoomParticipants(room: RoomState) {
  room.participantIds = room.participants.map((member) => member.accountId);
}

function syncRoomRoster(room: RoomState) {
  room.rosterIds = room.roster.map((member) => member.accountId);
}

function removeRoomVoiceParticipant(room: RoomState, accountId: string) {
  room.voice = {
    ...room.voice,
    participants: room.voice.participants.filter((participant) => participant.id !== accountId),
  };
}

function buildVoiceEpoch() {
  return buildId('voice');
}

function rotateRoomVoiceEpoch(room: RoomState) {
  room.voice = {
    ...room.voice,
    epoch: buildVoiceEpoch(),
  };
}

function roomVoiceRoomName(room: Pick<RoomState, 'id' | 'voice'>) {
  return `${room.id}:${room.voice.epoch ?? 'legacy'}`;
}

function queueStartupLiveKitRoomCleanup(roomName?: string | null) {
  const normalized = roomName?.trim();
  if (normalized) {
    pendingStartupLiveKitRoomCleanups.add(normalized);
  }
}

function drainStartupLiveKitRoomCleanupRooms() {
  const roomNames = Array.from(pendingStartupLiveKitRoomCleanups.values());
  pendingStartupLiveKitRoomCleanups.clear();
  return roomNames;
}

function upsertRoomVoiceParticipant(
  room: RoomState,
  account: Account,
  input: Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>> = {},
) {
  const participant = room.voice.participants.find((item) => item.id === account.id);
  if (participant) {
    participant.name = account.displayName;
    participant.muted = input.muted ?? participant.muted;
    participant.speaking = input.speaking ?? participant.speaking;
    participant.quality = input.quality ?? participant.quality;
  } else {
    room.voice.participants.push({
      id: account.id,
      name: account.displayName,
      muted: input.muted ?? false,
      speaking: input.speaking ?? false,
      quality: input.quality ?? 'excellent',
    });
  }
}

function makeRoomMember(
  account: Pick<Account, 'id' | 'displayName' | 'avatar' | 'role'>,
  input?: Partial<Pick<RoomMember, 'displayName' | 'avatar' | 'role' | 'joinedAt' | 'lastSeenAt' | 'leftAt'>>,
): RoomMember {
  const timestamp = now();
  const member: RoomMember = {
    accountId: account.id,
    displayName: input?.displayName?.trim() || account.displayName,
    avatar: input?.avatar?.trim() || account.avatar,
    role: normalizeUserRole(input?.role ?? account.role, 'player'),
    joinedAt: input?.joinedAt ?? timestamp,
    lastSeenAt: input?.lastSeenAt ?? timestamp,
  };
  if (input?.leftAt) {
    member.leftAt = input.leftAt;
  }
  return member;
}

function hydrateRoomMembers(raw: Partial<RoomState>) {
  const fallbackMembers = Array.isArray(raw.memberIds)
    ? raw.memberIds.map((accountId) => {
        const account = accounts.get(accountId);
        return makeRoomMember(
          account ?? { id: accountId, displayName: accountId, avatar: initials(accountId), role: 'player' },
          { role: roleForRoomAccount({ ownerId: raw.ownerId ?? systemOwnerId }, accountId) },
        );
      })
    : [];

  const members = Array.isArray(raw.members)
    ? raw.members
        .filter((member): member is RoomMember => Boolean(member?.accountId))
        .map((member) => {
          const account = accounts.get(member.accountId);
          return makeRoomMember(
            account ?? {
              id: member.accountId,
              displayName: member.displayName,
              avatar: member.avatar,
              role: member.role,
            },
            member,
          );
        })
    : fallbackMembers;

  return members;
}

function hydrateRoomParticipants(raw: Partial<RoomState>, currentMembers: RoomMember[]) {
  const source = Array.isArray(raw.participants) && raw.participants.length > 0
    ? raw.participants
    : Array.isArray(raw.participantIds) && raw.participantIds.length > 0
    ? raw.participantIds.map((accountId) => {
        const account = accounts.get(accountId);
        return makeRoomMember(
          account ?? { id: accountId, displayName: accountId, avatar: initials(accountId), role: 'player' },
          { role: roleForRoomAccount({ ownerId: raw.ownerId ?? systemOwnerId }, accountId) },
        );
      })
      : currentMembers;

  const byAccount = new Map<string, RoomMember>();
  source
    .filter((member): member is RoomMember => Boolean(member?.accountId))
    .forEach((member) => {
      const account = accounts.get(member.accountId);
      byAccount.set(
        member.accountId,
        makeRoomMember(
          account ?? {
            id: member.accountId,
            displayName: member.displayName,
            avatar: member.avatar,
            role: member.role,
          },
          member,
        ),
      );
    });

  currentMembers.forEach((member) => {
    if (!byAccount.has(member.accountId)) {
      byAccount.set(member.accountId, clone(member));
    }
  });

  return Array.from(byAccount.values());
}

function hydrateRoomRoster(raw: Partial<RoomState>, participants: RoomMember[], currentMembers: RoomMember[]) {
  const hasRoster = Object.prototype.hasOwnProperty.call(raw, 'roster');
  const hasRosterIds = Object.prototype.hasOwnProperty.call(raw, 'rosterIds');
  const source = hasRoster && Array.isArray(raw.roster)
    ? raw.roster
    : hasRosterIds && Array.isArray(raw.rosterIds)
      ? raw.rosterIds.map((accountId) => {
        const account = accounts.get(accountId);
        return makeRoomMember(
          account ?? { id: accountId, displayName: accountId, avatar: initials(accountId), role: 'player' },
          { role: roleForRoomAccount({ ownerId: raw.ownerId ?? systemOwnerId }, accountId) },
        );
      })
      : participants;

  const byAccount = new Map<string, RoomMember>();
  source
    .filter((member): member is RoomMember => Boolean(member?.accountId))
    .forEach((member) => {
      const account = accounts.get(member.accountId);
      byAccount.set(
        member.accountId,
        makeRoomMember(
          account ?? {
            id: member.accountId,
            displayName: member.displayName,
            avatar: member.avatar,
            role: member.role,
          },
          member,
        ),
      );
    });

  if (!hasRoster && !hasRosterIds) {
    currentMembers.forEach((member) => {
      if (!byAccount.has(member.accountId)) {
        byAccount.set(member.accountId, clone(member));
      }
    });
  }

  return Array.from(byAccount.values());
}

function scheduleRoomClosure(room: RoomState, timestamp = Date.now()) {
  if (!room.online) {
    return;
  }
  room.closeAt = new Date(timestamp + roomClosureDelayMs).toISOString();
}

function clearRoomClosure(room: RoomState) {
  room.closeAt = null;
}

function closeOnlineRoom(room: RoomState, timestamp = Date.now()) {
  room.online = false;
  room.phaseBeforeClose = room.phase === 'closed'
    ? room.phaseBeforeClose ?? null
    : room.phase;
  room.phase = 'closed';
  room.closedAt = new Date(timestamp).toISOString();
  room.closeAt = null;
  room.members = [];
  room.voice = {
    ...room.voice,
    epoch: buildVoiceEpoch(),
    participants: [],
  };
  syncRoomMembers(room);
  syncRoomParticipants(room);
  syncRoomRoster(room);
  touch(room);
}

function openOnlineRoom(room: RoomState) {
  room.online = true;
  room.closedAt = null;
  rotateRoomVoiceEpoch(room);
  if (room.phase === 'closed') {
    room.phase = room.phaseBeforeClose && room.phaseBeforeClose !== 'closed'
      ? room.phaseBeforeClose
      : room.characters.length > 0 ? 'playing' : 'casting';
  }
  room.phaseBeforeClose = null;
  clearRoomClosure(room);
}

function upsertRoomParticipant(room: RoomState, account: Account, role: UserRole, options: { includeRoster?: boolean } = {}) {
  room.hiddenForAccountIds = room.hiddenForAccountIds.filter((id) => id !== account.id);
  const participant = room.participants.find((member) => member.accountId === account.id);
  if (participant) {
    participant.displayName = account.displayName;
    participant.avatar = account.avatar;
    participant.role = role;
    participant.lastSeenAt = now();
    participant.leftAt = undefined;
  } else {
    room.participants.push(makeRoomMember(account, { role }));
  }
  syncRoomParticipants(room);

  if (options.includeRoster === false) {
    return;
  }

  if (!room.rosterHistoryIds.includes(account.id)) {
    room.rosterHistoryIds.push(account.id);
  }
  const rosterMember = room.roster.find((member) => member.accountId === account.id);
  if (rosterMember) {
    rosterMember.displayName = account.displayName;
    rosterMember.avatar = account.avatar;
    rosterMember.role = role;
    rosterMember.lastSeenAt = now();
  } else {
    room.roster.push(makeRoomMember(account, { role }));
  }
  syncRoomRoster(room);
}

function normalizeAccount(raw: Partial<StoredAccount> & { handle?: string }): StoredAccount | null {
  const email = normalizeEmail(raw.email ?? (raw.handle ? `${raw.handle}@local.paotuan` : ''));
  if (!raw.id || !email) {
    return null;
  }

  const displayName = (raw.displayName ?? raw.handle ?? email.split('@')[0]).trim();
  const passwordHash = raw.passwordHash ?? raw.passcodeHash;
  if (!passwordHash) {
    return null;
  }

  return {
    id: raw.id,
    email,
    displayName,
    avatar: raw.avatar ?? initials(displayName),
    role: raw.role ?? 'player',
    createdAt: raw.createdAt ?? now(),
    lastSeenAt: raw.lastSeenAt ?? now(),
    passwordHash,
    passcodeHash: raw.passcodeHash,
    handle: raw.handle,
  };
}

function normalizeRoomPhase(rawPhase: unknown, fallback: RoomPhase = 'playing'): RoomPhase {
  return typeof rawPhase === 'string' && roomPhases.includes(rawPhase as RoomPhase)
    ? (rawPhase as RoomPhase)
    : fallback;
}

function normalizePhaseBeforeClose(raw: Partial<RoomState>, phase: RoomPhase): RoomPhase | null {
  if (raw.online !== false && phase !== 'closed') {
    return null;
  }
  const fallback = Array.isArray(raw.characters) && raw.characters.length > 0 ? 'playing' : 'module_locked';
  const restored = normalizeRoomPhase(raw.phaseBeforeClose, fallback);
  return restored === 'closed' ? fallback : restored;
}

function normalizeRoomCharacterSheets(raw: Partial<RoomState>) {
  return Array.isArray(raw.characterSheets)
    ? raw.characterSheets
        .filter((sheet): sheet is CharacterSheet => Boolean(sheet?.id && sheet.ownerId))
        .map((sheet) => normalizeCharacterSheet(sheet))
    : [];
}

function normalizeRoomScene(rawScene: Partial<RoomState>['scene'], fallback: RoomState['scene']) {
  if (!rawScene || typeof rawScene !== 'object') {
    return fallback;
  }

  return {
    mapId: typeof rawScene.mapId === 'string' && rawScene.mapId.trim() ? rawScene.mapId.trim() : fallback.mapId,
    name: typeof rawScene.name === 'string' && rawScene.name.trim() ? rawScene.name : fallback.name,
    width: boundedInt(rawScene.width, fallback.width, 4, 40),
    height: boundedInt(rawScene.height, fallback.height, 4, 30),
    features: Array.isArray(rawScene.features) ? rawScene.features.filter((feature) => Boolean(feature?.id)) : fallback.features,
    tokens: Array.isArray(rawScene.tokens)
      ? rawScene.tokens.filter((token): token is MapToken => Boolean(token?.id && token.characterId))
      : fallback.tokens,
  };
}

function normalizeRoomProgress(raw: Partial<RoomState>, fallbackScriptId?: string): RoomProgress {
  const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
  return {
    scriptId: typeof progress.scriptId === 'string' && progress.scriptId.trim()
      ? progress.scriptId.trim()
      : fallbackScriptId,
    scriptVersion: typeof progress.scriptVersion === 'number' && Number.isFinite(progress.scriptVersion)
      ? Math.max(1, Math.round(progress.scriptVersion))
      : undefined,
    currentChapterId: typeof progress.currentChapterId === 'string' && progress.currentChapterId.trim()
      ? progress.currentChapterId.trim()
      : undefined,
    currentBlockId: typeof progress.currentBlockId === 'string' && progress.currentBlockId.trim()
      ? progress.currentBlockId.trim()
      : undefined,
    currentParagraphIndex: typeof progress.currentParagraphIndex === 'number' && Number.isFinite(progress.currentParagraphIndex)
      ? Math.max(0, Math.round(progress.currentParagraphIndex))
      : undefined,
    activeMapId: typeof progress.activeMapId === 'string' && progress.activeMapId.trim()
      ? progress.activeMapId.trim()
      : raw.scene?.mapId,
    updatedBy: typeof progress.updatedBy === 'string' && progress.updatedBy.trim()
      ? progress.updatedBy.trim()
      : undefined,
    updatedAt: typeof progress.updatedAt === 'string' && progress.updatedAt.trim()
      ? progress.updatedAt
      : undefined,
  };
}

function normalizeRoomPublicContent(raw: Partial<RoomState>): RoomPublicContent[] {
  if (!Array.isArray(raw.publicContent)) {
    return [];
  }
  return raw.publicContent
    .filter((item): item is RoomPublicContent => Boolean(
      item?.id &&
      typeof item.title === 'string' &&
      typeof item.markdown === 'string',
    ))
    .slice(-maxRoomPublicContent)
    .map((item) => ({
      id: item.id,
      type: ['narrative', 'map', 'character', 'check'].includes(item.type) ? item.type : 'narrative',
      title: item.title.slice(0, 160),
      markdown: item.markdown.slice(0, 12000),
      source: item.source ? clone(item.source) : undefined,
      createdBy: item.createdBy || raw.ownerId || systemOwnerId,
      createdByName: item.createdByName || raw.ownerName || raw.keeper || 'KP',
      createdAt: item.createdAt || raw.updatedAt || now(),
    }));
}

function roleForRoomAccount(room: Pick<RoomState, 'ownerId'>, accountId: string): UserRole {
  return accountId === room.ownerId ? 'keeper' : 'player';
}

function normalizeUserRole(value: unknown, fallback: UserRole = 'player'): UserRole {
  return typeof value === 'string' && userRoles.includes(value as UserRole) ? (value as UserRole) : fallback;
}

function normalizeRoomMemberRoles(room: RoomState) {
  room.members.forEach((member) => {
    member.role = roleForRoomAccount(room, member.accountId);
  });
  room.participants.forEach((participant) => {
    participant.role = roleForRoomAccount(room, participant.accountId);
  });
  room.roster.forEach((member) => {
    member.role = roleForRoomAccount(room, member.accountId);
  });
}

function validateScriptCharacterChoice(
  room: RoomState,
  sheet: Pick<CharacterSheet, 'id' | 'ownerId' | 'scriptCharacterId'>,
  options: { includeSubmitted?: boolean } = {},
) {
  const scriptCharacterId = sheet.scriptCharacterId?.trim();
  if (!scriptCharacterId) {
    return { ok: true as const };
  }

  const scriptCharacter = room.scriptCharacters.find((character) => character.id === scriptCharacterId);
  if (!scriptCharacter) {
    return { ok: false as const, error: 'Selected script character no longer exists' as const };
  }

  const occupiedStatuses = options.includeSubmitted
    ? new Set<CharacterSheetStatus>(['submitted', 'approved'])
    : new Set<CharacterSheetStatus>(['approved']);
  const activePlayerIds = recruitedPlayerIds(room);
  const occupied = room.characterSheets.filter(
    (item) =>
      item.id !== sheet.id &&
      activePlayerIds.has(item.ownerId) &&
      item.scriptCharacterId === scriptCharacterId &&
      occupiedStatuses.has(item.status),
  ).length;
  if (occupied >= scriptCharacter.count) {
    return { ok: false as const, error: `Script character "${scriptCharacter.name}" is already full` as const };
  }

  return { ok: true as const };
}

function recruitedPlayerMembers(room: RoomState) {
  return room.roster.filter((member) => member.accountId !== room.ownerId);
}

function recruitedPlayerIds(room: RoomState) {
  return new Set(recruitedPlayerMembers(room).map((member) => member.accountId));
}

function isActiveRosterPlayer(room: RoomState, accountId: string) {
  return accountId !== room.ownerId && room.roster.some((member) => member.accountId === accountId);
}

function activeRosterSheets(room: RoomState) {
  const playerIds = recruitedPlayerIds(room);
  return room.characterSheets.filter((sheet) => playerIds.has(sheet.ownerId));
}

function activePlayerSheet(room: RoomState, accountId: string) {
  return room.characterSheets.find((sheet) => sheet.ownerId === accountId);
}

function roomPreparationIssues(room: Pick<RoomState, 'summary' | 'scriptCharacters'>) {
  const issues: string[] = [];
  if (!room.summary.trim()) {
    issues.push('需要填写给玩家看的公开剧情');
  }
  const hasPublicCharacter = room.scriptCharacters.some((character) => {
    const hasName = Boolean(character.name.trim());
    const hasPublicBrief = Boolean((character.publicSummary ?? '').trim());
    return hasName && hasPublicBrief;
  });
  if (!hasPublicCharacter) {
    issues.push('至少需要 1 个带公开人设摘要的可选角色');
  }
  return issues;
}

function validateRecruitmentReadiness(room: RoomState) {
  const issues = roomPreparationIssues(room);
  if (issues.length > 0) {
    return { ok: false as const, error: `确认模组后才能招募PL：${issues.join('；')}。` };
  }
  return { ok: true as const };
}

function validateRoomPhaseReadiness(room: RoomState, phase: RoomPhase) {
  const players = recruitedPlayerMembers(room);
  const rosterSheets = activeRosterSheets(room);
  if (phase === 'chargen' && players.length === 0) {
    return { ok: false as const, error: '进入车卡前至少需要 1 名已加入名单的玩家。' as const };
  }
  if (phase === 'review') {
    if (!rosterSheets.some((sheet) => sheet.status === 'submitted')) {
      return { ok: false as const, error: '进入集中审核前至少需要 1 张已提交角色卡。' as const };
    }
    const notSubmitted = players.filter((member) => {
      const sheet = activePlayerSheet(room, member.accountId);
      return !sheet || sheet.status === 'draft' || sheet.status === 'rejected';
    });
    if (notSubmitted.length > 0) {
      return {
        ok: false as const,
        error: `以下玩家需要先提交或修改角色卡：${notSubmitted.map((member) => member.displayName).join('、')}`,
      };
    }
  }

  if (phase === 'casting' || phase === 'playing') {
    const submittedCount = rosterSheets.filter((sheet) => sheet.status === 'submitted').length;
    if (submittedCount > 0) {
      return { ok: false as const, error: '进入选角导入前需要先审核完所有已提交角色卡。' };
    }
    const approvedCount = rosterSheets.filter((sheet) => sheet.status === 'approved').length;
    if (approvedCount === 0) {
      return { ok: false as const, error: '进入选角导入前至少需要 1 张已通过角色卡。' };
    }
    const notConfirmed = players.filter((member) => {
      const sheet = activePlayerSheet(room, member.accountId);
      return sheet?.status !== 'approved' || !sheet.confirmedAt;
    });
    if (notConfirmed.length > 0) {
      return {
        ok: false as const,
        error: `以下玩家还没有确认已通过角色卡：${notConfirmed.map((member) => member.displayName).join('、')}`,
      };
    }
  }

  return { ok: true as const };
}

function isRoomOwner(room: Pick<RoomState, 'ownerId'>, accountId: string) {
  return room.ownerId === accountId;
}

function normalizeRoom(raw: Partial<RoomState>): RoomState | null {
  if (!raw.id || !raw.name || !raw.system) {
    return null;
  }

  const members = hydrateRoomMembers(raw);
  const participants = hydrateRoomParticipants(raw, members);
  const roster = hydrateRoomRoster(raw, participants, members);
  const memberIds = new Set(members.map((member) => member.accountId));
  const voiceParticipants = Array.isArray(raw.voice?.participants)
    ? raw.voice.participants.filter((participant) => participant?.id && memberIds.has(participant.id))
    : [];
  const phase = normalizeRoomPhase(raw.phase, raw.online === false ? 'closed' : 'playing');
  const scriptSnapshot = raw.scriptSnapshot ? normalizeScript(raw.scriptSnapshot) ?? undefined : undefined;
  const baseRoom = makeEmptyRoomBase({
      id: raw.id,
      name: raw.name,
      system: raw.system,
      phase,
      visibility: raw.visibility,
      ownerId: raw.ownerId,
      ownerName: raw.ownerName ?? raw.keeper,
      keeper: raw.keeper ?? raw.ownerName,
      scriptId: raw.scriptId,
    });
  const room = {
    ...baseRoom,
    ...raw,
    phase,
    visibility: raw.visibility ?? 'public',
    ownerId: raw.ownerId ?? systemOwnerId,
    ownerName: raw.ownerName ?? raw.keeper ?? '系统示例',
    keeper: raw.keeper ?? raw.ownerName ?? '守秘人',
    memberIds: members.map((member) => member.accountId),
    members,
    participantIds: participants.map((member) => member.accountId),
    participants,
    rosterIds: roster.map((member) => member.accountId),
    roster,
    rosterHistoryIds: Array.isArray(raw.rosterHistoryIds)
      ? raw.rosterHistoryIds.filter(Boolean)
      : roster.map((member) => member.accountId),
    hiddenForAccountIds: Array.isArray(raw.hiddenForAccountIds) ? raw.hiddenForAccountIds.filter(Boolean) : [],
    invitedAccountIds: Array.isArray(raw.invitedAccountIds) ? raw.invitedAccountIds.filter(Boolean) : [],
    scriptCharacters: Array.isArray(raw.scriptCharacters)
      ? raw.scriptCharacters.map((character) => normalizeScriptCharacterDraft(character))
      : [],
    diceProfiles: normalizeDiceProfiles(raw.diceProfiles),
    progress: normalizeRoomProgress(raw, raw.scriptId),
    publicContent: normalizeRoomPublicContent(raw),
    characterSheets: normalizeRoomCharacterSheets(raw),
    scene: normalizeRoomScene(raw.scene, baseRoom.scene),
    scriptSnapshot,
    characters: Array.isArray(raw.characters) ? raw.characters.map((character) => clone(character)) : [],
    messages: Array.isArray(raw.messages) ? raw.messages.map((message) => clone(message)) : [],
    players: members.length,
    closeAt: raw.closeAt ?? null,
    phaseBeforeClose: normalizePhaseBeforeClose(raw, phase),
    online: phase === 'closed' ? false : raw.online ?? true,
    closedAt: raw.closedAt ?? null,
    updatedAt: raw.updatedAt ?? now(),
    voice: {
      epoch: raw.voice?.epoch ?? buildVoiceEpoch(),
      livekitConfigured: raw.voice?.livekitConfigured ?? false,
      participants: voiceParticipants,
    },
  } as RoomState;
  normalizeRoomMemberRoles(room);
  syncRoomMembers(room);
  syncRoomParticipants(room);
  syncRoomRoster(room);
  return room;
}

function normalizeScript(raw: Partial<TrpgScript>): TrpgScript | null {
  if (!raw.id || !raw.title) {
    return null;
  }
  const characters = Array.isArray(raw.characters)
    ? raw.characters.map((character) => normalizeScriptCharacterDraft(character)).slice(0, 200)
    : [];
  const charactersById = new Map(characters.map((character) => [character.id, character]));
  const maps = Array.isArray(raw.maps)
    ? raw.maps.map((map) => normalizeScriptMap(map, charactersById)).slice(0, 80)
    : [];
  const diceProfiles = normalizeDiceProfiles(raw.diceProfiles);
  const chapters = normalizeScriptChapters(raw.chapters, { characters, diceProfiles, maps });

  return {
    id: raw.id,
    title: raw.title,
    system: raw.system ?? 'COC 7th',
    visibility: raw.visibility ?? 'private',
    ownerId: raw.ownerId ?? systemOwnerId,
    ownerName: raw.ownerName ?? '未知作者',
    summary: raw.summary ?? '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    coverUrl: raw.coverUrl ?? '',
    maps,
    characters,
    diceProfiles,
    chapters,
    createdAt: raw.createdAt ?? now(),
    updatedAt: raw.updatedAt ?? now(),
    version: scriptVersion(raw.version),
  };
}

const tokenColors = ['#187a6d', '#b85f32', '#4f5d9f', '#9b5c9d', '#6a7842', '#9b6844'];

function sceneFromScriptMap(map: ScriptMap | undefined, fallbackName: string): RoomState['scene'] {
  const width = Math.max(4, Math.min(40, Math.round(map?.width ?? 12)));
  const height = Math.max(4, Math.min(30, Math.round(map?.height ?? 8)));
  const clampSceneX = (value: number) => Math.max(1, Math.min(width, Math.round(value)));
  const clampSceneY = (value: number) => Math.max(1, Math.min(height, Math.round(value)));
  const features = (map?.features ?? []).map((feature) => {
    const x = clampSceneX(feature.x);
    const y = clampSceneY(feature.y);
    return {
      ...clone(feature),
      x,
      y,
      w: Math.max(1, Math.min(width - x + 1, Math.round(feature.w || 1))),
      h: Math.max(1, Math.min(height - y + 1, Math.round(feature.h || 1))),
    };
  });
  const tokens = (map?.tokens ?? []).map((token) => ({
    ...clone(token),
    x: clampSceneX(token.x),
    y: clampSceneY(token.y),
  }));

  return {
    mapId: map?.id,
    name: map?.name ?? fallbackName,
    width,
    height,
    features,
    tokens,
  };
}

function bindSceneTokensToImportedCharacters(scene: RoomState['scene'], room: Pick<RoomState, 'characters'>) {
  const charactersByScriptId = new Map(
    room.characters
      .filter((character) => character.scriptCharacterId)
      .map((character) => [character.scriptCharacterId, character]),
  );
  return {
    ...scene,
    tokens: scene.tokens.map((token) => {
      const importedCharacter = charactersByScriptId.get(token.characterId);
      if (!importedCharacter) {
        return token;
      }
      return {
        ...token,
        characterId: importedCharacter.id,
        label: token.label || initials(importedCharacter.name).slice(0, 2),
      };
    }),
  };
}

function instantiateScriptRoom(script: TrpgScript) {
  const map = script.maps[0];
  const scriptSnapshot = normalizeScript(script) ?? clone(script);

  return {
    summary: script.summary,
    scriptSnapshot,
    scriptCharacters: script.characters.map((character) => normalizeScriptCharacterDraft(character)),
    diceProfiles: normalizeDiceProfiles(script.diceProfiles),
    scene: sceneFromScriptMap(map, script.title),
    progress: {
      scriptId: script.id,
      scriptVersion: script.version,
      activeMapId: map?.id,
    },
    publicContent: [],
    characters: [],
    characterSheets: [],
  };
}

function runtimeScriptForRoom(room: RoomState) {
  return room.scriptSnapshot ?? (room.scriptId ? scripts.get(room.scriptId) : undefined);
}

function freezeRoomScriptSnapshot(room: RoomState) {
  if (!room.scriptId) {
    room.scriptSnapshot = undefined;
    return false;
  }
  const sourceScript = scripts.get(room.scriptId);
  if (!sourceScript) {
    return false;
  }
  const snapshot = normalizeScript({
    ...sourceScript,
    summary: room.summary || sourceScript.summary,
    characters: room.scriptCharacters.length ? room.scriptCharacters : sourceScript.characters,
    diceProfiles: room.diceProfiles.length ? room.diceProfiles : sourceScript.diceProfiles,
  });
  if (!snapshot) {
    return false;
  }
  room.scriptSnapshot = snapshot;
  room.progress = {
    ...room.progress,
    scriptId: snapshot.id,
    scriptVersion: snapshot.version,
    activeMapId: room.progress.activeMapId ?? snapshot.maps[0]?.id,
  };
  return true;
}

function resetVolatileRoomPresenceAfterRestart() {
  const timestamp = Date.now();
  let changed = false;

  directCallSessions.forEach((session) => {
    queueStartupLiveKitRoomCleanup(session.roomName);
    if (isOpenDirectCallStatus(session.status)) {
      rotateDirectCallVoiceRoom(session);
      changed = true;
    }
  });

  rooms.forEach((room) => {
    if (room.members.length > 0 || room.voice.participants.length > 0) {
      room.members = [];
      room.voice = {
        ...room.voice,
        participants: [],
      };
      syncRoomMembers(room);
      changed = true;
    }

    if (room.online) {
      queueStartupLiveKitRoomCleanup(roomVoiceRoomName(room));
      rotateRoomVoiceEpoch(room);
      changed = true;
    }

    if (room.id !== seedRoomId && room.online && !room.closeAt) {
      scheduleRoomClosure(room, timestamp);
      changed = true;
    }
  });

  if (changed) {
    persistState();
  }
}

function readPersistedStateFile(filePath: string) {
  const raw = readFileSync(filePath, 'utf8');
  return {
    parsed: JSON.parse(raw) as Partial<PersistedState>,
    raw,
  };
}

function applyPersistedState(parsed: Partial<PersistedState>) {
  if (Array.isArray(parsed.accounts)) {
    accounts.clear();
    parsed.accounts.forEach((account) => {
      const normalized = normalizeAccount(account);
      if (normalized) {
        accounts.set(normalized.id, normalized);
      }
    });
  }
  if (Array.isArray(parsed.rooms) && parsed.rooms.length > 0) {
    rooms.clear();
    parsed.rooms.forEach((room) => {
      const normalized = normalizeRoom(room);
      if (normalized) {
        rooms.set(normalized.id, normalized);
      }
    });
  }
  if (Array.isArray(parsed.sessions)) {
    sessions.clear();
    parsed.sessions.forEach(([token, session]) => {
      const normalized = normalizeSessionEntry(token, session);
      if (normalized) {
        sessions.set(normalized[0], normalized[1]);
      }
    });
  }
  if (Array.isArray(parsed.friendships)) {
    friendships.clear();
    parsed.friendships.forEach((friendship) => {
      if (friendship.id && friendship.requesterId && friendship.addresseeId) {
        friendships.set(friendship.id, friendship);
      }
    });
  }
  if (Array.isArray(parsed.directMessages)) {
    directMessages.length = 0;
    parsed.directMessages.forEach((message) => {
      const normalized = normalizeDirectMessage(message);
      if (normalized) {
        directMessages.push(normalized);
      }
    });
  }
  if (Array.isArray(parsed.directReadStates)) {
    directReadStates.clear();
    parsed.directReadStates.forEach((state) => {
      const normalized = normalizeDirectReadState(state);
      if (normalized) {
        directReadStates.set(directReadKey(normalized.accountId, normalized.friendId), normalized);
      }
    });
  } else if (migrateLegacyDirectReadStates()) {
    persistState();
  }
  if (Array.isArray(parsed.directCallSessions)) {
    directCallSessions.clear();
    parsed.directCallSessions.forEach((session) => {
      const normalized = normalizeDirectCallSession(session);
      if (normalized) {
        directCallSessions.set(normalized.callId, normalized);
      }
    });
    if (pruneExpiredDirectCalls({ persist: false })) {
      persistState();
    }
  }
  if (Array.isArray(parsed.emailVerifications)) {
    emailVerifications.clear();
    parsed.emailVerifications.forEach((verification) => {
      const email = normalizeEmail(verification.email ?? '');
      if (email && verification.codeHash && verification.expiresAt) {
        emailVerifications.set(email, {
          email,
          codeHash: verification.codeHash,
          attempts: verification.attempts ?? 0,
          requestedAt: verification.requestedAt ?? now(),
          expiresAt: verification.expiresAt,
        });
      }
    });
    pruneExpiredEmailVerifications();
  }
  if (Array.isArray(parsed.scripts) && parsed.scripts.length > 0) {
    scripts.clear();
    parsed.scripts.forEach((script) => {
      const normalized = normalizeScript(script);
      if (normalized) {
        scripts.set(normalized.id, normalized);
      }
    });
  }
  resetVolatileRoomPresenceAfterRestart();
}

function loadPersistedState() {
  if (!existsSync(stateFile) && !existsSync(stateBackupFile)) {
    return;
  }

  try {
    const { parsed } = readPersistedStateFile(stateFile);
    applyPersistedState(parsed);
  } catch (primaryError) {
    if (!existsSync(stateBackupFile)) {
      console.warn('Failed to load persisted state; using seed data.', primaryError);
      return;
    }
    try {
      const { parsed, raw } = readPersistedStateFile(stateBackupFile);
      applyPersistedState(parsed);
      writeAtomicSync(stateFile, raw, persistVersion, false);
      console.warn('Recovered persisted state from backup after primary state load failed.', primaryError);
    } catch (backupError) {
      console.warn('Failed to load persisted state and backup; using seed data.', {
        primaryError,
        backupError,
      });
    }
  }
}

function buildPersistedState() {
  pruneExpiredEmailVerifications();
  pruneExpiredSessions();
  return {
    rooms: Array.from(rooms.values()),
    accounts: Array.from(accounts.values()),
    sessions: Array.from(sessions.entries()),
    friendships: Array.from(friendships.values()),
    directMessages,
    directReadStates: Array.from(directReadStates.values()),
    directCallSessions: Array.from(directCallSessions.values()),
    scripts: Array.from(scripts.values()),
    emailVerifications: Array.from(emailVerifications.values()),
  } satisfies PersistedState;
}

function persistTempFile(version: number) {
  return path.join(dataDir, `.state-${process.pid}-${version}-${Date.now()}.tmp`);
}

function fsyncDataDirSync() {
  try {
    const fd = openSync(dataDir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is not supported on every Windows filesystem.
  }
}

async function fsyncDataDir() {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(dataDir, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is best-effort and may be unsupported on Windows.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function backupExistingStateSync() {
  if (!existsSync(stateFile)) {
    return;
  }
  copyFileSync(stateFile, stateBackupFile);
}

async function backupExistingState() {
  if (!existsSync(stateFile)) {
    return;
  }
  await copyFile(stateFile, stateBackupFile);
}

function writeAtomicSync(filePath: string, contents: string, version: number, createBackup = true) {
  mkdirSync(dataDir, { recursive: true });
  const tempFile = persistTempFile(version);
  let fd: number | null = null;
  try {
    fd = openSync(tempFile, 'w');
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (createBackup) {
      backupExistingStateSync();
    }
    renameSync(tempFile, filePath);
    fsyncDataDirSync();
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures while preserving the original write error.
      }
    }
    rmSync(tempFile, { force: true });
    throw error;
  }
}

async function writeAtomic(filePath: string, contents: string, version: number) {
  mkdirSync(dataDir, { recursive: true });
  const tempFile = persistTempFile(version);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempFile, 'w');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await backupExistingState();
    await rename(tempFile, filePath);
    await fsyncDataDir();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

function writePersistedStateSync() {
  const state = buildPersistedState();
  writeAtomicSync(stateFile, JSON.stringify(state, null, 2), persistVersion);
  persistDirty = false;
}

async function writePersistedStateAsync(version: number) {
  const state = buildPersistedState();
  await writeAtomic(stateFile, JSON.stringify(state, null, 2), version);
  if (persistVersion === version) {
    persistDirty = false;
  }
}

function flushPersistState() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistDirty) {
    writePersistedStateSync();
  }
}

function registerPersistExitFlush() {
  if (persistExitFlushRegistered || syncPersistEnabled) {
    return;
  }
  persistExitFlushRegistered = true;
  process.once('beforeExit', flushPersistState);
}

function persistState() {
  persistDirty = true;
  persistVersion += 1;
  if (syncPersistEnabled) {
    flushPersistState();
    return;
  }

  registerPersistExitFlush();
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const writeVersion = persistVersion;
    persistWriteChain = persistWriteChain
      .then(() => writePersistedStateAsync(writeVersion))
      .catch((error) => {
        console.warn('Failed to persist state asynchronously.', error);
        persistDirty = true;
      });
  }, persistDebounceMs);
}

function touch(room: RoomState) {
  room.updatedAt = now();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.round(value), min), max);
}

function previewText(value: string | undefined, maxLength: number) {
  const text = (value ?? '').trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function summarizeScriptCharacterPreviews(room: RoomState) {
  return room.scriptCharacters.slice(0, 8).map((character) => ({
    id: character.id,
    name: character.name,
    count: character.count,
    occupation: character.occupation,
    publicSummary: previewText(character.publicSummary, 180),
  }));
}

function summarize(room: RoomState, account?: Account | null): RoomSummary {
  return {
    id: room.id,
    name: room.name,
    system: room.system,
    phase: room.phase,
    visibility: room.visibility,
    ownerId: room.ownerId,
    ownerName: room.ownerName,
    players: room.players,
    updatedAt: room.updatedAt,
    scriptId: room.scriptId,
    summary: previewText(room.summary, 600),
    scriptCharacterPreviews: summarizeScriptCharacterPreviews(room),
    online: room.online,
    closedAt: room.closedAt,
    closeAt: room.closeAt,
    canJoin: canJoinRoom(account, room),
  };
}

function summarizeScript(script: TrpgScript, account?: Account | null): TrpgScriptSummary {
  return {
    id: script.id,
    title: script.title,
    system: script.system,
    visibility: script.visibility,
    ownerId: script.ownerId,
    ownerName: script.ownerName,
    summary: script.summary,
    tags: script.tags,
    updatedAt: script.updatedAt,
    version: script.version,
    canEdit: Boolean(account && account.id === script.ownerId),
  };
}

function findAccountByEmail(email: string) {
  const normalized = normalizeEmail(email);
  return Array.from(accounts.values()).find((account) => account.email === normalized) ?? null;
}

function sessionExpiryFromNow() {
  return new Date(Date.now() + sessionTtlMs).toISOString();
}

function normalizeSessionEntry(tokenKey: string, value: string | StoredSession): [string, StoredSession] | null {
  const accountId = typeof value === 'string' ? value : value.accountId;
  if (!accountId || !accounts.has(accountId)) {
    return null;
  }

  const tokenHash = tokenKey.startsWith('sha256:') ? tokenKey : hashSessionToken(tokenKey);
  const expiresAt = typeof value === 'string' ? sessionExpiryFromNow() : value.expiresAt || sessionExpiryFromNow();
  if (Date.parse(expiresAt) <= Date.now()) {
    return null;
  }

  return [
    tokenHash,
    {
      accountId,
      createdAt: typeof value === 'string' ? now() : value.createdAt || now(),
      expiresAt,
    },
  ];
}

function pruneExpiredSessions() {
  const timestamp = Date.now();
  let changed = false;
  sessions.forEach((session, tokenHash) => {
    if (Date.parse(session.expiresAt) <= timestamp || !accounts.has(session.accountId)) {
      sessions.delete(tokenHash);
      changed = true;
    }
  });
  return changed;
}

function hashEmailVerificationCode(email: string, code: string) {
  return createHmac('sha256', emailVerificationSecret).update(`${normalizeEmail(email)}:${code.trim()}`).digest('hex');
}

function pruneExpiredEmailVerifications() {
  const timestamp = Date.now();
  emailVerifications.forEach((verification, email) => {
    if (Date.parse(verification.expiresAt) <= timestamp) {
      emailVerifications.delete(email);
    }
  });
}

function findFriendship(accountId: string, otherId: string) {
  return (
    Array.from(friendships.values()).find(
      (friendship) =>
        (friendship.requesterId === accountId && friendship.addresseeId === otherId) ||
        (friendship.requesterId === otherId && friendship.addresseeId === accountId),
    ) ?? null
  );
}

function areFriends(accountId: string, otherId: string) {
  if (accountId === otherId) {
    return true;
  }
  return findFriendship(accountId, otherId)?.status === 'accepted';
}

function sweepExpiredRoomsInternal() {
  const timestamp = Date.now();
  let changed = false;
  const closedRooms: ClosedRoomEvent[] = [];

  rooms.forEach((room) => {
    if (room.id !== seedRoomId && room.online && room.members.length === 0 && !room.closeAt) {
      scheduleRoomClosure(room, timestamp);
      changed = true;
      return;
    }

    if (room.closeAt && Date.parse(room.closeAt) <= timestamp) {
      const liveKitRoomName = roomVoiceRoomName(room);
      closeOnlineRoom(room, timestamp);
      const event = { id: room.id, roomId: room.id, online: false, closedAt: room.closedAt, liveKitRoomName };
      closedRooms.push(event);
      pendingClosedRoomEvents.set(room.id, event);
      changed = true;
    }
  });

  if (changed) {
    persistState();
  }

  return closedRooms;
}

function drainClosedRoomEvents() {
  const events = Array.from(pendingClosedRoomEvents.values()).map((room) => clone(room));
  pendingClosedRoomEvents.clear();
  return events;
}

function applyRoomPresence(room: RoomState, account: Account) {
  const member = room.members.find((item) => item.accountId === account.id);
  if (!member) {
    return null;
  }

  member.displayName = account.displayName;
  member.avatar = account.avatar;
  member.lastSeenAt = now();
  clearRoomClosure(room);
  syncRoomMembers(room);
  touch(room);
  persistState();
  return exposeRoom(room, account);
}

function canAccessClosedRoom(account: Account | null | undefined, room: RoomState) {
  return Boolean(
    account &&
      !room.hiddenForAccountIds.includes(account.id) &&
      (account.id === room.ownerId || room.participantIds.includes(account.id)),
  );
}

function roomMessageHistoryCutoff(room: RoomState, account: Pick<Account, 'id'>) {
  if (room.online || room.ownerId === account.id || room.memberIds.includes(account.id)) {
    return null;
  }
  const participant = room.participants.find((member) => member.accountId === account.id);
  return participant?.leftAt ?? null;
}

function canAccessRoom(account: Account | null | undefined, room: RoomState) {
  if (!room.online) {
    return canAccessClosedRoom(account, room);
  }
  if (room.visibility === 'public') {
    return true;
  }
  if (!account) {
    return false;
  }
  return room.ownerId === account.id || room.participantIds.includes(account.id) || areFriends(account.id, room.ownerId);
}

function canJoinRoom(account: Account | null | undefined, room: RoomState) {
  if (!account) {
    return false;
  }
  if (!room.online) {
    return canAccessClosedRoom(account, room);
  }
  if (!canAccessRoom(account, room)) {
    return false;
  }
  if (account.id === room.ownerId || room.memberIds.includes(account.id) || room.rosterIds.includes(account.id)) {
    return true;
  }
  if (room.invitedAccountIds.includes(account.id)) {
    return true;
  }
  if (room.participantIds.includes(account.id)) {
    return room.phase === 'recruiting';
  }
  return room.phase === 'recruiting';
}

type RoomListStatus = 'online' | 'closed' | 'all';

function shouldListRoom(room: RoomState, account?: Account | null, status: RoomListStatus = 'online') {
  if (status === 'online' && !room.online) {
    return false;
  }

  if (status === 'online' && room.online && room.members.length === 0 && room.closeAt) {
    return false;
  }

  if (status === 'closed' && room.online) {
    return false;
  }

  if (!room.online) {
    return canAccessClosedRoom(account, room);
  }

  if (room.visibility === 'public') {
    return true;
  }

  return canAccessRoom(account, room);
}

function canMessageFriend(accountId: string, friendId: string) {
  return accountId !== friendId && accounts.has(accountId) && accounts.has(friendId) && areFriends(accountId, friendId);
}

function buildDirectCallId() {
  return `call-${randomBytes(16).toString('hex')}`;
}

function directVoiceRoomName(accountId: string, friendId: string, callId: string, recoveryEpoch?: string) {
  const participants = [accountId, friendId].sort().join(':');
  const digest = createHash('sha256').update(`${participants}:${callId}:${recoveryEpoch ?? 'initial'}`).digest('hex').slice(0, 32);
  return `direct:${digest}`;
}

function resetDirectVoiceHandoffState(session: StoredDirectCallSession) {
  delete session.callerVoiceTokenIssuedAt;
  delete session.calleeVoiceTokenIssuedAt;
  delete session.callerVoiceReadyAt;
  delete session.calleeVoiceReadyAt;
}

function rotateDirectCallVoiceRoom(session: StoredDirectCallSession) {
  session.roomName = directVoiceRoomName(session.callerId, session.calleeId, session.callId, buildVoiceEpoch());
  resetDirectVoiceHandoffState(session);
}

function exposeDirectCallSession(session: StoredDirectCallSession) {
  return clone(session);
}

function directCallEventFromSession(session: StoredDirectCallSession, status: DirectCallEvent['status']): DirectCallEvent | null {
  const caller = accounts.get(session.callerId);
  const callee = accounts.get(session.calleeId);
  if (!caller || !callee) {
    return null;
  }
  return {
    callId: session.callId,
    fromId: caller.id,
    fromName: caller.displayName,
    fromAvatar: caller.avatar,
    toId: callee.id,
    toName: callee.displayName,
    toAvatar: callee.avatar,
    status,
    createdAt: session.updatedAt,
  };
}

function queueDirectCallEvent(session: StoredDirectCallSession, status: DirectCallEvent['status']) {
  const event = directCallEventFromSession(session, status);
  if (event) {
    pendingDirectCallEvents.set(`${session.callId}:${status}`, {
      ...event,
      liveKitRoomName: session.roomName,
    });
  }
}

function isOpenDirectCallStatus(status: DirectCallSessionStatus) {
  return status === 'ringing' || status === 'accepted';
}

function directCallParticipantMatch(session: StoredDirectCallSession, accountId: string, friendId: string) {
  return (
    (session.callerId === accountId && session.calleeId === friendId) ||
    (session.callerId === friendId && session.calleeId === accountId)
  );
}

function markDirectCallParticipantSeen(session: StoredDirectCallSession, accountId: string, timestamp: number) {
  const seenAt = new Date(timestamp).toISOString();
  if (session.callerId === accountId) {
    session.callerLastSeenAt = seenAt;
  }
  if (session.calleeId === accountId) {
    session.calleeLastSeenAt = seenAt;
  }
}

function refreshAcceptedDirectCallExpiry(session: StoredDirectCallSession, timestamp = Date.now()) {
  const callerSeen = Date.parse(session.callerLastSeenAt ?? session.updatedAt);
  const calleeSeen = Date.parse(session.calleeLastSeenAt ?? session.updatedAt);
  const oldestSeen = Math.min(
    Number.isFinite(callerSeen) ? callerSeen : timestamp,
    Number.isFinite(calleeSeen) ? calleeSeen : timestamp,
  );
  session.expiresAt = new Date(oldestSeen + directCallAcceptedLeaseMs).toISOString();
}

function pruneExpiredDirectCalls(options: { timestamp?: number; persist?: boolean } = {}) {
  const timestamp = options.timestamp ?? Date.now();
  let changed = false;
  directCallSessions.forEach((session) => {
    if (!isOpenDirectCallStatus(session.status)) {
      if (Date.parse(session.updatedAt) + directCallTerminalRetentionMs <= timestamp) {
        directCallSessions.delete(session.callId);
        changed = true;
      }
      return;
    }
    if (session.status === 'accepted') {
      refreshAcceptedDirectCallExpiry(session, timestamp);
    }
    if (Date.parse(session.expiresAt) > timestamp) {
      return;
    }
    session.status = 'expired';
    session.updatedAt = new Date(timestamp).toISOString();
    queueDirectCallEvent(session, 'ended');
    changed = true;
  });
  if (changed && options.persist !== false) {
    persistState();
  }
  return changed;
}

function hasOpenDirectCall(accountId: string, exceptCallId?: string) {
  pruneExpiredDirectCalls();
  return Array.from(directCallSessions.values()).some(
    (session) =>
      session.callId !== exceptCallId &&
      isOpenDirectCallStatus(session.status) &&
      (session.callerId === accountId || session.calleeId === accountId),
  );
}

function hasAcceptedDirectCall(accountId: string, exceptCallId?: string) {
  pruneExpiredDirectCalls();
  return Array.from(directCallSessions.values()).some(
    (session) =>
      session.callId !== exceptCallId &&
      session.status === 'accepted' &&
      (session.callerId === accountId || session.calleeId === accountId),
  );
}

function hasDirectVoiceReadyCall(accountId: string, exceptCallId?: string) {
  pruneExpiredDirectCalls();
  return Array.from(directCallSessions.values()).some(
    (session) =>
      session.callId !== exceptCallId &&
      session.status === 'accepted' &&
      (
        (session.callerId === accountId && Boolean(session.callerVoiceReadyAt)) ||
        (session.calleeId === accountId && Boolean(session.calleeVoiceReadyAt))
      ),
  );
}

function hasDirectVoiceTokenIssued(session: StoredDirectCallSession, accountId: string) {
  return session.callerId === accountId
    ? Boolean(session.callerVoiceTokenIssuedAt)
    : session.calleeId === accountId
      ? Boolean(session.calleeVoiceTokenIssuedAt)
      : false;
}

function directCallEventStatus(session: StoredDirectCallSession): DirectCallEvent['status'] {
  return session.status === 'expired' ? 'ended' : session.status;
}

function getDirectCallSyncEventForAccount(accountId: string) {
  pruneExpiredDirectCalls();
  const session = Array.from(directCallSessions.values())
    .filter((item) => item.callerId === accountId || item.calleeId === accountId)
    .sort((a, b) => {
      const openDelta = Number(isOpenDirectCallStatus(b.status)) - Number(isOpenDirectCallStatus(a.status));
      return openDelta || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    })[0];
  if (!session) {
    return null;
  }
  return directCallEventFromSession(session, directCallEventStatus(session));
}

function hasRoomVoiceParticipant(accountId: string) {
  return Array.from(rooms.values()).some(
    (room) => room.online && room.voice.participants.some((participant) => participant.id === accountId),
  );
}

function closeDirectCallsBetween(accountId: string, friendId: string) {
  pruneExpiredDirectCalls();
  let changed = false;
  directCallSessions.forEach((session) => {
    if (isOpenDirectCallStatus(session.status) && directCallParticipantMatch(session, accountId, friendId)) {
      session.status = 'ended';
      session.updatedAt = now();
      queueDirectCallEvent(session, 'ended');
      changed = true;
    }
  });
  if (changed) {
    persistState();
  }
}

function drainDirectCallEvents() {
  const events = Array.from(pendingDirectCallEvents.values()).map((event) => clone(event));
  pendingDirectCallEvents.clear();
  return events;
}

function directConversation(accountId: string, friendId: string) {
  return directMessages
    .filter(
      (message) =>
        (message.fromId === accountId && message.toId === friendId) ||
        (message.fromId === friendId && message.toId === accountId),
    );
}

function directReadKey(accountId: string, friendId: string) {
  return `${accountId}:${friendId}`;
}

function normalizeDirectReadState(raw: Partial<StoredDirectReadState>): StoredDirectReadState | null {
  if (!raw.accountId || !raw.friendId || !raw.lastReadAt) {
    return null;
  }
  if (!accounts.has(raw.accountId) || !accounts.has(raw.friendId) || Number.isNaN(Date.parse(raw.lastReadAt))) {
    return null;
  }
  return {
    accountId: raw.accountId,
    friendId: raw.friendId,
    lastReadAt: raw.lastReadAt,
    lastReadMessageId: raw.lastReadMessageId?.trim() || undefined,
  };
}

function normalizeDirectCallStatus(value: unknown): DirectCallSessionStatus {
  return value === 'ringing' ||
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'ended' ||
    value === 'expired'
    ? value
    : 'ended';
}

function validOptionalIsoDate(value: unknown) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function normalizeDirectCallSession(raw: Partial<StoredDirectCallSession>): StoredDirectCallSession | null {
  const callId = raw.callId?.trim();
  const callerId = raw.callerId?.trim();
  const calleeId = raw.calleeId?.trim();
  if (!callId || !callerId || !calleeId || callerId === calleeId) {
    return null;
  }
  if (!canMessageFriend(callerId, calleeId)) {
    return null;
  }

  const createdAt = validOptionalIsoDate(raw.createdAt) ?? now();
  const updatedAt = validOptionalIsoDate(raw.updatedAt) ?? createdAt;
  const expiresAt = validOptionalIsoDate(raw.expiresAt) ?? updatedAt;
  const status = normalizeDirectCallStatus(raw.status);
  if (!isOpenDirectCallStatus(status) && Date.parse(updatedAt) + directCallTerminalRetentionMs <= Date.now()) {
    return null;
  }

  return {
    callId,
    callerId,
    calleeId,
    roomName: raw.roomName?.trim() || directVoiceRoomName(callerId, calleeId, callId),
    status,
    createdAt,
    updatedAt,
    expiresAt,
    callerVoiceTokenIssuedAt: validOptionalIsoDate(raw.callerVoiceTokenIssuedAt),
    calleeVoiceTokenIssuedAt: validOptionalIsoDate(raw.calleeVoiceTokenIssuedAt),
    callerVoiceReadyAt: validOptionalIsoDate(raw.callerVoiceReadyAt),
    calleeVoiceReadyAt: validOptionalIsoDate(raw.calleeVoiceReadyAt),
    callerLastSeenAt: validOptionalIsoDate(raw.callerLastSeenAt),
    calleeLastSeenAt: validOptionalIsoDate(raw.calleeLastSeenAt),
  };
}

function directReadState(accountId: string, friendId: string) {
  return directReadStates.get(directReadKey(accountId, friendId)) ?? null;
}

function setDirectReadAt(accountId: string, friendId: string, timestamp: string, messageId?: string) {
  const parsedTimestamp = Date.parse(timestamp);
  if (Number.isNaN(parsedTimestamp)) {
    return null;
  }
  const key = directReadKey(accountId, friendId);
  const current = directReadStates.get(key);
  if (current) {
    const currentTimestamp = Date.parse(current.lastReadAt);
    if (currentTimestamp > parsedTimestamp) {
      return current;
    }
    if (currentTimestamp === parsedTimestamp && current.lastReadMessageId && messageId?.trim()) {
      const conversation = directConversation(accountId, friendId);
      const currentIndex = conversation.findIndex((message) => message.id === current.lastReadMessageId);
      const nextIndex = conversation.findIndex((message) => message.id === messageId.trim());
      if (currentIndex >= 0 && nextIndex >= 0 && currentIndex > nextIndex) {
        return current;
      }
    }
  }
  const next = { accountId, friendId, lastReadAt: timestamp, lastReadMessageId: messageId?.trim() || current?.lastReadMessageId };
  directReadStates.set(key, next);
  return next;
}

function migrateLegacyDirectReadStates() {
  let changed = false;
  friendships.forEach((friendship) => {
    if (friendship.status !== 'accepted') {
      return;
    }
    const conversation = directConversation(friendship.requesterId, friendship.addresseeId);
    const latest = conversation.at(-1);
    if (!latest) {
      return;
    }
    ([friendship.requesterId, friendship.addresseeId] as const).forEach((accountId) => {
      const friendId = accountId === friendship.requesterId ? friendship.addresseeId : friendship.requesterId;
      const key = directReadKey(accountId, friendId);
      if (!directReadStates.has(key)) {
        directReadStates.set(key, {
          accountId,
          friendId,
          lastReadAt: latest.createdAt,
          lastReadMessageId: latest.id,
        });
        changed = true;
      }
    });
  });
  return changed;
}

function findActiveMemberRoom(accountId: string) {
  return (
    Array.from(rooms.values()).find(
      (room) => room.online && room.members.some((member) => member.accountId === accountId),
    ) ?? null
  );
}

function normalizeDirectMessage(raw: Partial<DirectMessage>): DirectMessage | null {
  const text = raw.text?.trim();
  if (!raw.id || !raw.fromId || !raw.toId || !text || !raw.createdAt) {
    return null;
  }
  if (!accounts.has(raw.fromId) || !accounts.has(raw.toId)) {
    return null;
  }

  return {
    id: raw.id,
    clientMessageId: raw.clientMessageId?.trim() || undefined,
    fromId: raw.fromId,
    toId: raw.toId,
    text,
    replyTo: raw.replyTo?.id && raw.replyTo.author?.trim() && raw.replyTo.text?.trim()
      ? {
          id: raw.replyTo.id,
          author: raw.replyTo.author.trim(),
          text: raw.replyTo.text.trim().slice(0, 160),
        }
      : undefined,
    createdAt: raw.createdAt,
  };
}

function summarizeFriend(currentId: string, friendship: StoredFriendship): FriendSummary | null {
  const otherId = friendship.requesterId === currentId ? friendship.addresseeId : friendship.requesterId;
  const other = accounts.get(otherId);
  if (!other) {
    return null;
  }
  const direction =
    friendship.status === 'accepted'
      ? 'friend'
      : friendship.requesterId === currentId
        ? 'outgoing'
        : 'incoming';
  const conversation = directConversation(currentId, otherId);
  const lastMessage = conversation.at(-1);
  const readState = directReadState(currentId, otherId);
  const lastReadAt = readState?.lastReadAt;
  const lastReadTimestamp = lastReadAt ? Date.parse(lastReadAt) : 0;
  const lastReadIndex = readState?.lastReadMessageId
    ? conversation.findIndex((message) => message.id === readState.lastReadMessageId)
    : -1;
  const unreadCount = friendship.status === 'accepted'
    ? conversation.filter((message, index) => {
        if (message.toId !== currentId) {
          return false;
        }
        if (lastReadIndex >= 0) {
          return index > lastReadIndex;
        }
        return !lastReadAt || Date.parse(message.createdAt) > lastReadTimestamp;
      }).length
    : 0;

  return {
    ...safeAccount(other),
    status: friendship.status,
    direction,
    unreadCount,
    lastReadAt,
    lastReadMessageId: readState?.lastReadMessageId,
    lastMessage: lastMessage ? clone(lastMessage) : undefined,
  };
}

function defaultScriptInput(owner: Account, title = '新建跑团剧本'): TrpgScript {
  const createdAt = now();
  return {
    id: buildId('script'),
    title,
    system: 'COC 7th',
    visibility: 'private',
    ownerId: owner.id,
    ownerName: owner.displayName,
    summary: '',
    tags: [],
    coverUrl: '',
    maps: [{ id: buildId('map'), name: '初始地图', width: 12, height: 8, notes: '' }],
    characters: [
      {
        id: buildId('sc'),
        name: '主角/NPC',
        count: 1,
        parameters: 'HP 10 / SAN 50',
        story: '',
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
  };
}

function findScriptBlock(script: TrpgScript, chapterId: string, blockId: string) {
  const chapter = script.chapters.find((item) => item.id === chapterId);
  const block = chapter?.blocks.find((item) => item.id === blockId);
  if (!chapter || !block) {
    return null;
  }
  return { chapter, block };
}

function trimPublicationText(value: string, maxLength = 12000) {
  return value.trim().slice(0, maxLength);
}

function compactLines(lines: Array<string | undefined>) {
  return lines.map((line) => line?.trim()).filter(Boolean).join('\n');
}

const roomBriefingBlockId = '__room_public_briefing';
const roomRolePackBlockId = '__room_public_role_pack';

function publicRolePackMarkdown(room: Pick<RoomState, 'scriptCharacters'>) {
  return room.scriptCharacters
    .filter((character) => character.name.trim() && (character.publicSummary ?? '').trim())
    .map((character, index) => compactLines([
      `${index + 1}. ${character.name}${character.count > 1 ? `（名额 ${character.count}）` : ''}`,
      character.occupation ? `职业倾向：${character.occupation}` : undefined,
      character.publicSummary ? `公开人设：${character.publicSummary}` : undefined,
      character.recommendedSkills?.length
        ? `推荐技能：${character.recommendedSkills.map((skill) => `${skill.name}${skill.base ? ` ${skill.base}` : ''}`).join('、')}`
        : undefined,
    ]))
    .join('\n\n');
}

function upsertSeededPublicContent(
  room: RoomState,
  account: Account,
  input: Pick<RoomPublicContent, 'type' | 'title' | 'markdown'> & { blockId: string },
) {
  const markdown = trimPublicationText(input.markdown);
  if (!markdown) {
    return false;
  }
  const existingIndex = room.publicContent.findIndex((item) => item.source?.blockId === input.blockId);
  const previous = existingIndex >= 0 ? room.publicContent[existingIndex] : null;
  const publication: RoomPublicContent = {
    id: previous?.id ?? buildId('public'),
    type: input.type,
    title: input.title,
    markdown,
    source: {
      scriptId: room.scriptId,
      scriptVersion: room.progress.scriptVersion,
      blockId: input.blockId,
    },
    createdBy: account.id,
    createdByName: account.displayName,
    createdAt: previous?.createdAt ?? now(),
  };
  if (existingIndex >= 0) {
    room.publicContent[existingIndex] = publication;
  } else {
    room.publicContent.push(publication);
    if (room.publicContent.length > maxRoomPublicContent) {
      room.publicContent.splice(0, room.publicContent.length - maxRoomPublicContent);
    }
  }
  return true;
}

function seedRoomPublicBriefing(room: RoomState, account: Account) {
  const briefingChanged = upsertSeededPublicContent(room, account, {
    blockId: roomBriefingBlockId,
    type: 'narrative',
    title: '开场公开剧情',
    markdown: room.summary,
  });
  const rolePackChanged = upsertSeededPublicContent(room, account, {
    blockId: roomRolePackBlockId,
    type: 'character',
    title: '公开角色人设',
    markdown: publicRolePackMarkdown(room),
  });
  return briefingChanged || rolePackChanged;
}

function publicationFromScriptBlock(
  script: TrpgScript,
  chapter: ScriptChapter,
  block: ScriptBlock,
  account: Pick<Account, 'id' | 'displayName'>,
): Omit<RoomPublicContent, 'id' | 'createdAt'> {
  const source = {
    scriptId: script.id,
    scriptVersion: script.version,
    chapterId: chapter.id,
    blockId: block.id,
  };

  if (block.type === 'map') {
    const map = script.maps.find((item) => item.id === block.mapId);
    return {
      type: 'map',
      title: block.title.trim() || map?.name || '场景切换',
      markdown: trimPublicationText(compactLines([
        block.notes,
        map?.notes ? `地图备注：${map.notes}` : undefined,
        map ? `当前场景：${map.name}` : undefined,
      ]) || `当前场景：${map?.name ?? '未知地图'}`),
      source: { ...source, mapId: block.mapId },
      createdBy: account.id,
      createdByName: account.displayName,
    };
  }

  if (block.type === 'character') {
    const character = script.characters.find((item) => item.id === block.characterId);
    return {
      type: 'character',
      title: block.title.trim() || character?.name || '公开角色信息',
      markdown: trimPublicationText(compactLines([
        block.notes,
        character?.publicSummary,
        character?.occupation ? `职业倾向：${character.occupation}` : undefined,
      ]) || 'KP公开了一条角色信息。'),
      source: { ...source, characterId: block.characterId },
      createdBy: account.id,
      createdByName: account.displayName,
    };
  }

  if (block.type === 'check') {
    const dice = script.diceProfiles.find((item) => item.id === block.diceId);
    return {
      type: 'check',
      title: block.title.trim() || '公开判定',
      markdown: trimPublicationText(compactLines([
        dice ? `骰子：${dice.label}（${dice.formula}）` : '骰子：未找到关联骰子',
        `难度：${block.difficulty}`,
        'KP已公开一个判定，请玩家按提示行动。',
      ])),
      source: { ...source, diceId: block.diceId },
      createdBy: account.id,
      createdByName: account.displayName,
    };
  }

  return {
    type: 'narrative',
    title: block.title.trim() || '公开剧情',
    markdown: trimPublicationText(block.markdown || 'KP公开了一段剧情。'),
    source,
    createdBy: account.id,
    createdByName: account.displayName,
  };
}

function publicationMessageText(publication: Pick<RoomPublicContent, 'type' | 'title' | 'markdown'>) {
  const prefix = publication.type === 'map'
    ? '场景切换'
    : publication.type === 'check'
      ? '公开判定'
      : publication.type === 'character'
        ? '公开角色'
        : '公开剧情';
  const body = publication.markdown.length > 800 ? `${publication.markdown.slice(0, 800)}...` : publication.markdown;
  return `【${prefix}】${publication.title}\n${body}`.slice(0, 2000);
}

loadPersistedState();

export const store = {
  emailVerificationPolicy: {
    ttlSeconds: Math.floor(emailVerificationTtlMs / 1000),
    cooldownSeconds: Math.floor(emailVerificationCooldownMs / 1000),
    maxAttempts: maxEmailVerificationAttempts,
  },

  flushPersistState,

  recoverVolatileRoomPresenceAfterRestart() {
    resetVolatileRoomPresenceAfterRestart();
  },

  drainStartupLiveKitRoomCleanupRooms() {
    return drainStartupLiveKitRoomCleanupRooms();
  },

  hasAccount(email: string) {
    return Boolean(findAccountByEmail(email));
  },

  canRequestRegistrationCode(emailInput: string) {
    pruneExpiredEmailVerifications();
    const email = normalizeEmail(emailInput);
    if (!email) {
      return { ok: false as const, error: 'Invalid email' as const };
    }
    if (findAccountByEmail(email)) {
      return { ok: false as const, error: 'Email already exists' as const };
    }

    const existing = emailVerifications.get(email);
    const nextAllowedAt = existing ? Date.parse(existing.requestedAt) + emailVerificationCooldownMs : 0;
    const waitMs = nextAllowedAt - Date.now();
    if (existing && waitMs > 0) {
      return {
        ok: false as const,
        error: 'Verification code requested too frequently' as const,
        retryAfterSeconds: Math.ceil(waitMs / 1000),
      };
    }

    return { ok: true as const, email };
  },

  saveRegistrationCode(emailInput: string, code: string) {
    const email = normalizeEmail(emailInput);
    if (!email || findAccountByEmail(email)) {
      return null;
    }

    const requestedAt = now();
    const verification: StoredEmailVerification = {
      email,
      codeHash: hashEmailVerificationCode(email, code),
      attempts: 0,
      requestedAt,
      expiresAt: new Date(Date.now() + emailVerificationTtlMs).toISOString(),
    };
    emailVerifications.set(email, verification);
    persistState();
    return clone(verification);
  },

  issueRegistrationCode(emailInput: string, code: string) {
    pruneExpiredEmailVerifications();
    const email = normalizeEmail(emailInput);
    if (!email) {
      return { ok: false as const, error: 'Invalid email' as const };
    }
    if (findAccountByEmail(email)) {
      return { ok: false as const, error: 'Email already exists' as const };
    }

    const existing = emailVerifications.get(email);
    const nextAllowedAt = existing ? Date.parse(existing.requestedAt) + emailVerificationCooldownMs : 0;
    const waitMs = nextAllowedAt - Date.now();
    if (existing && waitMs > 0) {
      return {
        ok: false as const,
        error: 'Verification code requested too frequently' as const,
        retryAfterSeconds: Math.ceil(waitMs / 1000),
      };
    }

    const requestedAt = now();
    const verification: StoredEmailVerification = {
      email,
      codeHash: hashEmailVerificationCode(email, code),
      attempts: 0,
      requestedAt,
      expiresAt: new Date(Date.now() + emailVerificationTtlMs).toISOString(),
    };
    emailVerifications.set(email, verification);
    persistState();
    return { ok: true as const, email, verification: clone(verification) };
  },

  issuePasswordResetCode(emailInput: string, code: string) {
    pruneExpiredEmailVerifications();
    const email = normalizeEmail(emailInput);
    if (!email) {
      return { ok: false as const, error: 'Invalid email' as const };
    }
    if (!findAccountByEmail(email)) {
      return { ok: false as const, error: 'Account not found' as const };
    }

    const existing = emailVerifications.get(email);
    const nextAllowedAt = existing ? Date.parse(existing.requestedAt) + emailVerificationCooldownMs : 0;
    const waitMs = nextAllowedAt - Date.now();
    if (existing && waitMs > 0) {
      return {
        ok: false as const,
        error: 'Verification code requested too frequently' as const,
        retryAfterSeconds: Math.ceil(waitMs / 1000),
      };
    }

    const requestedAt = now();
    const verification: StoredEmailVerification = {
      email,
      codeHash: hashEmailVerificationCode(email, code),
      attempts: 0,
      requestedAt,
      expiresAt: new Date(Date.now() + emailVerificationTtlMs).toISOString(),
    };
    emailVerifications.set(email, verification);
    persistState();
    return { ok: true as const, email, verification: clone(verification) };
  },

  deleteRegistrationCode(emailInput: string) {
    const email = normalizeEmail(emailInput);
    const deleted = emailVerifications.delete(email);
    if (deleted) {
      persistState();
    }
    return deleted;
  },

  verifyRegistrationCode(emailInput: string, codeInput: string) {
    pruneExpiredEmailVerifications();
    const email = normalizeEmail(emailInput);
    const code = codeInput.trim();
    const verification = emailVerifications.get(email);
    if (!email || !code || !verification) {
      return { ok: false as const, error: 'Verification code is invalid or expired' as const };
    }
    if (Date.parse(verification.expiresAt) <= Date.now()) {
      emailVerifications.delete(email);
      persistState();
      return { ok: false as const, error: 'Verification code is invalid or expired' as const };
    }
    if (verification.attempts >= maxEmailVerificationAttempts) {
      emailVerifications.delete(email);
      persistState();
      return { ok: false as const, error: 'Too many verification attempts' as const };
    }
    if (verification.codeHash !== hashEmailVerificationCode(email, code)) {
      verification.attempts += 1;
      if (verification.attempts >= maxEmailVerificationAttempts) {
        emailVerifications.delete(email);
      }
      persistState();
      return { ok: false as const, error: 'Verification code is invalid or expired' as const };
    }

    emailVerifications.delete(email);
    persistState();
    return { ok: true as const };
  },

  registerAccount(input: {
    email: string;
    displayName: string;
    password: string;
    role?: UserRole;
    avatar?: string;
  }): AuthSession | null {
    const email = normalizeEmail(input.email);
    if (!email || findAccountByEmail(email)) {
      return null;
    }

    const displayName = input.displayName.trim() || email.split('@')[0];
    const account: StoredAccount = {
      id: buildId('acct'),
      email,
      displayName,
      avatar: input.avatar?.trim() || initials(displayName),
      role: input.role ?? 'player',
      createdAt: now(),
      lastSeenAt: now(),
      passwordHash: hashPassword(input.password),
    };

    accounts.set(account.id, account);
    persistState();
    return this.createSession(account);
  },

  resetPassword(input: { email: string; password: string; verificationCode: string }) {
    const verified = this.verifyRegistrationCode(input.email, input.verificationCode);
    if (!verified.ok) {
      return { ok: false as const, error: verified.error };
    }

    const account = findAccountByEmail(input.email);
    if (!account) {
      return { ok: false as const, error: 'Account not found' as const };
    }

    account.passwordHash = hashPassword(input.password);
    account.lastSeenAt = now();
    this.revokeAccountSessions(account.id);
    persistState();
    return { ok: true as const, account: safeAccount(account) };
  },

  loginAccount(input: { email: string; password: string }): AuthSession | null {
    const account = findAccountByEmail(input.email);
    if (!account || !verifyPassword(input.password, account.passwordHash)) {
      return null;
    }

    if (isLegacyPasswordHash(account.passwordHash)) {
      account.passwordHash = hashPassword(input.password);
    }
    account.lastSeenAt = now();
    persistState();
    return this.createSession(account);
  },

  createSession(account: StoredAccount): AuthSession {
    const token = randomBytes(32).toString('hex');
    sessions.set(hashSessionToken(token), {
      accountId: account.id,
      createdAt: now(),
      expiresAt: sessionExpiryFromNow(),
    });
    persistState();

    return {
      token,
      account: safeAccount(account),
    };
  },

  getAccountByToken(token: string | undefined) {
    if (!token) {
      return null;
    }

    const tokenHash = hashSessionToken(token);
    const session = sessions.get(tokenHash);
    if (!session) {
      return null;
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      sessions.delete(tokenHash);
      persistState();
      return null;
    }

    const account = accounts.get(session.accountId);
    if (!account) {
      sessions.delete(tokenHash);
      persistState();
      return null;
    }

    account.lastSeenAt = now();
    return safeAccount(account);
  },

  verifyAccountPassword(accountId: string, password: string) {
    const account = accounts.get(accountId);
    return account ? verifyPassword(password, account.passwordHash) : false;
  },

  revokeSession(token: string | undefined) {
    if (!token) {
      return false;
    }

    const changed = sessions.delete(hashSessionToken(token));
    if (changed) {
      persistState();
    }
    return changed;
  },

  revokeAccountSessions(accountId: string, exceptToken?: string) {
    const exceptTokenHash = exceptToken ? hashSessionToken(exceptToken) : '';
    let changed = false;
    sessions.forEach((session, tokenHash) => {
      if (session.accountId === accountId && tokenHash !== exceptTokenHash) {
        sessions.delete(tokenHash);
        changed = true;
      }
    });
    if (changed) {
      persistState();
    }
    return changed;
  },

  updateProfile(
    accountId: string,
    input: { displayName?: string; avatar?: string; password?: string },
  ) {
    const account = accounts.get(accountId);
    if (!account) {
      return null;
    }

    if (input.displayName !== undefined) {
      account.displayName = input.displayName.trim() || account.displayName;
    }
    if (input.avatar !== undefined) {
      account.avatar = input.avatar.trim() || initials(account.displayName);
    }
    if (input.password) {
      account.passwordHash = hashPassword(input.password);
    }

    rooms.forEach((room) => {
      if (room.ownerId === account.id) {
        room.ownerName = account.displayName;
        room.keeper = account.displayName;
      }
      const member = room.members.find((item) => item.accountId === account.id);
      if (member) {
        member.displayName = account.displayName;
        member.avatar = account.avatar;
        member.lastSeenAt = account.lastSeenAt;
        syncRoomMembers(room);
      }
      const participant = room.participants.find((item) => item.accountId === account.id);
      if (participant) {
        participant.displayName = account.displayName;
        participant.avatar = account.avatar;
        participant.lastSeenAt = account.lastSeenAt;
        syncRoomParticipants(room);
      }
      const rosterMember = room.roster.find((item) => item.accountId === account.id);
      if (rosterMember) {
        rosterMember.displayName = account.displayName;
        rosterMember.avatar = account.avatar;
        rosterMember.lastSeenAt = account.lastSeenAt;
        syncRoomRoster(room);
      }
      const voiceParticipant = room.voice.participants.find((item) => item.id === account.id);
      if (voiceParticipant) {
        voiceParticipant.name = account.displayName;
      }
    });
    scripts.forEach((script) => {
      if (script.ownerId === account.id) {
        script.ownerName = account.displayName;
      }
    });
    persistState();
    return safeAccount(account);
  },

  listAccountRoomIds(accountId: string) {
    return Array.from(rooms.values())
      .filter(
        (room) =>
          room.ownerId === accountId ||
          room.memberIds.includes(accountId) ||
          room.participantIds.includes(accountId) ||
          room.rosterIds.includes(accountId),
      )
      .map((room) => room.id);
  },

  listFriends(accountId: string) {
    return Array.from(friendships.values())
      .filter((friendship) => friendship.requesterId === accountId || friendship.addresseeId === accountId)
      .map((friendship) => summarizeFriend(accountId, friendship))
      .filter((item): item is FriendSummary => Boolean(item))
      .sort((a, b) => {
        const directionRank = { incoming: 0, friend: 1, outgoing: 2 };
        const rankDiff = directionRank[a.direction] - directionRank[b.direction];
        if (rankDiff !== 0) {
          return rankDiff;
        }
        if (a.direction === 'friend') {
          const unreadDiff = b.unreadCount - a.unreadCount;
          if (unreadDiff !== 0) {
            return unreadDiff;
          }
          const aMessageAt = a.lastMessage ? Date.parse(a.lastMessage.createdAt) : 0;
          const bMessageAt = b.lastMessage ? Date.parse(b.lastMessage.createdAt) : 0;
          if (aMessageAt !== bMessageAt) {
            return bMessageAt - aMessageAt;
          }
        }
        if (a.direction === b.direction) {
          return a.displayName.localeCompare(b.displayName);
        }
        return 0;
      });
  },

  requestFriend(accountId: string, targetEmail: string) {
    const target = findAccountByEmail(targetEmail);
    if (!target || target.id === accountId) {
      return null;
    }

    const existing = findFriendship(accountId, target.id);
    if (existing) {
      return summarizeFriend(accountId, existing);
    }

    const friendship: StoredFriendship = {
      id: buildId('friend'),
      requesterId: accountId,
      addresseeId: target.id,
      status: 'pending',
      createdAt: now(),
      updatedAt: now(),
    };
    friendships.set(friendship.id, friendship);
    persistState();
    return summarizeFriend(accountId, friendship);
  },

  acceptFriend(accountId: string, friendId: string) {
    const friendship = Array.from(friendships.values()).find(
      (item) =>
        item.requesterId === friendId && item.addresseeId === accountId && item.status === 'pending',
    );
    if (!friendship) {
      return null;
    }

    friendship.status = 'accepted';
    friendship.updatedAt = now();
    persistState();
    return summarizeFriend(accountId, friendship);
  },

  removeFriend(accountId: string, friendId: string) {
    const friendship = findFriendship(accountId, friendId);
    if (!friendship) {
      return false;
    }
    closeDirectCallsBetween(accountId, friendId);
    friendships.delete(friendship.id);
    directReadStates.delete(directReadKey(accountId, friendId));
    directReadStates.delete(directReadKey(friendId, accountId));
    persistState();
    return true;
  },

  canMessageFriend(accountId: string, friendId: string) {
    return canMessageFriend(accountId, friendId);
  },

  sweepExpiredDirectCalls() {
    pruneExpiredDirectCalls();
    return drainDirectCallEvents();
  },

  getDirectCallSyncForAccount(accountId: string) {
    return getDirectCallSyncEventForAccount(accountId);
  },

  getDirectCallEvent(callId: string, status?: DirectCallEvent['status']) {
    pruneExpiredDirectCalls();
    const session = directCallSessions.get(callId);
    if (!session) {
      return null;
    }
    return directCallEventFromSession(session, status ?? directCallEventStatus(session));
  },

  getDirectCallLiveKitRoomName(callId: string) {
    pruneExpiredDirectCalls();
    return directCallSessions.get(callId)?.roomName ?? null;
  },

  getRoomVoiceLiveKitTargetsForAccount(accountId: string) {
    sweepExpiredRoomsInternal();
    return Array.from(rooms.values())
      .filter(
        (room) =>
          room.online &&
          room.voice.participants.some((participant) => participant.id === accountId),
      )
      .map((room) => ({ roomId: room.id, roomName: roomVoiceRoomName(room) }));
  },

  leaveAllVoiceForAccount(accountId: string) {
    sweepExpiredRoomsInternal();
    const changedRooms: RoomState[] = [];
    rooms.forEach((room) => {
      if (!room.voice.participants.some((participant) => participant.id === accountId)) {
        return;
      }
      removeRoomVoiceParticipant(room, accountId);
      touch(room);
      changedRooms.push(exposeRoom(room, accountId));
    });
    if (changedRooms.length > 0) {
      persistState();
    }
    return changedRooms;
  },

  createDirectCall(accountId: string, friendId: string, callIdInput?: string) {
    pruneExpiredDirectCalls();
    if (!canMessageFriend(accountId, friendId)) {
      return { ok: false as const, error: 'Friend access required' as const };
    }
    if (hasOpenDirectCall(accountId) || hasOpenDirectCall(friendId)) {
      return { ok: false as const, error: 'A voice call is already active' as const };
    }

    const callId = callIdInput?.trim() || buildDirectCallId();
    if (directCallSessions.has(callId)) {
      return { ok: false as const, error: 'Call already exists' as const };
    }

    const timestamp = Date.now();
    const createdAt = new Date(timestamp).toISOString();
    const session: StoredDirectCallSession = {
      callId,
      callerId: accountId,
      calleeId: friendId,
      roomName: directVoiceRoomName(accountId, friendId, callId),
      status: 'ringing',
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(timestamp + directCallRingTtlMs).toISOString(),
    };
    directCallSessions.set(callId, session);
    persistState();
    return { ok: true as const, session: exposeDirectCallSession(session) };
  },

  acceptDirectCall(accountId: string, friendId: string, callId: string) {
    pruneExpiredDirectCalls();
    if (!canMessageFriend(accountId, friendId)) {
      return { ok: false as const, error: 'Friend access required' as const };
    }
    const session = directCallSessions.get(callId);
    if (!session || !directCallParticipantMatch(session, accountId, friendId)) {
      return { ok: false as const, error: 'Call not found' as const };
    }
    if (session.calleeId !== accountId || session.callerId !== friendId) {
      return { ok: false as const, error: 'Only the callee can accept this call' as const };
    }
    if (session.status !== 'ringing') {
      return { ok: false as const, error: 'Call is not ringing' as const };
    }
    if (hasOpenDirectCall(accountId, callId) || hasOpenDirectCall(friendId, callId)) {
      return { ok: false as const, error: 'A voice call is already active' as const };
    }

    const timestamp = Date.now();
    session.status = 'accepted';
    session.updatedAt = new Date(timestamp).toISOString();
    markDirectCallParticipantSeen(session, session.callerId, timestamp);
    markDirectCallParticipantSeen(session, session.calleeId, timestamp);
    refreshAcceptedDirectCallExpiry(session, timestamp);
    persistState();
    return { ok: true as const, session: exposeDirectCallSession(session) };
  },

  heartbeatDirectCall(accountId: string, friendId: string, callId: string) {
    pruneExpiredDirectCalls();
    if (!canMessageFriend(accountId, friendId)) {
      return { ok: false as const, error: 'Friend access required' as const };
    }
    const session = directCallSessions.get(callId);
    if (!session || !directCallParticipantMatch(session, accountId, friendId)) {
      return { ok: false as const, error: 'Call not found' as const };
    }
    if (session.status !== 'accepted') {
      return { ok: false as const, error: 'Call is not connected' as const };
    }

    const timestamp = Date.now();
    markDirectCallParticipantSeen(session, accountId, timestamp);
    session.updatedAt = new Date(timestamp).toISOString();
    refreshAcceptedDirectCallExpiry(session, timestamp);
    persistState();
    return { ok: true as const, session: exposeDirectCallSession(session) };
  },

  markDirectCallVoiceTokenIssued(accountId: string, friendId: string, callId: string) {
    pruneExpiredDirectCalls();
    if (!canMessageFriend(accountId, friendId)) {
      return { ok: false as const, error: 'Friend access required' as const };
    }
    const session = directCallSessions.get(callId);
    if (!session || !directCallParticipantMatch(session, accountId, friendId)) {
      return { ok: false as const, error: 'Call not found' as const };
    }
    if (session.status !== 'accepted') {
      return { ok: false as const, error: 'Call is not connected' as const };
    }

    const timestamp = Date.now();
    const issuedAt = new Date(timestamp).toISOString();
    if (session.callerId === accountId) {
      session.callerVoiceTokenIssuedAt = session.callerVoiceTokenIssuedAt ?? issuedAt;
    }
    if (session.calleeId === accountId) {
      session.calleeVoiceTokenIssuedAt = session.calleeVoiceTokenIssuedAt ?? issuedAt;
    }
    session.updatedAt = issuedAt;
    markDirectCallParticipantSeen(session, accountId, timestamp);
    refreshAcceptedDirectCallExpiry(session, timestamp);
    persistState();
    return { ok: true as const, session: exposeDirectCallSession(session) };
  },

  markDirectCallVoiceReady(accountId: string, friendId: string, callId: string) {
    pruneExpiredDirectCalls();
    if (!canMessageFriend(accountId, friendId)) {
      return { ok: false as const, error: 'Friend access required' as const };
    }
    const session = directCallSessions.get(callId);
    if (!session || !directCallParticipantMatch(session, accountId, friendId)) {
      return { ok: false as const, error: 'Call not found' as const };
    }
    if (session.status !== 'accepted') {
      return { ok: false as const, error: 'Call is not connected' as const };
    }
    if (!hasDirectVoiceTokenIssued(session, accountId)) {
      return { ok: false as const, error: 'Join direct voice first' as const };
    }

    const timestamp = Date.now();
    const readyAt = new Date(timestamp).toISOString();
    if (session.callerId === accountId) {
      session.callerVoiceReadyAt = session.callerVoiceReadyAt ?? readyAt;
    }
    if (session.calleeId === accountId) {
      session.calleeVoiceReadyAt = session.calleeVoiceReadyAt ?? readyAt;
    }
    session.updatedAt = readyAt;
    markDirectCallParticipantSeen(session, accountId, timestamp);
    refreshAcceptedDirectCallExpiry(session, timestamp);
    persistState();
    return { ok: true as const, session: exposeDirectCallSession(session) };
  },

  rejectDirectCall(accountId: string, friendId: string, callId: string) {
    pruneExpiredDirectCalls();
    if (!canMessageFriend(accountId, friendId)) {
      return { ok: false as const, error: 'Friend access required' as const };
    }
    const session = directCallSessions.get(callId);
    if (!session || !directCallParticipantMatch(session, accountId, friendId)) {
      return { ok: false as const, error: 'Call not found' as const };
    }
    if (session.calleeId !== accountId || session.callerId !== friendId) {
      return { ok: false as const, error: 'Only the callee can reject this call' as const };
    }
    if (session.status !== 'ringing') {
      return { ok: false as const, error: 'Call is not ringing' as const };
    }

    session.status = 'rejected';
    session.updatedAt = now();
    persistState();
    return { ok: true as const, session: exposeDirectCallSession(session) };
  },

  endDirectCall(accountId: string, friendId: string, callId: string) {
    pruneExpiredDirectCalls();
    if (!canMessageFriend(accountId, friendId)) {
      return { ok: false as const, error: 'Friend access required' as const };
    }
    const session = directCallSessions.get(callId);
    if (!session || !directCallParticipantMatch(session, accountId, friendId)) {
      return { ok: false as const, error: 'Call not found' as const };
    }
    if (!isOpenDirectCallStatus(session.status) && session.status !== 'ended') {
      return { ok: false as const, error: 'Call is not active' as const };
    }

    if (session.status !== 'ended') {
      session.status = 'ended';
      session.updatedAt = now();
      persistState();
    }
    return { ok: true as const, session: exposeDirectCallSession(session) };
  },

  getDirectCallVoiceRoomName(
    accountId: string,
    friendId: string,
    callId: string,
    options: { allowRoomVoiceHandoff?: boolean } = {},
  ) {
    pruneExpiredDirectCalls();
    if (!canMessageFriend(accountId, friendId)) {
      return { ok: false as const, error: 'Friend access required' as const };
    }
    const session = directCallSessions.get(callId);
    if (!session || !directCallParticipantMatch(session, accountId, friendId)) {
      return { ok: false as const, error: 'Call not found' as const };
    }
    if (session.status !== 'accepted') {
      return { ok: false as const, error: 'Call is not connected' as const };
    }
    if (!options.allowRoomVoiceHandoff && hasRoomVoiceParticipant(accountId)) {
      return { ok: false as const, error: 'Leave room voice before joining direct call' as const };
    }
    return { ok: true as const, roomName: session.roomName };
  },

  markDirectMessagesRead(accountId: string, friendId: string, lastReadMessageId?: string) {
    if (!canMessageFriend(accountId, friendId)) {
      return null;
    }

    const conversation = directConversation(accountId, friendId);
    const requestedMessageId = lastReadMessageId?.trim();
    const latest = requestedMessageId
      ? conversation.find((message) => message.id === requestedMessageId)
      : conversation.at(-1);
    if (requestedMessageId && (!latest || latest.fromId === accountId)) {
      return null;
    }
    setDirectReadAt(accountId, friendId, latest?.createdAt ?? now(), latest?.id);
    persistState();
    const friendship = findFriendship(accountId, friendId);
    return friendship ? summarizeFriend(accountId, friendship) : null;
  },

  listDirectMessages(accountId: string, friendId: string) {
    if (!canMessageFriend(accountId, friendId)) {
      return null;
    }

    return directConversation(accountId, friendId)
      .slice(-500)
      .map((message) => clone(message));
  },

  listDirectMessagePage(
    accountId: string,
    friendId: string,
    options: { limit?: number; before?: string } = {},
  ): DirectMessagePage | null {
    if (!canMessageFriend(accountId, friendId)) {
      return null;
    }

    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const before = options.before?.trim();
    const conversation = directConversation(accountId, friendId);
    const beforeIndex = before ? conversation.findIndex((message) => message.id === before) : -1;
    if (before && beforeIndex < 0) {
      return {
        messages: [],
        hasMore: false,
      };
    }
    const scoped = beforeIndex >= 0
      ? conversation.slice(0, beforeIndex)
      : conversation;
    const start = Math.max(0, scoped.length - limit);
    return {
      messages: scoped.slice(start).map((message) => clone(message)),
      hasMore: start > 0,
    };
  },

  getDirectMessageByClientMessageId(accountId: string, friendId: string, clientMessageId?: string) {
    if (!canMessageFriend(accountId, friendId)) {
      return null;
    }

    const id = clientMessageId?.trim();
    if (!id) {
      return null;
    }

    const message = directConversation(accountId, friendId).find(
      (item) => item.fromId === accountId && item.clientMessageId === id,
    );
    return message ? clone(message) : null;
  },

  getDirectMessageReference(accountId: string, friendId: string, replyToId?: string) {
    if (!replyToId) {
      return { ok: true as const, replyTo: undefined };
    }
    if (!canMessageFriend(accountId, friendId)) {
      return { ok: false as const, error: 'Friend access required' };
    }

    const message = directConversation(accountId, friendId).find((item) => item.id === replyToId);
    if (!message) {
      return { ok: false as const, error: 'Reply target not found' };
    }
    const author = accounts.get(message.fromId);
    return {
      ok: true as const,
      replyTo: {
        id: message.id,
        author: author?.displayName ?? '好友',
        text: message.text.slice(0, 160),
      },
    };
  },

  addDirectMessage(
    accountId: string,
    friendId: string,
    text: string,
    clientMessageId?: string,
    replyTo?: DirectMessage['replyTo'],
  ) {
    if (!canMessageFriend(accountId, friendId)) {
      return null;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    const idempotencyKey = clientMessageId?.trim();
    const conversation = directConversation(accountId, friendId);
    if (idempotencyKey) {
      const existing = conversation.find(
        (message) => message.fromId === accountId && message.clientMessageId === idempotencyKey,
      );
      if (existing) {
        return clone(existing);
      }
    }

    const replyToId = replyTo?.id?.trim();
    const referencedMessage = replyToId
      ? conversation.find((message) => message.id === replyToId)
      : undefined;
    if (replyTo && !referencedMessage) {
      return null;
    }
    const replyAuthor = referencedMessage ? accounts.get(referencedMessage.fromId) : undefined;
    const normalizedReplyTo = referencedMessage
      ? {
          id: referencedMessage.id,
          author: replyAuthor?.displayName ?? '好友',
          text: referencedMessage.text.slice(0, 160),
        }
      : undefined;

    const message: DirectMessage = {
      id: buildId('dm'),
      clientMessageId: idempotencyKey || undefined,
      fromId: accountId,
      toId: friendId,
      text: trimmed,
      replyTo: normalizedReplyTo,
      createdAt: now(),
    };
    directMessages.push(message);
    setDirectReadAt(accountId, friendId, message.createdAt, message.id);
    persistState();
    return clone(message);
  },

  inviteRoomFriend(roomId: string, account: Account, friendId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    const friend = accounts.get(friendId);
    if (!room || !friend) {
      return { ok: false as const, error: 'Not found' as const };
    }
    if (!room.online) {
      return { ok: false as const, error: 'Room is closed' as const };
    }
    if (!room.memberIds.includes(account.id) && room.ownerId !== account.id) {
      return { ok: false as const, error: 'Only room members can invite friends' as const };
    }
    if (room.visibility === 'private' && room.ownerId !== account.id) {
      return { ok: false as const, error: 'Only the room owner can invite friends to a private room' as const };
    }
    if (!areFriends(account.id, friendId)) {
      return { ok: false as const, error: 'Invitee must be your friend' as const };
    }
    if (room.visibility === 'private' && !areFriends(room.ownerId, friendId)) {
      return { ok: false as const, error: 'Private room invitee must be the owner friend' as const };
    }

    if (!room.invitedAccountIds.includes(friendId)) {
      room.invitedAccountIds.push(friendId);
    }
    upsertRoomParticipant(room, safeAccount(friend), 'player', { includeRoster: false });
    touch(room);
    persistState();
    return { ok: true as const, room: exposeRoom(room, account) };
  },

  updateRoomPreparation(
    roomId: string,
    account: Account,
    input: { summary?: string; scriptCharacters?: Partial<ScriptCharacter>[] },
  ) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false as const, error: 'Room not found' as const };
    }
    if (!isRoomOwner(room, account.id)) {
      return { ok: false as const, error: 'Only the keeper can edit room preparation' as const };
    }
    if (!['module_locked', 'module_editing'].includes(room.phase)) {
      return { ok: false as const, error: 'Room preparation is editable before recruitment starts' as const };
    }

    if (input.summary !== undefined) {
      room.summary = input.summary.trim().slice(0, 4000);
    }
    if (input.scriptCharacters !== undefined) {
      const existingById = new Map(room.scriptCharacters.map((character) => [character.id, character]));
      room.scriptCharacters = input.scriptCharacters
        .slice(0, 60)
        .map((character) => normalizeScriptCharacterDraft(character, character.id ? existingById.get(character.id) : undefined))
        .filter((character) => character.name);
    }

    touch(room);
    persistState();
    return { ok: true as const, room: exposeRoom(room, account) };
  },

  updateRoomPhase(roomId: string, account: Account, phase: RoomPhase) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false as const, error: '房间不存在' as const };
    }
    if (!isRoomOwner(room, account.id)) {
      return { ok: false as const, error: '只有 KP 可以推进跑团流程。' as const };
    }
    if (!roomPhases.includes(phase)) {
      return { ok: false as const, error: '无效的跑团阶段。' as const };
    }
    const currentIndex = flowPhaseOrder.indexOf(room.phase);
    const nextIndex = flowPhaseOrder.indexOf(phase);
    if (phase === 'closed') {
      return { ok: false as const, error: '请通过房间关闭或删除流程关闭房间。' as const };
    }
    if (room.phase === 'closed') {
      return { ok: false as const, error: '请先重新开启房间，再推进跑团流程。' as const };
    }
    if (phase === room.phase) {
      return { ok: true as const, room: exposeRoom(room, account) };
    }
    if (currentIndex >= 0 && nextIndex >= 0 && nextIndex < currentIndex) {
      return { ok: false as const, error: '跑团流程不能倒退。' as const };
    }
    if (!allowedRoomPhaseTransitions[room.phase]?.includes(phase)) {
      return { ok: false as const, error: '跑团流程需要按模组确认、招募、车卡、审核、选角导入、开团的顺序推进。' as const };
    }
    if (phase === 'recruiting') {
      const readiness = validateRecruitmentReadiness(room);
      if (!readiness.ok) {
        return readiness;
      }
      freezeRoomScriptSnapshot(room);
      seedRoomPublicBriefing(room, account);
    }
    if (phase === 'chargen' || phase === 'review' || phase === 'casting' || phase === 'playing') {
      const readiness = validateRoomPhaseReadiness(room, phase);
      if (!readiness.ok) {
        return readiness;
      }
    }
    if (phase === 'playing') {
      const imported = this.importApprovedSheets(roomId, account);
      if (!imported.ok) {
        return imported;
      }
      return imported;
    }
    room.phase = phase;
    touch(room);
    persistState();
    return { ok: true as const, room: exposeRoom(room, account) };
  },

  revealRoomScriptBlock(roomId: string, account: Account, input: { chapterId: string; blockId: string }) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false as const, error: '房间不存在' as const };
    }
    if (!isRoomOwner(room, account.id)) {
      return { ok: false as const, error: '只有 KP 可以公开剧本内容。' as const };
    }
    if (!room.online || room.phase !== 'playing') {
      return { ok: false as const, error: '只有开团后才能使用主持执行器。' as const };
    }
    if (!room.scriptId) {
      return { ok: false as const, error: '房间没有关联剧本。' as const };
    }
    const script = runtimeScriptForRoom(room);
    if (!script) {
      return { ok: false as const, error: '关联剧本不存在或已被删除。' as const };
    }
    const found = findScriptBlock(script, input.chapterId, input.blockId);
    if (!found) {
      return { ok: false as const, error: '剧本章节或内容块不存在。' as const };
    }
    const { chapter, block } = found;
    if (block.type === 'map') {
      const map = script.maps.find((item) => item.id === block.mapId);
      if (!map) {
        return { ok: false as const, error: '剧本地图不存在。' as const };
      }
      room.scene = bindSceneTokensToImportedCharacters(sceneFromScriptMap(map, script.title), room);
    }

    const publicationBase = publicationFromScriptBlock(script, chapter, block, account);
    const existingIndex = room.publicContent.findIndex(
      (item) =>
        item.source?.scriptId === script.id &&
        item.source?.chapterId === chapter.id &&
        item.source?.blockId === block.id,
    );
    const previous = existingIndex >= 0 ? room.publicContent[existingIndex] : null;
    const publication: RoomPublicContent = {
      ...publicationBase,
      id: previous?.id ?? buildId('public'),
      createdAt: previous?.createdAt ?? now(),
    };
    if (existingIndex >= 0) {
      room.publicContent[existingIndex] = publication;
    } else {
      room.publicContent.push(publication);
      if (room.publicContent.length > maxRoomPublicContent) {
        room.publicContent.splice(0, room.publicContent.length - maxRoomPublicContent);
      }
      room.messages.push({
        id: buildId('msg'),
        roomId: room.id,
        clientMessageId: `script-publication:${script.id}:${chapter.id}:${block.id}`,
        senderId: account.id,
        messageType: 'chat',
        author: account.displayName,
        role: 'keeper',
        text: publicationMessageText(publication),
        createdAt: now(),
      });
    }

    room.progress = {
      ...room.progress,
      scriptId: script.id,
      scriptVersion: script.version,
      currentChapterId: chapter.id,
      currentBlockId: block.id,
      activeMapId: block.type === 'map' ? block.mapId : room.scene.mapId ?? room.progress.activeMapId,
      updatedBy: account.id,
      updatedAt: now(),
    };
    touch(room);
    persistState();
    return { ok: true as const, room: exposeRoom(room, account), publication };
  },

  switchRoomScriptMap(roomId: string, account: Account, input: { mapId: string }) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false as const, error: '房间不存在' as const };
    }
    if (!isRoomOwner(room, account.id)) {
      return { ok: false as const, error: '只有 KP 可以切换剧本地图。' as const };
    }
    if (!room.online || room.phase !== 'playing') {
      return { ok: false as const, error: '只有开团后才能切换剧本地图。' as const };
    }
    if (!room.scriptId) {
      return { ok: false as const, error: '房间没有关联剧本。' as const };
    }
    const script = runtimeScriptForRoom(room);
    if (!script) {
      return { ok: false as const, error: '关联剧本不存在或已被删除。' as const };
    }
    const map = script.maps.find((item) => item.id === input.mapId);
    if (!map) {
      return { ok: false as const, error: '剧本地图不存在。' as const };
    }

    room.scene = bindSceneTokensToImportedCharacters(sceneFromScriptMap(map, script.title), room);
    room.progress = {
      ...room.progress,
      scriptId: script.id,
      scriptVersion: script.version,
      activeMapId: map.id,
      updatedBy: account.id,
      updatedAt: now(),
    };
    touch(room);
    persistState();
    return { ok: true as const, room: exposeRoom(room, account) };
  },

  upsertCharacterSheet(roomId: string, account: Account, input: Partial<CharacterSheet>) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room || !canAccessRoom(account, room)) {
      return { ok: false as const, error: room ? 'Join an online room first' : 'Room not found' };
    }
    const member = room.members.find((item) => item.accountId === account.id);
    if (!member) {
      return { ok: false as const, error: 'Join an online room first' };
    }
    if (isRoomOwner(room, account.id)) {
      return { ok: false as const, error: 'Keepers review sheets; players create them' };
    }
    if (!isActiveRosterPlayer(room, account.id)) {
      return { ok: false as const, error: 'Only active roster players can edit character sheets' };
    }
    if (!['chargen', 'review'].includes(room.phase)) {
      return { ok: false as const, error: 'Character sheets are editable during chargen and review' };
    }
    if (input.scriptCharacterId && !room.scriptCharacters.some((character) => character.id === input.scriptCharacterId)) {
      return { ok: false as const, error: 'Selected script character no longer exists' };
    }

    const existing = room.characterSheets.find((sheet) => sheet.ownerId === account.id && sheet.id === input.id)
      ?? room.characterSheets.find((sheet) => sheet.ownerId === account.id);
    const base = existing ?? buildCharacterSheet({ ownerId: account.id, ownerName: account.displayName });
    if (existing && existing.status === 'submitted') {
      return { ok: false as const, error: '角色卡已提交，等待 KP 审核；如需修改请等待 KP 驳回。' };
    }
    if (existing && existing.status === 'approved') {
      return { ok: false as const, error: '角色卡已通过，不能继续编辑。' };
    }
    const next = normalizeCharacterSheet({
      ...base,
      ...input,
      id: base.id,
      ownerId: account.id,
      ownerName: account.displayName,
      status: input.status === 'submitted' ? 'submitted' : 'draft',
      confirmedAt: undefined,
      updatedAt: now(),
    });
    const index = room.characterSheets.findIndex((sheet) => sheet.id === next.id);
    if (index >= 0) {
      room.characterSheets[index] = next;
    } else {
      room.characterSheets.push(next);
    }
    touch(room);
    persistState();
    return { ok: true as const, sheet: clone(next), room: exposeRoom(room, account), validation: validateCharacterSheet(next) };
  },

  submitCharacterSheet(roomId: string, account: Account, input: Partial<CharacterSheet>) {
    const saved = this.upsertCharacterSheet(roomId, account, { ...input, status: 'submitted' });
    if (!saved.ok) {
      return saved;
    }
    const validation = validateCharacterSheet(saved.sheet);
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false as const, error: 'Room not found' };
    }
    const scriptCharacterChoice = validateScriptCharacterChoice(room, saved.sheet, { includeSubmitted: true });
    const validationResult = scriptCharacterChoice.ok
      ? validation
      : { ...validation, ok: false, errors: [...validation.errors, scriptCharacterChoice.error] };
    const index = room.characterSheets.findIndex((sheet) => sheet.id === saved.sheet.id);
    if (index >= 0) {
      room.characterSheets[index] = validationResult.ok
        ? applySheetStatus(saved.sheet, 'submitted')
        : applySheetStatus(saved.sheet, 'rejected', { id: 'system', notes: validationResult.errors.join('；') });
    }
    touch(room);
    persistState();
    return { ok: true as const, sheet: clone(room.characterSheets[index]), room: exposeRoom(room, account), validation: validationResult };
  },

  confirmCharacterSheet(roomId: string, account: Account) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room || !canAccessRoom(account, room)) {
      return { ok: false as const, error: room ? 'Join an online room first' : 'Room not found' };
    }
    if (!room.online || room.phase !== 'review') {
      return { ok: false as const, error: '角色卡只能在 KP 审核阶段确认。' };
    }
    if (isRoomOwner(room, account.id)) {
      return { ok: false as const, error: 'Keepers review sheets; players confirm their own sheet' };
    }
    if (!isActiveRosterPlayer(room, account.id)) {
      return { ok: false as const, error: 'Only active roster players can confirm character sheets' };
    }
    const index = room.characterSheets.findIndex((sheet) => sheet.ownerId === account.id);
    if (index < 0) {
      return { ok: false as const, error: 'Character sheet not found' as const };
    }
    const sheet = room.characterSheets[index];
    if (sheet.status !== 'approved') {
      return { ok: false as const, error: '只有 KP 通过后的角色卡才能确认。' };
    }
    if (!sheet.confirmedAt) {
      room.characterSheets[index] = normalizeCharacterSheet({
        ...sheet,
        confirmedAt: now(),
        updatedAt: now(),
      });
      touch(room);
      persistState();
    }
    return { ok: true as const, sheet: clone(room.characterSheets[index]), room: exposeRoom(room, account) };
  },

  reviewCharacterSheet(roomId: string, account: Account, sheetId: string, input: { status: CharacterSheetStatus; reviewerNotes?: string }) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false as const, error: 'Room not found' as const };
    }
    if (!isRoomOwner(room, account.id)) {
      return { ok: false as const, error: 'Only the keeper can review sheets' as const };
    }
    if (!room.online || room.phase !== 'review') {
      return { ok: false as const, error: 'Character sheets can only be reviewed during the review phase' as const };
    }
    const index = room.characterSheets.findIndex((sheet) => sheet.id === sheetId);
    if (index < 0) {
      return { ok: false as const, error: 'Character sheet not found' as const };
    }
    if (!isActiveRosterPlayer(room, room.characterSheets[index].ownerId)) {
      return { ok: false as const, error: 'Only active roster player sheets can be reviewed' as const };
    }
    if (room.characterSheets[index].status !== 'submitted') {
      return { ok: false as const, error: 'Only submitted character sheets can be reviewed' as const };
    }
    const nextStatus = input.status === 'approved' ? 'approved' : 'rejected';
    const validation = validateCharacterSheet(room.characterSheets[index]);
    const scriptCharacterChoice = nextStatus === 'approved'
      ? validateScriptCharacterChoice(room, room.characterSheets[index])
      : { ok: true as const };
    const validationResult = scriptCharacterChoice.ok
      ? validation
      : { ...validation, ok: false, errors: [...validation.errors, scriptCharacterChoice.error] };
    if (nextStatus === 'approved' && !validationResult.ok) {
      room.characterSheets[index] = applySheetStatus(room.characterSheets[index], 'rejected', {
        id: account.id,
        notes: validationResult.errors.join('；'),
      });
    } else {
      room.characterSheets[index] = applySheetStatus(room.characterSheets[index], nextStatus, {
        id: account.id,
        notes: input.reviewerNotes,
      });
    }
    touch(room);
    persistState();
    return { ok: true as const, sheet: clone(room.characterSheets[index]), room: exposeRoom(room, account), validation: validationResult };
  },

  importApprovedSheets(roomId: string, account: Account) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false as const, error: 'Room not found' as const };
    }
    if (!isRoomOwner(room, account.id)) {
      return { ok: false as const, error: 'Only the keeper can import approved sheets' as const };
    }
    if (!['casting', 'playing'].includes(room.phase)) {
      return { ok: false as const, error: 'Approved sheets can be imported during casting' as const };
    }
    const readiness = validateRoomPhaseReadiness(room, 'playing');
    if (!readiness.ok) {
      return readiness;
    }
    const activePlayerIds = recruitedPlayerIds(room);
    const approved = room.characterSheets.filter(
      (sheet) => activePlayerIds.has(sheet.ownerId) && sheet.status === 'approved' && sheet.confirmedAt,
    );
    if (approved.length === 0) {
      return { ok: false as const, error: 'No confirmed approved sheet to import' as const };
    }
    for (const sheet of approved) {
      const choice = validateScriptCharacterChoice(room, sheet);
      if (!choice.ok) {
        return { ok: false as const, error: choice.error };
      }
    }
    approved.forEach((sheet, index) => {
      const statBlock = statBlockFromSheet(sheet);
      const existingIndex = room.characters.findIndex((item) => item.sheetId === sheet.id);
      const existing = existingIndex >= 0 ? room.characters[existingIndex] : null;
      const character: Character = {
        id: existing?.id ?? buildId('char'),
        accountId: sheet.ownerId,
        sheetId: sheet.id,
        scriptCharacterId: sheet.scriptCharacterId,
        name: sheet.name,
        player: sheet.ownerName,
        avatar: existing?.avatar ?? initials(sheet.name),
        hp: existing ? Math.min(existing.hp, statBlock.maxHp) : statBlock.hp,
        maxHp: statBlock.maxHp,
        sanity: existing ? Math.min(existing.sanity, statBlock.maxSan) : statBlock.san,
        maxSanity: statBlock.maxSan,
        initiative: existing?.initiative ?? sheet.attributes.dex,
        tags: existing?.tags?.length ? existing.tags : [sheet.occupation, '调查员'],
        notes: existing?.notes ?? sheet.background.description,
        statBlock,
      };
      if (existingIndex >= 0) {
        room.characters[existingIndex] = character;
      } else {
        room.characters.push(character);
      }
      const existingToken = room.scene.tokens.find((token) => token.characterId === character.id);
      const scriptToken = sheet.scriptCharacterId
        ? room.scene.tokens.find((token) => token.characterId === sheet.scriptCharacterId)
        : undefined;
      if (existingToken) {
        existingToken.label = existingToken.label || initials(character.name).slice(0, 2);
      } else if (scriptToken) {
        scriptToken.characterId = character.id;
        scriptToken.label = scriptToken.label || initials(character.name).slice(0, 2);
      } else {
        room.scene.tokens.push({
          id: buildId('token'),
          characterId: character.id,
          label: initials(character.name).slice(0, 2),
          color: tokenColors[(room.scene.tokens.length + index) % tokenColors.length],
          x: ((room.scene.tokens.length + index) % room.scene.width) + 1,
          y: (Math.floor((room.scene.tokens.length + index) / room.scene.width) % room.scene.height) + 1,
          status: 'ready',
        });
      }
    });
    seedRoomPublicBriefing(room, account);
    room.phase = 'playing';
    touch(room);
    persistState();
    return { ok: true as const, room: exposeRoom(room, account) };
  },

  listRooms(account?: Account | null, options: { status?: RoomListStatus } = {}): RoomSummary[] {
    sweepExpiredRoomsInternal();
    return Array.from(rooms.values())
      .filter((room) => shouldListRoom(room, account, options.status ?? 'online'))
      .map((room) => summarize(room, account))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  getActiveMemberRoom(accountId: string) {
    sweepExpiredRoomsInternal();
    const room = findActiveMemberRoom(accountId);
    return room ? exposeRoom(room, accountId) : null;
  },

  createRoom(input: {
    name: string;
    system?: string;
    visibility?: RoomVisibility;
    owner: Account;
    scriptId?: string;
  }) {
    sweepExpiredRoomsInternal();
    const ownerMember = makeRoomMember(input.owner, { role: 'keeper' });
    const rawScript = input.scriptId ? scripts.get(input.scriptId) : null;
    const script = rawScript && (rawScript.visibility === 'public' || rawScript.ownerId === input.owner.id) ? rawScript : null;
    const scriptState = script ? instantiateScriptRoom(script) : null;
    const room: RoomState = {
      ...makeEmptyRoomBase(),
      ...scriptState,
      id: buildId('room'),
      name: input.name.trim(),
      system: input.system?.trim() || script?.system || 'COC 7th',
      phase: 'module_locked',
      visibility: input.visibility ?? 'public',
      ownerId: input.owner.id,
      ownerName: input.owner.displayName,
      keeper: input.owner.displayName,
      scriptId: script?.id,
      players: 1,
      online: true,
      closedAt: null,
      memberIds: [input.owner.id],
      members: [ownerMember],
      participantIds: [input.owner.id],
      participants: [ownerMember],
      rosterIds: [input.owner.id],
      roster: [ownerMember],
      rosterHistoryIds: [input.owner.id],
      hiddenForAccountIds: [],
    invitedAccountIds: [],
    scriptCharacters: scriptState?.scriptCharacters ?? [],
      characterSheets: [],
      closeAt: null,
      updatedAt: now(),
      messages: [],
      voice: {
        epoch: buildVoiceEpoch(),
        livekitConfigured: false,
        participants: [],
      },
    };

    rooms.set(room.id, room);
    persistState();
    return exposeRoom(room, input.owner);
  },

  joinRoom(roomId: string, account: Account, role?: UserRole, options: { openClosed?: boolean } = {}) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: 'Room not found' as const };
    }
    if (!room.online && options.openClosed === false) {
      return { ok: false, error: 'Room is closed' as const };
    }
    if (!room.online && !canAccessClosedRoom(account, room)) {
      return { ok: false, error: 'Room is closed' as const };
    }
    if (!canAccessRoom(account, room)) {
      return { ok: false, error: 'Private room requires friendship with the owner' as const };
    }
    const wasOnline = room.online;
    const activeRoom = findActiveMemberRoom(account.id);
    if (activeRoom && activeRoom.id !== room.id) {
      return { ok: false, error: 'Leave the active room before joining another room' as const };
    }
    const existing = room.members.find((member) => member.accountId === account.id);
    const historicalParticipant = room.participantIds.includes(account.id);
    const rosterMember = room.roster.some((member) => member.accountId === account.id);
    const wasEverRostered = room.rosterHistoryIds.includes(account.id);
    const invitedAccess = room.invitedAccountIds.includes(account.id);
    const isNewExternalJoin = !existing && !historicalParticipant && room.ownerId !== account.id;
    const isHistoricalRosterReturn = !existing && historicalParticipant && !rosterMember && room.ownerId !== account.id;
    if (isNewExternalJoin) {
      if (room.phase !== 'recruiting') {
        return { ok: false, error: 'Room is not recruiting new players' as const };
      }
      const readiness = validateRecruitmentReadiness(room);
      if (!readiness.ok) {
        return { ok: false, error: readiness.error };
      }
    }
    if (room.online && isHistoricalRosterReturn && !invitedAccess && room.phase !== 'recruiting') {
      return { ok: false, error: 'Room is not recruiting new players' as const };
    }
    const includeRoster = account.id === room.ownerId || rosterMember || room.phase === 'recruiting' || (!wasOnline && wasEverRostered);

    if (!room.online) {
      openOnlineRoom(room);
    }
    const roomRole = roleForRoomAccount(room, account.id);
    if (existing) {
      existing.displayName = account.displayName;
      existing.avatar = account.avatar;
      existing.role = roomRole;
      existing.lastSeenAt = now();
    } else {
      room.members.push(
        makeRoomMember(account, {
          role: roomRole,
        }),
      );
    }
    upsertRoomParticipant(room, account, roomRole, { includeRoster });
    if (invitedAccess) {
      room.invitedAccountIds = room.invitedAccountIds.filter((id) => id !== account.id);
    }
    clearRoomClosure(room);
    syncRoomMembers(room);
    touch(room);
    persistState();
    return { ok: true, room: exposeRoom(room, account) };
  },

  leaveRoom(roomId: string, accountId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: 'Room not found' as const };
    }
    const account = accounts.get(accountId);
    if (!account || !canAccessRoom(account, room)) {
      return { ok: false, error: 'Join room first' as const };
    }

    const nextMembers = room.members.filter((member) => member.accountId !== accountId);
    if (nextMembers.length === room.members.length) {
      return { ok: false, error: 'Join room first' as const };
    }

    const leftAt = now();
    const liveKitRoomName = roomVoiceRoomName(room);
    room.members = nextMembers;
    room.roster = room.roster.filter((member) => member.accountId !== accountId);
    const participant = room.participants.find((member) => member.accountId === accountId);
    if (participant) {
      participant.lastSeenAt = leftAt;
      participant.leftAt = leftAt;
      syncRoomParticipants(room);
    }
    removeRoomVoiceParticipant(room, accountId);
    syncRoomMembers(room);
    syncRoomRoster(room);
    if (room.members.length === 0) {
      scheduleRoomClosure(room);
    } else {
      clearRoomClosure(room);
    }
    touch(room);
    persistState();
    return { ok: true, room: exposeRoom(room, account), liveKitRoomName };
  },

  closeRoom(roomId: string, accountId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false as const, error: 'Room not found' as const };
    }
    const account = accounts.get(accountId);
    if (!account || !isRoomOwner(room, accountId)) {
      return { ok: false as const, error: 'Only the room owner can close the room' as const };
    }
    if (!room.online) {
      return { ok: false as const, error: 'Room is closed' as const };
    }

    const liveKitRoomName = roomVoiceRoomName(room);
    closeOnlineRoom(room);
    persistState();
    return { ok: true as const, room: exposeRoom(room, account), liveKitRoomName };
  },

  disconnectRoomMember(roomId: string, accountId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: 'Room not found' as const };
    }

    const nextMembers = room.members.filter((member) => member.accountId !== accountId);
    if (nextMembers.length === room.members.length) {
      return { ok: true, room: exposeRoom(room, accountId) };
    }

    const liveKitRoomName = roomVoiceRoomName(room);
    room.members = nextMembers;
    removeRoomVoiceParticipant(room, accountId);
    syncRoomMembers(room);
    if (room.members.length === 0) {
      scheduleRoomClosure(room);
    } else {
      clearRoomClosure(room);
    }
    touch(room);
    persistState();
    return { ok: true, room: exposeRoom(room, accountId), liveKitRoomName };
  },

  markRoomPresence(roomId: string, account: Account) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return null;
    }
    return applyRoomPresence(room, account);
  },

  joinVoice(
    roomId: string,
    account: Account,
    input: Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>> = {},
  ) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room || !room.online || !canAccessRoom(account, room)) {
      return { ok: false, error: room ? 'Join an online room first' : 'Room not found' };
    }
    if (!room.members.some((member) => member.accountId === account.id)) {
      return { ok: false, error: 'Join an online room first' };
    }
    const alreadyInRoomVoice = room.voice.participants.some((participant) => participant.id === account.id);
    if (hasAcceptedDirectCall(account.id) && !alreadyInRoomVoice) {
      return { ok: false, error: 'End the direct call before joining room voice' };
    }

    upsertRoomVoiceParticipant(room, account, input);
    touch(room);
    persistState();
    return { ok: true, room: exposeRoom(room, account) };
  },

  updateVoiceParticipant(
    roomId: string,
    account: Account,
    input: Partial<Pick<VoiceParticipant, 'muted' | 'speaking' | 'quality'>>,
  ) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room || !room.online || !canAccessRoom(account, room)) {
      return { ok: false, error: room ? 'Join an online room first' : 'Room not found' };
    }
    const participant = room.voice.participants.find((item) => item.id === account.id);
    if (!participant) {
      return { ok: false, error: 'Join voice first' };
    }
    if (hasDirectVoiceReadyCall(account.id)) {
      return { ok: false, error: 'End the direct call before updating room voice' };
    }

    const inputKeys = Object.keys(input);
    const speakingOnly = inputKeys.length > 0 && inputKeys.every((key) => key === 'speaking');
    upsertRoomVoiceParticipant(room, account, input);
    if (!speakingOnly) {
      touch(room);
      persistState();
    }
    return { ok: true, room: exposeRoom(room, account) };
  },

  leaveVoice(roomId: string, accountId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: 'Room not found' };
    }
    const account = accounts.get(accountId);
    if (!account || !canAccessRoom(account, room) || !room.members.some((member) => member.accountId === accountId)) {
      return { ok: false, error: 'Join an online room first' };
    }
    if (!room.voice.participants.some((participant) => participant.id === accountId)) {
      return { ok: false, error: 'Join voice first' };
    }

    const liveKitRoomName = roomVoiceRoomName(room);
    removeRoomVoiceParticipant(room, accountId);
    touch(room);
    persistState();
    return { ok: true, room: exposeRoom(room, account), liveKitRoomName };
  },

  getRoomMembership(roomId: string, account?: Account | null) {
    sweepExpiredRoomsInternal();
    if (!account) {
      return null;
    }

    const room = rooms.get(roomId);
    if (!room || !room.online || !canAccessRoom(account, room)) {
      return null;
    }

    const member = room.members.find((item) => item.accountId === account.id);
    if (!member) {
      return null;
    }

    return {
      room: clone(room),
      member: clone(member),
    };
  },

  sweepExpiredRooms() {
    sweepExpiredRoomsInternal();
    return drainClosedRoomEvents();
  },

  getRoom(roomId: string, account?: Account | null) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room || !canAccessRoom(account, room)) {
      return null;
    }

    return exposeRoom(room, account);
  },

  getRoomBroadcastState(roomId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    return room ? exposeRoom(room) : null;
  },

  getRoomOwnerState(roomId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    return room ? exposeRoom(room, room.ownerId) : null;
  },

  getRoomViewerStates(roomId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return [];
    }
    const viewerIds = room.online
      ? new Set([room.ownerId, ...room.memberIds])
      : new Set([room.ownerId, ...room.participantIds]);
    return Array.from(viewerIds)
      .filter((accountId) => accounts.has(accountId) && canAccessRoom(accounts.get(accountId), room))
      .map((accountId) => ({ accountId, room: exposeRoom(room, accountId) }));
  },

  deleteRoom(roomId: string, accountId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: 'Room not found' as const };
    }
    if (room.ownerId !== accountId) {
      if (!room.online && room.participantIds.includes(accountId)) {
        if (!room.hiddenForAccountIds.includes(accountId)) {
          room.hiddenForAccountIds.push(accountId);
          touch(room);
          persistState();
        }
        return { ok: true as const, deleted: false as const };
      }
      return { ok: false, error: 'Only the room owner can delete this room' as const };
    }

    rooms.delete(roomId);
    persistState();
    return { ok: true as const, deleted: true as const };
  },

  getVoiceRoomName(roomId: string, account: Account) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room || !room.online || !canAccessRoom(account, room)) {
      return null;
    }
    if (!room.members.some((member) => member.accountId === account.id)) {
      return null;
    }
    const alreadyInRoomVoice = room.voice.participants.some((participant) => participant.id === account.id);
    if (hasAcceptedDirectCall(account.id) && !alreadyInRoomVoice) {
      return null;
    }
    if (hasDirectVoiceReadyCall(account.id)) {
      return null;
    }
    return roomVoiceRoomName(room);
  },

  getRoomLiveKitVoiceRoomName(roomId: string) {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    return room ? roomVoiceRoomName(room) : null;
  },

  listRoomMessagePage(
    roomId: string,
    account: Account,
    options: { limit?: number; before?: string } = {},
  ): RoomMessagePage | null {
    sweepExpiredRoomsInternal();
    const room = rooms.get(roomId);
    if (!room || !canAccessRoom(account, room)) {
      return null;
    }
    if (room.online && !room.memberIds.includes(account.id)) {
      return null;
    }

    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const before = options.before?.trim();
    const cutoff = roomMessageHistoryCutoff(room, account);
    const visibleMessages = cutoff
      ? room.messages.filter((message) => Date.parse(message.createdAt) <= Date.parse(cutoff))
      : room.messages;
    const beforeIndex = before ? visibleMessages.findIndex((message) => message.id === before) : -1;
    if (before && beforeIndex < 0) {
      return {
        messages: [],
        hasMore: false,
      };
    }
    const scoped = beforeIndex >= 0 ? visibleMessages.slice(0, beforeIndex) : visibleMessages;
    const start = Math.max(0, scoped.length - limit);
    return {
      messages: scoped.slice(start).map((message) => clone(message)),
      hasMore: start > 0,
    };
  },

  getRoomMessageReference(roomId: string, replyToId?: string) {
    if (!replyToId) {
      return { ok: true as const, replyTo: undefined };
    }

    const room = rooms.get(roomId);
    const message = room?.messages.find((item) => item.id === replyToId);
    if (!message) {
      return { ok: false as const, error: 'Reply target not found' };
    }
    return {
      ok: true as const,
      replyTo: {
        id: message.id,
        author: message.author,
        text: message.text.slice(0, 160),
      },
    };
  },

  getRoomMessageByClientMessageId(
    roomId: string,
    clientMessageId?: string,
    scope: { senderId?: string; messageType?: ChatMessage['messageType'] } = {},
  ) {
    const id = clientMessageId?.trim();
    if (!id) {
      return null;
    }
    const room = rooms.get(roomId);
    const message = room?.messages.find(
      (item) =>
        item.clientMessageId === id &&
        (!scope.senderId || item.senderId === scope.senderId) &&
        (!scope.messageType || item.messageType === scope.messageType),
    );
    return room && message ? exposeRoomMessage(room, message) : null;
  },

  addMessage(roomId: string, input: Omit<ChatMessage, 'id' | 'createdAt' | 'roomId'>) {
    const room = rooms.get(roomId);
    if (!room) {
      return null;
    }

    const clientMessageId = input.clientMessageId?.trim();
    const senderId = input.senderId?.trim();
    const messageType = input.messageType;
    if (clientMessageId) {
      const existing = room.messages.find(
        (message) =>
          message.clientMessageId === clientMessageId &&
          message.senderId === senderId &&
          message.messageType === messageType,
      );
      if (existing) {
        return clone(existing);
      }
    }

    const message: ChatMessage = {
      ...input,
      roomId,
      clientMessageId: clientMessageId || undefined,
      senderId: senderId || undefined,
      messageType,
      id: buildId('msg'),
      createdAt: now(),
    };
    room.messages.push(message);
    touch(room);
    persistState();
    return clone(message);
  },

  rollCoc7Ability(roomId: string, account: Pick<Account, 'id'>, skillInput: string) {
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false as const, error: '房间不存在' as const };
    }
    const character = room.characters.find((item) => item.accountId === account.id && item.statBlock);
    if (!character?.statBlock) {
      return { ok: false as const, error: '使用 .ra 前需要先由 KP 导入已通过的角色卡。' as const };
    }
    const key = normalizeCoc7SkillKey(skillInput);
    const attrKey = key.toLowerCase() as keyof typeof character.statBlock.attributes;
    const attributeValue = character.statBlock.attributes[attrKey];
    const skillKey = character.statBlock.skills[key] !== undefined
      ? key
      : Object.entries(character.statBlock.skillNames).find(
          ([candidateKey, name]) =>
            candidateKey.toLowerCase() === skillInput.trim().toLowerCase() ||
            name.trim().toLowerCase() === skillInput.trim().toLowerCase(),
        )?.[0];
    const skillValue = skillKey ? character.statBlock.skills[skillKey] : undefined;
    const value = typeof attributeValue === 'number' ? attributeValue : skillValue;
    if (typeof value !== 'number') {
      const known = Object.values(character.statBlock.skillNames).join('、') || coc7SkillDefinitions.map((skill) => skill.name).join('、');
      return { ok: false as const, error: `未找到该技能或属性，请尝试：STR、DEX、${known}` as const };
    }
    const label = skillKey ? character.statBlock.skillNames[skillKey] ?? skillKey : key.toUpperCase();
    return { ok: true as const, roll: rollCoc7Check(value, label), character };
  },

  updateCharacter(roomId: string, character: Character) {
    const room = rooms.get(roomId);
    if (!room) {
      return null;
    }

    const index = room.characters.findIndex((item) => item.id === character.id);
    const existing = index >= 0 ? room.characters[index] : null;
    const nextCharacter: Character = existing
      ? {
          ...existing,
          ...character,
          accountId: character.accountId ?? existing.accountId,
          sheetId: character.sheetId ?? existing.sheetId,
          statBlock: character.statBlock ?? existing.statBlock,
        }
      : character;
    if (index >= 0) {
      room.characters[index] = clone(nextCharacter);
    } else {
      room.characters.push(clone(nextCharacter));
    }
    touch(room);
    persistState();
    return clone(nextCharacter);
  },

  moveToken(roomId: string, tokenId: string, x: number, y: number) {
    const room = rooms.get(roomId);
    if (!room) {
      return null;
    }

    const token = room.scene.tokens.find((item) => item.id === tokenId);
    if (!token) {
      return null;
    }

    token.x = clamp(x, 1, room.scene.width);
    token.y = clamp(y, 1, room.scene.height);
    touch(room);
    persistState();
    return clone(token);
  },

  upsertToken(roomId: string, token: MapToken) {
    const room = rooms.get(roomId);
    if (!room) {
      return null;
    }

    const index = room.scene.tokens.findIndex((item) => item.id === token.id);
    if (index >= 0) {
      room.scene.tokens[index] = clone(token);
    } else {
      room.scene.tokens.push(clone(token));
    }
    touch(room);
    persistState();
    return clone(token);
  },

  listScripts(account?: Account | null) {
    return Array.from(scripts.values())
      .filter((script) => script.visibility === 'public' || script.ownerId === account?.id)
      .map((script) => summarizeScript(script, account))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  getScript(scriptId: string, account?: Account | null) {
    const script = scripts.get(scriptId);
    if (!script || (script.visibility === 'private' && script.ownerId !== account?.id)) {
      return null;
    }
    return exposeScript(script, account);
  },

  createScript(owner: Account, input: Partial<TrpgScript>) {
    const script = {
      ...defaultScriptInput(owner, input.title),
      ...input,
      id: buildId('script'),
      ownerId: owner.id,
      ownerName: owner.displayName,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    } as TrpgScript;

    const normalized = normalizeScript(script) ?? script;
    scripts.set(normalized.id, clone(normalized));
    persistState();
    return exposeScript(normalized, owner);
  },

  updateScript(scriptId: string, owner: Account, input: Partial<TrpgScript> & { version: number }) {
    const script = scripts.get(scriptId);
    if (!script || script.ownerId !== owner.id) {
      return { ok: false, error: 'not-found' as const };
    }
    const requestedVersion = scriptVersion(input.version);
    if (requestedVersion !== script.version) {
      return {
        ok: false,
        error: 'conflict' as const,
        current: exposeScript(script, owner),
        currentVersion: script.version,
      };
    }

    const next: TrpgScript = {
      ...script,
      ...input,
      id: script.id,
      ownerId: script.ownerId,
      ownerName: owner.displayName,
      createdAt: script.createdAt,
      updatedAt: now(),
      version: script.version + 1,
      maps: (input.maps as ScriptMap[] | undefined) ?? script.maps,
      characters: (input.characters as ScriptCharacter[] | undefined) ?? script.characters,
      diceProfiles: (input.diceProfiles as DiceProfile[] | undefined) ?? script.diceProfiles,
      chapters: (input.chapters as ScriptChapter[] | undefined) ?? script.chapters,
    };

    const normalized = normalizeScript(next) ?? next;
    scripts.set(script.id, clone(normalized));
    persistState();
    return { ok: true as const, script: exposeScript(normalized, owner) };
  },

  deleteScript(scriptId: string, owner: Account) {
    const script = scripts.get(scriptId);
    if (!script) {
      return { ok: false, error: 'Script not found' as const };
    }
    if (script.ownerId !== owner.id) {
      return { ok: false, error: 'Only the script owner can delete this script' as const };
    }

    scripts.delete(scriptId);
    persistState();
    return { ok: true as const };
  },

  importScript(owner: Account, input: { title: string; system?: string; rawText: string }) {
    const chapterBlocks: ScriptBlock[] = [
      {
        id: buildId('block'),
        type: 'narrative',
        title: '导入正文',
        markdown: input.rawText.trim(),
      },
    ];

    return this.createScript(owner, {
      title: input.title.trim() || '导入剧本',
      system: input.system?.trim() || 'COC 7th',
      summary: input.rawText.trim().slice(0, 160),
      chapters: [{ id: buildId('chapter'), title: '导入章节', blocks: chapterBlocks }],
    });
  },
};
