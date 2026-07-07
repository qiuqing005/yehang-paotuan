import { z } from 'zod';

const avatarMaxLength = 300000;

export const roomCharacterStatBlockSchema = z.object({
  hp: z.number().int().min(0),
  maxHp: z.number().int().min(0),
  mp: z.number().int().min(0),
  maxMp: z.number().int().min(0),
  san: z.number().int().min(0),
  maxSan: z.number().int().min(0),
  mov: z.number().int().min(0),
  db: z.string(),
  build: z.number().int(),
  accountId: z.string().min(1),
  attributes: z.object({
    str: z.number().int().min(0),
    con: z.number().int().min(0),
    siz: z.number().int().min(0),
    dex: z.number().int().min(0),
    app: z.number().int().min(0),
    int: z.number().int().min(0),
    pow: z.number().int().min(0),
    edu: z.number().int().min(0),
    luck: z.number().int().min(0),
  }),
  skills: z.record(z.string(), z.number()),
  skillNames: z.record(z.string(), z.string()),
});

export const roomCharacterSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1).optional(),
  sheetId: z.string().min(1).optional(),
  name: z.string().min(1),
  player: z.string().min(1),
  avatar: z.string().min(1).max(avatarMaxLength),
  hp: z.number().int().min(0),
  maxHp: z.number().int().min(0),
  sanity: z.number().int().min(0),
  maxSanity: z.number().int().min(0),
  initiative: z.number().int().min(0),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(2000),
  statBlock: roomCharacterStatBlockSchema.optional(),
});
