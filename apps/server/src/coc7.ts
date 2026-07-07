import type { CharacterSheet, CharacterSheetStatus, Coc7Attributes, Coc7SkillPoint } from './types.js';

export const coc7SkillDefinitions = [
  { key: 'spotHidden', name: '侦查', base: 25 },
  { key: 'listen', name: '聆听', base: 20 },
  { key: 'libraryUse', name: '图书馆使用', base: 20 },
  { key: 'dodge', name: '闪避', base: 0 },
  { key: 'creditRating', name: '信用评级', base: 0 },
  { key: 'persuade', name: '说服', base: 10 },
  { key: 'psychology', name: '心理学', base: 10 },
  { key: 'firstAid', name: '急救', base: 30 },
  { key: 'medicine', name: '医学', base: 1 },
  { key: 'occult', name: '神秘学', base: 5 },
  { key: 'stealth', name: '潜行', base: 20 },
  { key: 'fighting', name: '格斗', base: 25 },
  { key: 'firearms', name: '射击', base: 20 },
  { key: 'nativeLanguage', name: '母语', base: 0 },
] as const;

export const coc7OccupationProfiles = [
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
] as const;

const attributeKeys = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'] as const;
const skillByKey = new Map(coc7SkillDefinitions.map((skill) => [skill.key, skill]));
const skillNameToKey = new Map<string, string>(coc7SkillDefinitions.flatMap((skill) => [[skill.key.toLowerCase(), skill.key], [skill.name, skill.key]]));
[
  ['力量', 'str'],
  ['体质', 'con'],
  ['体型', 'siz'],
  ['敏捷', 'dex'],
  ['外貌', 'app'],
  ['智力', 'int'],
  ['意志', 'pow'],
  ['教育', 'edu'],
  ['幸运', 'luck'],
].forEach(([name, key]) => skillNameToKey.set(name, key));

export function normalizeCoc7SkillKey(value: string) {
  return skillNameToKey.get(value.trim()) ?? skillNameToKey.get(value.trim().toLowerCase()) ?? value.trim();
}

function occupationFor(name: string) {
  return coc7OccupationProfiles.find((profile) => profile.name === name || profile.key === name) ?? coc7OccupationProfiles[0];
}

