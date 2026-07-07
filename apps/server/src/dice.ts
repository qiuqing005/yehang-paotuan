import { randomInt } from 'node:crypto';

export type DiceRollResult = {
  formula: string;
  total: number;
  rolls: number[];
  modifier: number;
  target?: number;
  comparator?: '<=' | '>=' | '<' | '>' | '=';
  outcome?: 'success' | 'failure';
  text: string;
};

export function normalizeDiceFormula(input: string) {
  return input
    .trim()
    .replace(/[≤≦]/g, '<=')
    .replace(/[≥≧]/g, '>=')
    .replace(/[＝]/g, '=')
    .replace(/[＋]/g, '+')
    .replace(/[－]/g, '-')
    .replace(/^[./。]r\s+/i, '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

export function isDiceFormulaSupported(input: string) {
  const trimmed = input.trim();
  if (/^\.ra\s+\S+/i.test(trimmed)) {
    return true;
  }
  return /^(\d{0,2})d(\d{1,4})([+-]\d{1,4})?(?:(<=|>=|<|>|=)\d{1,5})?$/.test(normalizeDiceFormula(trimmed));
}

export function rollDiceFormula(input: string): DiceRollResult | null {
  const normalized = normalizeDiceFormula(input);
  const match = normalized.match(/^(\d{0,2})d(\d{1,4})([+-]\d{1,4})?(?:(<=|>=|<|>|=)(\d{1,5}))?$/);
  if (!match) {
    return null;
  }

  const count = Math.min(Math.max(Number(match[1] || 1), 1), 20);
  const sides = Math.min(Math.max(Number(match[2]), 2), 1000);
  const modifier = Number(match[3] ?? 0);
  const comparator = match[4] as DiceRollResult['comparator'] | undefined;
  const target = match[5] ? Number(match[5]) : undefined;
  const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
  const total = rolls.reduce((sum, value) => sum + value, 0) + modifier;
  const notation = `${count}d${sides}${modifier ? (modifier > 0 ? `+${modifier}` : modifier) : ''}`;
  const formula = `${notation}${comparator && target !== undefined ? `${comparator}${target}` : ''}`;
  let outcome: DiceRollResult['outcome'];
  if (comparator && target !== undefined) {
    const passed =
      comparator === '<=' ? total <= target :
      comparator === '>=' ? total >= target :
      comparator === '<' ? total < target :
      comparator === '>' ? total > target :
      total === target;
    outcome = passed ? 'success' : 'failure';
  }
  const text = `${formula} = ${total} (${rolls.join(' + ')}${modifier ? ` ${modifier > 0 ? '+' : '-'} ${Math.abs(modifier)}` : ''})`;

  return {
    formula,
    total,
    rolls,
    modifier,
    ...(target !== undefined ? { target } : {}),
    ...(comparator ? { comparator } : {}),
    ...(outcome ? { outcome } : {}),
    text,
  };
}
