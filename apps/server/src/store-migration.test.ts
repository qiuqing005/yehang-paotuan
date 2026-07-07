import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('store state migration', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.resetModules();
    delete process.env.DATA_DIR;
    delete process.env.ENABLE_SEED_DATA;
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('restores legacy rooms that are missing newer scene, characters, messages, and voice fields', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify(
        {
          accounts: [
            {
              id: 'legacy-owner',
              email: 'legacy-owner@example.com',
              displayName: 'Legacy KP',
              avatar: 'LK',
              role: 'keeper',
              createdAt: '2026-05-01T00:00:00.000Z',
              lastSeenAt: '2026-05-01T00:00:00.000Z',
              passwordHash: 'scrypt:abcd:0123',
            },
          ],
          rooms: [
            {
              id: 'legacy-room',
              name: 'Legacy Closed Room',
              system: 'COC 7th',
              visibility: 'public',
              ownerId: 'legacy-owner',
              ownerName: 'Legacy KP',
              keeper: 'Legacy KP',
              phase: 'closed',
              phaseBeforeClose: 'playing',
              online: false,
              closedAt: '2026-05-02T00:00:00.000Z',
              memberIds: [],
              participantIds: ['legacy-owner'],
              updatedAt: '2026-05-02T00:00:00.000Z',
            },
          ],
          sessions: [],
          friendships: [],
          directMessages: [],
          scripts: [],
          emailVerifications: [],
        },
        null,
        2,
      ),
    );

    const { store } = await import('./store.js');
    const owner = {
      id: 'legacy-owner',
      email: 'legacy-owner@example.com',
      displayName: 'Legacy KP',
      avatar: 'LK',
      role: 'keeper' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
    };

    const restored = store.getRoom('legacy-room', owner);
    expect(restored).toMatchObject({
      id: 'legacy-room',
      online: false,
      phase: 'closed',
      phaseBeforeClose: 'playing',
      closedAt: '2026-05-02T00:00:00.000Z',
      messages: [],
      characters: [],
      voice: {
        livekitConfigured: false,
        participants: [],
      },
    });
    expect(restored?.scene).toMatchObject({
      name: '空白地图',
      width: 12,
      height: 8,
      features: [],
      tokens: [],
    });
    expect(restored?.participants).toEqual([
      expect.objectContaining({
        accountId: 'legacy-owner',
        displayName: 'Legacy KP',
        role: 'keeper',
      }),
    ]);
    expect(store.listRooms(owner, { status: 'closed' }).map((room) => room.id)).toContain('legacy-room');
  });

  it('keeps an explicitly empty room roster empty instead of reviving historical participants', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    const owner = {
      id: 'roster-owner',
      email: 'roster-owner@example.com',
      displayName: 'Roster KP',
      avatar: 'RK',
      role: 'keeper' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
      passwordHash: 'scrypt:abcd:0123',
    };
    const player = {
      id: 'roster-player',
      email: 'roster-player@example.com',
      displayName: 'Former Player',
      avatar: 'FP',
      role: 'player' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
      passwordHash: 'scrypt:abcd:0123',
    };

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify(
        {
          accounts: [owner, player],
          rooms: [
            {
              id: 'empty-roster-room',
              name: 'Empty Roster Room',
              system: 'COC 7th',
              visibility: 'public',
              ownerId: owner.id,
              ownerName: owner.displayName,
              keeper: owner.displayName,
              phase: 'chargen',
              online: true,
              memberIds: [],
              members: [],
              participantIds: [owner.id, player.id],
              participants: [
                {
                  accountId: owner.id,
                  displayName: owner.displayName,
                  avatar: owner.avatar,
                  role: 'keeper',
                  joinedAt: '2026-05-01T00:00:00.000Z',
                  lastSeenAt: '2026-05-01T00:00:00.000Z',
                },
                {
                  accountId: player.id,
                  displayName: player.displayName,
                  avatar: player.avatar,
                  role: 'player',
                  joinedAt: '2026-05-01T00:00:00.000Z',
                  lastSeenAt: '2026-05-01T00:00:00.000Z',
                },
              ],
              rosterIds: [],
              roster: [],
              updatedAt: '2026-05-02T00:00:00.000Z',
            },
          ],
          sessions: [],
          friendships: [],
          directMessages: [],
          scripts: [],
          emailVerifications: [],
        },
        null,
        2,
      ),
    );

    const { store } = await import('./store.js');
    const restored = store.getRoom('empty-roster-room', owner);
    expect(restored?.participants.map((member) => member.accountId)).toEqual([owner.id, player.id]);
    expect(restored?.roster).toEqual([]);
    expect(store.updateRoomPhase('empty-roster-room', owner, 'review')).toMatchObject({
      ok: false,
      error: '进入集中审核前至少需要 1 张已提交角色卡。',
    });
  });

  it('treats legacy phase-closed rooms without an online flag as closed history', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-closed-phase-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify(
        {
          accounts: [
            {
              id: 'legacy-phase-owner',
              email: 'legacy-phase-owner@example.com',
              displayName: 'Legacy Phase KP',
              avatar: 'LP',
              role: 'keeper',
              createdAt: '2026-05-01T00:00:00.000Z',
              lastSeenAt: '2026-05-01T00:00:00.000Z',
              passwordHash: 'scrypt:abcd:0123',
            },
          ],
          rooms: [
            {
              id: 'legacy-phase-closed-room',
              name: 'Legacy Phase Closed Room',
              system: 'COC 7th',
              visibility: 'public',
              ownerId: 'legacy-phase-owner',
              ownerName: 'Legacy Phase KP',
              keeper: 'Legacy Phase KP',
              phase: 'closed',
              phaseBeforeClose: 'playing',
              closedAt: '2026-05-02T00:00:00.000Z',
              participantIds: ['legacy-phase-owner'],
              updatedAt: '2026-05-02T00:00:00.000Z',
            },
          ],
          sessions: [],
          friendships: [],
          directMessages: [],
          scripts: [],
          emailVerifications: [],
        },
        null,
        2,
      ),
    );

    const { store } = await import('./store.js');
    const owner = {
      id: 'legacy-phase-owner',
      email: 'legacy-phase-owner@example.com',
      displayName: 'Legacy Phase KP',
      avatar: 'LP',
      role: 'keeper' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
    };

    expect(store.getRoom('legacy-phase-closed-room', owner)).toMatchObject({
      id: 'legacy-phase-closed-room',
      online: false,
      phase: 'closed',
    });
    expect(store.listRooms(owner).some((room) => room.id === 'legacy-phase-closed-room')).toBe(false);
    expect(store.listRooms(owner, { status: 'closed' }).find((room) => room.id === 'legacy-phase-closed-room')).toMatchObject({
      online: false,
      canJoin: true,
    });
  });

  it('does not revive explicit roster membership from volatile active members during startup recovery', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    const owner = {
      id: 'access-owner',
      email: 'access-owner@example.com',
      displayName: 'Access KP',
      avatar: 'AK',
      role: 'keeper' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
      passwordHash: 'scrypt:abcd:0123',
    };
    const visitor = {
      id: 'access-visitor',
      email: 'access-visitor@example.com',
      displayName: 'Access Visitor',
      avatar: 'AV',
      role: 'player' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
      passwordHash: 'scrypt:abcd:0123',
    };

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify(
        {
          accounts: [owner, visitor],
          rooms: [
            {
              id: 'access-only-room',
              name: 'Access Only Room',
              system: 'COC 7th',
              visibility: 'public',
              ownerId: owner.id,
              ownerName: owner.displayName,
              keeper: owner.displayName,
              phase: 'playing',
              online: true,
              memberIds: [owner.id, visitor.id],
              members: [
                {
                  accountId: owner.id,
                  displayName: owner.displayName,
                  avatar: owner.avatar,
                  role: 'keeper',
                  joinedAt: '2026-05-01T00:00:00.000Z',
                  lastSeenAt: '2026-05-01T00:00:00.000Z',
                },
                {
                  accountId: visitor.id,
                  displayName: visitor.displayName,
                  avatar: visitor.avatar,
                  role: 'player',
                  joinedAt: '2026-05-01T00:00:00.000Z',
                  lastSeenAt: '2026-05-01T00:00:00.000Z',
                },
              ],
              participantIds: [owner.id, visitor.id],
              participants: [
                {
                  accountId: owner.id,
                  displayName: owner.displayName,
                  avatar: owner.avatar,
                  role: 'keeper',
                  joinedAt: '2026-05-01T00:00:00.000Z',
                  lastSeenAt: '2026-05-01T00:00:00.000Z',
                },
                {
                  accountId: visitor.id,
                  displayName: visitor.displayName,
                  avatar: visitor.avatar,
                  role: 'player',
                  joinedAt: '2026-05-01T00:00:00.000Z',
                  lastSeenAt: '2026-05-01T00:00:00.000Z',
                },
              ],
              rosterIds: [owner.id],
              roster: [
                {
                  accountId: owner.id,
                  displayName: owner.displayName,
                  avatar: owner.avatar,
                  role: 'keeper',
                  joinedAt: '2026-05-01T00:00:00.000Z',
                  lastSeenAt: '2026-05-01T00:00:00.000Z',
                },
              ],
              updatedAt: '2026-05-02T00:00:00.000Z',
            },
          ],
          sessions: [],
          friendships: [],
          directMessages: [],
          scripts: [],
          emailVerifications: [],
        },
        null,
        2,
      ),
    );

    const { store } = await import('./store.js');
    const restored = store.getRoom('access-only-room', owner);
    expect(restored?.members).toEqual([]);
    expect(restored?.participants.map((member) => member.accountId)).toEqual([owner.id, visitor.id]);
    expect(restored?.roster.map((member) => member.accountId)).toEqual([owner.id]);
    expect(restored?.invitedAccountIds).toEqual([]);
  });

  it('restores room script snapshots without exposing them to non-keepers', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    const owner = {
      id: 'snapshot-owner',
      email: 'snapshot-owner@example.com',
      displayName: 'Snapshot KP',
      avatar: 'SK',
      role: 'keeper' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
      passwordHash: 'scrypt:abcd:0123',
    };
    const player = {
      id: 'snapshot-player',
      email: 'snapshot-player@example.com',
      displayName: 'Snapshot Player',
      avatar: 'SP',
      role: 'player' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
      passwordHash: 'scrypt:abcd:0123',
    };

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify(
        {
          accounts: [owner, player],
          rooms: [
            {
              id: 'snapshot-room',
              name: 'Snapshot Room',
              system: 'COC 7th',
              visibility: 'public',
              ownerId: owner.id,
              ownerName: owner.displayName,
              keeper: owner.displayName,
              phase: 'playing',
              scriptId: 'snapshot-script',
              scriptSnapshot: {
                id: 'snapshot-script',
                title: '冻结模组',
                system: 'COC 7th',
                visibility: 'private',
                ownerId: owner.id,
                ownerName: owner.displayName,
                summary: '冻结公开剧情',
                tags: [],
                coverUrl: '',
                maps: [{ id: 'snapshot-map', name: '冻结地图', width: 8, height: 6, notes: '', features: [], tokens: [] }],
                characters: [],
                diceProfiles: [],
                chapters: [
                  {
                    id: 'snapshot-chapter',
                    title: '冻结章节',
                    blocks: [{ id: 'snapshot-block', type: 'narrative', title: '冻结开场', markdown: '冻结正文' }],
                  },
                ],
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-01T00:00:00.000Z',
                version: 3,
              },
              memberIds: [owner.id],
              participantIds: [owner.id, player.id],
              updatedAt: '2026-05-02T00:00:00.000Z',
            },
          ],
          sessions: [],
          friendships: [],
          directMessages: [],
          scripts: [],
          emailVerifications: [],
        },
        null,
        2,
      ),
    );

    const { store } = await import('./store.js');
    const ownerRoom = store.getRoom('snapshot-room', owner);
    const playerRoom = store.getRoom('snapshot-room', player);
    expect(ownerRoom?.scriptSnapshot).toMatchObject({ id: 'snapshot-script', title: '冻结模组', version: 3 });
    expect(playerRoom?.scriptSnapshot).toBeUndefined();
  });

  it('sanitizes legacy character publications and publication messages on room exposure', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    const owner = {
      id: 'legacy-publication-owner',
      email: 'legacy-publication-owner@example.com',
      displayName: 'Legacy Publication KP',
      avatar: 'LP',
      role: 'keeper' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
      passwordHash: 'scrypt:abcd:0123',
    };
    const player = {
      id: 'legacy-publication-player',
      email: 'legacy-publication-player@example.com',
      displayName: 'Legacy Publication Player',
      avatar: 'PP',
      role: 'player' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
      passwordHash: 'scrypt:abcd:0123',
    };

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify(
        {
          accounts: [owner, player],
          rooms: [
            {
              id: 'legacy-publication-room',
              name: 'Legacy Publication Room',
              system: 'COC 7th',
              visibility: 'public',
              ownerId: owner.id,
              ownerName: owner.displayName,
              keeper: owner.displayName,
              phase: 'playing',
              online: true,
              scriptId: 'legacy-publication-script',
              scriptSnapshot: {
                id: 'legacy-publication-script',
                title: '旧公开块模组',
                system: 'COC 7th',
                visibility: 'private',
                ownerId: owner.id,
                ownerName: owner.displayName,
                summary: '公开摘要',
                tags: [],
                coverUrl: '',
                maps: [],
                characters: [{
                  id: 'legacy-publication-character',
                  name: '旧角色',
                  count: 1,
                  occupation: '记者',
                  parameters: 'HP_SECRET_PARAMETERS',
                  publicSummary: '玩家可见公开摘要',
                  story: 'FINAL_SECRET_STORY',
                  privateBrief: 'KP_SECRET_BRIEF',
                }],
                diceProfiles: [],
                chapters: [{
                  id: 'legacy-publication-chapter',
                  title: '旧章节',
                  blocks: [{
                    id: 'legacy-publication-block',
                    type: 'character',
                    title: '公开旧角色',
                    characterId: 'legacy-publication-character',
                    notes: '公开登场说明',
                  }],
                }],
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-01T00:00:00.000Z',
                version: 1,
              },
              scriptCharacters: [{
                id: 'legacy-publication-character',
                name: '旧角色',
                count: 1,
                occupation: '记者',
                parameters: 'HP_SECRET_PARAMETERS',
                publicSummary: '玩家可见公开摘要',
                story: 'FINAL_SECRET_STORY',
                privateBrief: 'KP_SECRET_BRIEF',
              }],
              publicContent: [{
                id: 'legacy-publication-content',
                type: 'character',
                title: '旧公开旧角色',
                markdown: '旧公开内容泄露 HP_SECRET_PARAMETERS FINAL_SECRET_STORY KP_SECRET_BRIEF',
                source: {
                  scriptId: 'legacy-publication-script',
                  scriptVersion: 1,
                  chapterId: 'legacy-publication-chapter',
                  blockId: 'legacy-publication-block',
                  characterId: 'legacy-publication-character',
                },
                createdBy: owner.id,
                createdByName: owner.displayName,
                createdAt: '2026-05-02T00:00:00.000Z',
              }],
              messages: [{
                id: 'legacy-publication-message',
                roomId: 'legacy-publication-room',
                clientMessageId: 'script-publication:legacy-publication-script:legacy-publication-chapter:legacy-publication-block',
                senderId: owner.id,
                messageType: 'chat',
                author: owner.displayName,
                role: 'keeper',
                text: '旧聊天泄露 HP_SECRET_PARAMETERS FINAL_SECRET_STORY KP_SECRET_BRIEF',
                createdAt: '2026-05-02T00:00:01.000Z',
              }],
              memberIds: [owner.id, player.id],
              participantIds: [owner.id, player.id],
              rosterHistoryIds: [owner.id, player.id],
              updatedAt: '2026-05-02T00:00:00.000Z',
            },
          ],
          sessions: [],
          friendships: [],
          directMessages: [],
          scripts: [],
          emailVerifications: [],
        },
        null,
        2,
      ),
    );

    const { store } = await import('./store.js');
    const playerRoom = store.getRoom('legacy-publication-room', player);
    const markdown = playerRoom?.publicContent[0]?.markdown ?? '';
    const messageText = playerRoom?.messages[0]?.text ?? '';

    expect(playerRoom?.scriptCharacters[0]).toMatchObject({ parameters: '', story: '', privateBrief: '' });
    expect(markdown).toContain('公开登场说明');
    expect(markdown).toContain('玩家可见公开摘要');
    expect(markdown).toContain('职业倾向：记者');
    expect(messageText).toContain('公开登场说明');
    expect(messageText).toContain('玩家可见公开摘要');
    for (const secret of ['HP_SECRET_PARAMETERS', 'FINAL_SECRET_STORY', 'KP_SECRET_BRIEF']) {
      expect(markdown).not.toContain(secret);
      expect(messageText).not.toContain(secret);
    }
  });

  it('recovers persisted state from backup when the primary state file is corrupt', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    const backupState = {
      accounts: [
        {
          id: 'backup-owner',
          email: 'backup-owner@example.com',
          displayName: 'Backup Owner',
          avatar: 'BO',
          role: 'keeper',
          createdAt: '2026-05-03T00:00:00.000Z',
          lastSeenAt: '2026-05-03T00:00:00.000Z',
          passwordHash: 'scrypt:abcd:0123',
        },
      ],
      rooms: [],
      sessions: [],
      friendships: [],
      directMessages: [],
      scripts: [],
      emailVerifications: [],
    };
    writeFileSync(path.join(dataDir, 'state.json'), '{ this is not json', 'utf8');
    writeFileSync(path.join(dataDir, 'state.json.bak'), JSON.stringify(backupState, null, 2), 'utf8');

    const { store } = await import('./store.js');

    expect(store.hasAccount('backup-owner@example.com')).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
      accounts: [{ email: 'backup-owner@example.com' }],
    });
    expect(JSON.parse(readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8'))).toMatchObject({
      accounts: [{ email: 'backup-owner@example.com' }],
    });
  });

  it('initializes read cursors for legacy direct messages without directReadStates', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    const createdAt = '2026-05-04T00:00:00.000Z';
    const latestAt = '2026-05-04T00:01:00.000Z';
    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify(
        {
          accounts: [
            {
              id: 'legacy-a',
              email: 'legacy-a@example.com',
              displayName: 'Legacy A',
              avatar: 'LA',
              role: 'player',
              createdAt,
              lastSeenAt: createdAt,
              passwordHash: 'scrypt:abcd:0123',
            },
            {
              id: 'legacy-b',
              email: 'legacy-b@example.com',
              displayName: 'Legacy B',
              avatar: 'LB',
              role: 'player',
              createdAt,
              lastSeenAt: createdAt,
              passwordHash: 'scrypt:abcd:0123',
            },
          ],
          rooms: [],
          sessions: [],
          friendships: [
            {
              id: 'legacy-friend',
              requesterId: 'legacy-a',
              addresseeId: 'legacy-b',
              status: 'accepted',
              createdAt,
              updatedAt: createdAt,
            },
          ],
          directMessages: [
            {
              id: 'legacy-dm-1',
              fromId: 'legacy-a',
              toId: 'legacy-b',
              text: 'old hello',
              createdAt,
            },
            {
              id: 'legacy-dm-2',
              fromId: 'legacy-b',
              toId: 'legacy-a',
              text: 'old reply',
              createdAt: latestAt,
            },
          ],
          scripts: [],
          emailVerifications: [],
        },
        null,
        2,
      ),
      'utf8',
    );

    const { store } = await import('./store.js');

    expect(store.listFriends('legacy-a').find((friend) => friend.id === 'legacy-b')).toMatchObject({
      unreadCount: 0,
      lastReadMessageId: 'legacy-dm-2',
    });
    expect(store.listFriends('legacy-b').find((friend) => friend.id === 'legacy-a')).toMatchObject({
      unreadCount: 0,
      lastReadMessageId: 'legacy-dm-2',
    });
    const state = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as {
      directReadStates?: Array<{ accountId: string; friendId: string; lastReadMessageId?: string }>;
    };
    expect(state.directReadStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: 'legacy-a', friendId: 'legacy-b', lastReadMessageId: 'legacy-dm-2' }),
        expect.objectContaining({ accountId: 'legacy-b', friendId: 'legacy-a', lastReadMessageId: 'legacy-dm-2' }),
      ]),
    );
  });

  it('normalizes legacy scripts without versions and updates them to the next version', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify(
        {
          accounts: [
            {
              id: 'legacy-script-owner',
              email: 'legacy-script-owner@example.com',
              displayName: 'Legacy Script Owner',
              avatar: 'LS',
              role: 'keeper',
              createdAt: '2026-05-06T00:00:00.000Z',
              lastSeenAt: '2026-05-06T00:00:00.000Z',
              passwordHash: 'scrypt:abcd:0123',
            },
          ],
          rooms: [],
          sessions: [],
          friendships: [],
          directMessages: [],
          scripts: [
            {
              id: 'legacy-script',
              title: 'Legacy Script',
              system: 'COC 7th',
              visibility: 'private',
              ownerId: 'legacy-script-owner',
              ownerName: 'Legacy Script Owner',
              summary: 'old summary',
              tags: ['legacy'],
              coverUrl: '',
              maps: [],
              characters: [],
              diceProfiles: [],
              chapters: [],
              createdAt: '2026-05-06T00:00:00.000Z',
              updatedAt: '2026-05-06T00:00:00.000Z',
            },
          ],
          emailVerifications: [],
        },
        null,
        2,
      ),
      'utf8',
    );

    const { store } = await import('./store.js');
    const owner = {
      id: 'legacy-script-owner',
      email: 'legacy-script-owner@example.com',
      displayName: 'Legacy Script Owner',
      avatar: 'LS',
      role: 'keeper' as const,
      createdAt: '2026-05-06T00:00:00.000Z',
      lastSeenAt: '2026-05-06T00:00:00.000Z',
    };

    expect(store.listScripts(owner).find((script) => script.id === 'legacy-script')).toMatchObject({
      id: 'legacy-script',
      version: 1,
    });
    expect(store.getScript('legacy-script', owner)).toMatchObject({
      title: 'Legacy Script',
      version: 1,
    });

    const updated = store.updateScript('legacy-script', owner, {
      title: 'Legacy Script Updated',
      summary: 'new summary',
      version: 1,
    });
    expect(updated.ok).toBe(true);
    expect(updated.ok ? updated.script.version : null).toBe(2);

    const state = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as {
      scripts: Array<{ id: string; title: string; version?: number }>;
    };
    expect(state.scripts.find((script) => script.id === 'legacy-script')).toMatchObject({
      title: 'Legacy Script Updated',
      version: 2,
    });
  });

  it('uses atomic async persistence with backup outside the test sync-persist path', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';
    process.env.NODE_ENV = 'production';

    const { store } = await import('./store.js');
    const first = store.registerAccount({
      email: 'async-first@example.com',
      displayName: 'Async First',
      password: '123456',
    });
    expect(first?.account.email).toBe('async-first@example.com');
    await new Promise((resolve) => setTimeout(resolve, 450));

    const second = store.registerAccount({
      email: 'async-second@example.com',
      displayName: 'Async Second',
      password: '123456',
    });
    expect(second?.account.email).toBe('async-second@example.com');
    await new Promise((resolve) => setTimeout(resolve, 450));

    const state = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as {
      accounts: Array<{ email: string }>;
    };
    const backup = JSON.parse(readFileSync(path.join(dataDir, 'state.json.bak'), 'utf8')) as {
      accounts: Array<{ email: string }>;
    };
    expect(state.accounts.some((account) => account.email === 'async-second@example.com')).toBe(true);
    expect(backup.accounts.some((account) => account.email === 'async-first@example.com')).toBe(true);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('restores online legacy rooms from memberIds and keeps core room actions usable', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify({
        accounts: [
          {
            id: 'legacy-online-owner',
            email: 'legacy-online-owner@example.com',
            displayName: 'Online KP',
            avatar: 'OK',
            role: 'keeper',
            createdAt: '2026-05-03T00:00:00.000Z',
            lastSeenAt: '2026-05-03T00:00:00.000Z',
            passwordHash: 'scrypt:abcd:0123',
          },
          {
            id: 'legacy-online-player',
            email: 'legacy-online-player@example.com',
            displayName: 'Online PL',
            avatar: 'OP',
            role: 'player',
            createdAt: '2026-05-03T00:00:00.000Z',
            lastSeenAt: '2026-05-03T00:00:00.000Z',
            passwordHash: 'scrypt:abcd:0123',
          },
        ],
        rooms: [
          {
            id: 'legacy-online-room',
            name: 'Legacy Online Room',
            system: 'COC 7th',
            visibility: 'public',
            ownerId: 'legacy-online-owner',
            ownerName: 'Online KP',
            keeper: 'Online KP',
            phase: 'playing',
            online: true,
            memberIds: ['legacy-online-owner', 'legacy-online-player'],
            updatedAt: '2026-05-03T00:00:00.000Z',
          },
        ],
        sessions: [],
        friendships: [],
        directMessages: [],
        scripts: [],
        emailVerifications: [],
      }),
    );

    const { store } = await import('./store.js');
    const player = {
      id: 'legacy-online-player',
      email: 'legacy-online-player@example.com',
      displayName: 'Online PL',
      avatar: 'OP',
      role: 'player' as const,
      createdAt: '2026-05-03T00:00:00.000Z',
      lastSeenAt: '2026-05-03T00:00:00.000Z',
    };

    const restored = store.getRoom('legacy-online-room', player);
    expect(restored?.members).toEqual([]);
    expect(restored?.participants.map((member) => member.accountId)).toEqual([
      'legacy-online-owner',
      'legacy-online-player',
    ]);

    const joined = store.joinRoom('legacy-online-room', player, 'player');
    expect(joined.ok).toBe(true);
    const membership = store.getRoomMembership('legacy-online-room', player);
    expect(membership?.member).toMatchObject({
      accountId: 'legacy-online-player',
      displayName: 'Online PL',
      role: 'player',
    });
    expect(membership?.room.messages).toEqual([]);
    expect(membership?.room.characters).toEqual([]);
    expect(membership?.room.scene).toMatchObject({ name: '空白地图', width: 12, height: 8 });

    expect(
      store.addMessage('legacy-online-room', {
        author: player.displayName,
        role: 'player',
        text: 'legacy online room can still chat',
      }),
    ).toMatchObject({ text: 'legacy online room can still chat' });

    const voice = store.joinVoice('legacy-online-room', player, { muted: true, quality: 'good' });
    expect(voice.ok).toBe(true);
    expect(voice.ok ? voice.room.voice.participants : []).toEqual([
      expect.objectContaining({ id: 'legacy-online-player', muted: true, quality: 'good' }),
    ]);
  });

  it('restores closed legacy room history from participant objects and can reopen it', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify({
        accounts: [
          {
            id: 'legacy-history-owner',
            email: 'legacy-history-owner@example.com',
            displayName: 'History KP',
            avatar: 'HK',
            role: 'keeper',
            createdAt: '2026-05-04T00:00:00.000Z',
            lastSeenAt: '2026-05-04T00:00:00.000Z',
            passwordHash: 'scrypt:abcd:0123',
          },
          {
            id: 'legacy-history-player',
            email: 'legacy-history-player@example.com',
            displayName: 'History PL',
            avatar: 'HP',
            role: 'player',
            createdAt: '2026-05-04T00:00:00.000Z',
            lastSeenAt: '2026-05-04T00:00:00.000Z',
            passwordHash: 'scrypt:abcd:0123',
          },
        ],
        rooms: [
          {
            id: 'legacy-history-room',
            name: 'Legacy History Room',
            system: 'COC 7th',
            visibility: 'public',
            ownerId: 'legacy-history-owner',
            ownerName: 'History KP',
            keeper: 'History KP',
            phase: 'closed',
            phaseBeforeClose: 'review',
            online: false,
            closedAt: '2026-05-04T01:00:00.000Z',
            participants: [
              {
                accountId: 'legacy-history-player',
                displayName: 'History PL',
                avatar: 'HP',
                role: 'keeper',
                joinedAt: '2026-05-04T00:10:00.000Z',
                lastSeenAt: '2026-05-04T00:50:00.000Z',
              },
            ],
            updatedAt: '2026-05-04T01:00:00.000Z',
          },
        ],
        sessions: [],
        friendships: [],
        directMessages: [],
        scripts: [],
        emailVerifications: [],
      }),
    );

    const { store } = await import('./store.js');
    const player = {
      id: 'legacy-history-player',
      email: 'legacy-history-player@example.com',
      displayName: 'History PL',
      avatar: 'HP',
      role: 'player' as const,
      createdAt: '2026-05-04T00:00:00.000Z',
      lastSeenAt: '2026-05-04T00:00:00.000Z',
    };

    expect(store.listRooms(player, { status: 'closed' }).map((room) => room.id)).toContain('legacy-history-room');
    const reopened = store.joinRoom('legacy-history-room', player, 'keeper');
    expect(reopened.ok).toBe(true);
    expect(reopened.ok ? reopened.room.online : false).toBe(true);
    expect(reopened.ok ? reopened.room.phase : null).toBe('review');
    expect(reopened.ok ? reopened.room.members.find((member) => member.accountId === player.id)?.role : null).toBe(
      'player',
    );
  });

  it('drops legacy voice participants that are no longer active room members', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'paotuan-store-migration-'));
    process.env.DATA_DIR = dataDir;
    process.env.ENABLE_SEED_DATA = 'false';

    writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify({
        accounts: [
          {
            id: 'legacy-voice-owner',
            email: 'legacy-voice-owner@example.com',
            displayName: 'Voice KP',
            avatar: 'VK',
            role: 'keeper',
            createdAt: '2026-05-05T00:00:00.000Z',
            lastSeenAt: '2026-05-05T00:00:00.000Z',
            passwordHash: 'scrypt:abcd:0123',
          },
          {
            id: 'legacy-voice-ghost',
            email: 'legacy-voice-ghost@example.com',
            displayName: 'Voice Ghost',
            avatar: 'VG',
            role: 'player',
            createdAt: '2026-05-05T00:00:00.000Z',
            lastSeenAt: '2026-05-05T00:00:00.000Z',
            passwordHash: 'scrypt:abcd:0123',
          },
        ],
        rooms: [
          {
            id: 'legacy-voice-room',
            name: 'Legacy Voice Room',
            system: 'COC 7th',
            visibility: 'public',
            ownerId: 'legacy-voice-owner',
            ownerName: 'Voice KP',
            keeper: 'Voice KP',
            phase: 'playing',
            online: true,
            memberIds: ['legacy-voice-owner'],
            voice: {
              livekitConfigured: true,
              participants: [
                { id: 'legacy-voice-owner', name: 'Voice KP', muted: false, speaking: false, quality: 'excellent' },
                { id: 'legacy-voice-ghost', name: 'Voice Ghost', muted: false, speaking: true, quality: 'offline' },
              ],
            },
            updatedAt: '2026-05-05T00:00:00.000Z',
          },
        ],
        sessions: [],
        friendships: [],
        directMessages: [],
        scripts: [],
        emailVerifications: [],
      }),
    );

    const { store } = await import('./store.js');
    const owner = {
      id: 'legacy-voice-owner',
      email: 'legacy-voice-owner@example.com',
      displayName: 'Voice KP',
      avatar: 'VK',
      role: 'keeper' as const,
      createdAt: '2026-05-05T00:00:00.000Z',
      lastSeenAt: '2026-05-05T00:00:00.000Z',
    };

    const restored = store.getRoom('legacy-voice-room', owner);
    expect(restored?.voice.participants).toEqual([]);
    expect(restored?.participants.map((member) => member.accountId)).toEqual(['legacy-voice-owner']);
  });
});