function safeAttribute(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

export function defaultCoc7Attributes(input: Partial<Coc7Attributes> = {}): Coc7Attributes {
  const attributes = {
    str: safeAttribute(input.str, 50),
    con: safeAttribute(input.con, 50),
    siz: safeAttribute(input.siz, 60),
    dex: safeAttribute(input.dex, 50),
    app: safeAttribute(input.app, 50),
    int: safeAttribute(input.int, 60),
    pow: safeAttribute(input.pow, 50),
    edu: safeAttribute(input.edu, 60),
    luck: safeAttribute(input.luck, 50),
  };
  return attributes;
}

function baseForSkill(key: string, attributes: Coc7Attributes) {
  if (key === 'dodge') {
    return Math.floor(attributes.dex / 2);
  }
  if (key === 'nativeLanguage') {
    return attributes.edu;
  }
  return skillByKey.get(key as never)?.base ?? 0;
}

function safeSkillNumber(value: unknown, fallback = 0) {
  return Math.max(0, Math.round(typeof value === 'number' && Number.isFinite(value) ? value : fallback));
}

export function defaultCoc7Skills(attributes: Coc7Attributes): Coc7SkillPoint[] {
  return coc7SkillDefinitions.map((skill) => ({
    key: skill.key,
    name: skill.name,
    base: baseForSkill(skill.key, attributes),
    occupation: 0,
    interest: 0,
    growth: 0,
  }));
}

export function deriveCoc7Stats(attributes: Coc7Attributes, age = 30) {
  const hp = Math.floor((attributes.con + attributes.siz) / 10);
  const mp = Math.floor(attributes.pow / 5);
  const strSiz = attributes.str + attributes.siz;
  let db = '-2';
  let build = -2;
  if (strSiz >= 65 && strSiz <= 84) {
    db = '-1';
    build = -1;
  } else if (strSiz >= 85 && strSiz <= 124) {
    db = '0';
    build = 0;
  } else if (strSiz >= 125 && strSiz <= 164) {
    db = '+1d4';
    build = 1;
  } else if (strSiz >= 165 && strSiz <= 204) {
    db = '+1d6';
    build = 2;
  } else if (strSiz > 204) {
    const extra = Math.ceil((strSiz - 204) / 80);
    db = `+${2 + extra}d6`;
    build = 2 + extra;
  }

  let mov = attributes.dex < attributes.siz && attributes.str < attributes.siz ? 7 : 8;
  if (attributes.dex > attributes.siz && attributes.str > attributes.siz) {
    mov = 9;
  }
  if (age >= 80) mov -= 5;
  else if (age >= 70) mov -= 4;
  else if (age >= 60) mov -= 3;
  else if (age >= 50) mov -= 2;
  else if (age >= 40) mov -= 1;

  return {
    hp,
    maxHp: hp,
    mp,
    maxMp: mp,
    san: attributes.pow,
    maxSan: attributes.pow,
    mov: Math.max(1, mov),
    db,
    build,
  };
}

function occupationPool(formula: string, attributes: Coc7Attributes) {
  const tokens = formula.match(/[a-z]+|\d+|[+*]/gi) ?? [];
  let total = 0;
  let pending: '+' | '*' = '+';
  for (const token of tokens) {
    if (token === '+' || token === '*') {
      pending = token;
      continue;
    }
    const key = token.toLowerCase() as keyof Coc7Attributes;
    const value = key in attributes ? attributes[key] : Number(token);
    if (!Number.isFinite(value)) {
      continue;
    }
    total = pending === '*' ? total * value : total + value;
  }
  return total;
}

export function normalizeCharacterSheet(sheet: CharacterSheet): CharacterSheet {
  const attributes = defaultCoc7Attributes(sheet.attributes);
  const derived = deriveCoc7Stats(attributes, sheet.age);
  const byKey = new Map(sheet.skills.map((skill) => [skill.key, skill]));
  const skills = defaultCoc7Skills(attributes).map((skill) => {
    const existing = byKey.get(skill.key);
    return {
      ...skill,
      ...existing,
      base: baseForSkill(skill.key, attributes),
      name: existing?.name || skill.name,
      occupation: safeSkillNumber(existing?.occupation),
      interest: safeSkillNumber(existing?.interest),
      growth: safeSkillNumber(existing?.growth),
    };
  });
  const knownKeys = new Set(skills.map((skill) => skill.key));
  const knownNames = new Set(skills.map((skill) => skill.name.trim().toLowerCase()));
  const customSkills = sheet.skills
    .map((skill) => {
      const key = skill.key.trim() || skill.name.trim();
      const name = skill.name.trim() || key;
      return {
        key,
        name,
        base: safeSkillNumber(skill.base),
        occupation: safeSkillNumber(skill.occupation),
        interest: safeSkillNumber(skill.interest),
        growth: safeSkillNumber(skill.growth),
      };
    })
    .filter((skill) => {
      if (!skill.key || knownKeys.has(skill.key) || knownNames.has(skill.name.toLowerCase())) {
        return false;
      }
      knownKeys.add(skill.key);
      knownNames.add(skill.name.toLowerCase());
      return true;
    });
  return {
    ...sheet,
    attributes,
    derived,
    skills: [...skills, ...customSkills],
  };
}

export function validateCharacterSheet(sheet: CharacterSheet) {
  const normalized = normalizeCharacterSheet(sheet);
  const errors: string[] = [];
  for (const key of attributeKeys) {
    const value = normalized.attributes[key];
    const min = key === 'siz' ? 40 : 15;
    if (value < min || value > 90) {
      errors.push(`${key.toUpperCase()} 必须在 ${min}-90 之间`);
    }
  }
  if (normalized.age < 15 || normalized.age > 90) {
    errors.push('年龄必须在 15-90 之间');
  }

  const occupation = occupationFor(normalized.occupation);
  const occupationLimit = occupationPool(occupation.formula, normalized.attributes);
  const occupationUsed = normalized.skills.reduce((sum, skill) => sum + skill.occupation, 0);
  const interestUsed = normalized.skills.reduce((sum, skill) => sum + skill.interest, 0);
  const interestLimit = normalized.attributes.int * 2;
  const growthUsed = normalized.skills.reduce((sum, skill) => sum + skill.growth, 0);
  if (occupationUsed > occupationLimit) {
    errors.push(`职业技能点超出上限：${occupationUsed}/${occupationLimit}`);
  }
  if (interestUsed > interestLimit) {
    errors.push(`兴趣技能点超出上限：${interestUsed}/${interestLimit}`);
  }
  if (growthUsed !== 0 && normalized.status !== 'approved') {
    errors.push('车卡阶段成长点必须为 0');
  }

  const occupationSkills = new Set<string>(occupation.skills);
  const background = normalized.background.description;
  for (const skill of normalized.skills) {
    const finalValue = skill.base + skill.occupation + skill.interest + skill.growth;
    if (finalValue > 90 && skill.key !== 'creditRating') {
      errors.push(`${skill.name} 不能高于 90`);
    }
    if (skill.key === 'creditRating' && (finalValue < occupation.crMin || finalValue > occupation.crMax)) {
      errors.push(`信用评级必须在 ${occupation.crMin}-${occupation.crMax} 之间`);
    }
    if (skill.occupation > 0 && skill.key !== 'creditRating' && !occupationSkills.has(skill.key)) {
      const tagA = `[skill:${skill.name}]`;
      const tagB = `[skill:${skill.key}]`;
      if (!background.includes(tagA) && !background.includes(tagB)) {
        errors.push(`${skill.name} 不是 ${occupation.name} 的本职技能，需要在背景中写明 ${tagA}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    sheet: normalized,
    occupationPool: occupationLimit,
    interestPool: interestLimit,
  };
}

export function buildCharacterSheet(input: Partial<CharacterSheet> & Pick<CharacterSheet, 'ownerId' | 'ownerName'>): CharacterSheet {
  const attributes = defaultCoc7Attributes(input.attributes);
  const timestamp = new Date().toISOString();
  return normalizeCharacterSheet({
    id: input.id || `sheet-${Math.random().toString(36).slice(2, 10)}`,
    ownerId: input.ownerId,
    ownerName: input.ownerName,
    scriptCharacterId: input.scriptCharacterId,
    status: input.status ?? 'draft',
    name: input.name?.trim() || '未命名调查员',
    occupation: input.occupation?.trim() || coc7OccupationProfiles[0].name,
    age: safeAttribute(input.age, 30),
    sex: input.sex?.trim() || '',
    residence: input.residence?.trim() || '',
    birthplace: input.birthplace?.trim() || '',
    attributes,
    derived: deriveCoc7Stats(attributes, input.age),
    skills: input.skills?.length ? input.skills : defaultCoc7Skills(attributes),
    background: {
      description: input.background?.description ?? '',
      ideology: input.background?.ideology ?? '',
      significantPeople: input.background?.significantPeople ?? '',
      locations: input.background?.locations ?? '',
      possessions: input.background?.possessions ?? '',
      traits: input.background?.traits ?? '',
    },
    reviewerNotes: input.reviewerNotes ?? '',
    reviewedAt: input.reviewedAt,
    reviewedBy: input.reviewedBy,
    confirmedAt: input.confirmedAt,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  });
}

export function applySheetStatus(sheet: CharacterSheet, status: CharacterSheetStatus, reviewer?: { id: string; notes?: string }) {
  return normalizeCharacterSheet({
    ...sheet,
    status,
    reviewerNotes: reviewer?.notes ?? sheet.reviewerNotes ?? '',
    reviewedAt: reviewer ? new Date().toISOString() : sheet.reviewedAt,
    reviewedBy: reviewer?.id ?? sheet.reviewedBy,
    confirmedAt: status === 'approved' ? sheet.confirmedAt : undefined,
    updatedAt: new Date().toISOString(),
  });
}

export function statBlockFromSheet(sheet: CharacterSheet) {
  const normalized = normalizeCharacterSheet(sheet);
  return {
    accountId: normalized.ownerId,
    attributes: normalized.attributes,
    skills: Object.fromEntries(
      normalized.skills.map((skill) => [skill.key, skill.base + skill.occupation + skill.interest + skill.growth]),
    ),
    skillNames: Object.fromEntries(normalized.skills.map((skill) => [skill.key, skill.name])),
    ...normalized.derived,
  };
}

export function coc7SuccessLevel(roll: number, target: number) {
  if (roll === 1) {
    return 'critical' as const;
  }
  if ((target < 50 && roll >= 96) || roll === 100) {
    return 'fumble' as const;
  }
  if (roll > target) {
    return 'failure' as const;
  }
  if (roll <= Math.floor(target / 5)) {
    return 'extreme' as const;
  }
  if (roll <= Math.floor(target / 2)) {
    return 'hard' as const;
  }
  return 'regular' as const;
}

export function rollCoc7Check(target: number, label: string) {
  const total = Math.floor(Math.random() * 100) + 1;
  const successLevel = coc7SuccessLevel(total, target);
  const outcome = successLevel === 'failure' || successLevel === 'fumble' ? 'failure' as const : 'success' as const;
  return {
    formula: `1d100<=${target}`,
    total,
    rolls: [total],
    modifier: 0,
    target,
    comparator: '<=' as const,
    outcome,
    successLevel,
    text: `${label} ${total}/${target} ${successLevel}`,
  };
}
