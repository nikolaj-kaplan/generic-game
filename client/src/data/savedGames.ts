import type { PlayerRange, SavedProgram } from '../types';

/** Rules the host saved after a game, kept in this browser (localStorage). */
export interface SavedGame {
  id: string;
  title: string;
  rules: string;
  playerRange?: PlayerRange;
  /** The game program written for these rules (skips writing it again). */
  program?: SavedProgram;
  savedAt: string;
}

const KEY = 'gg_savedGames';

export function loadSavedGames(): SavedGame[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedGame[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** "GAME: Imposter — a social deduction game" → "Imposter". */
export function titleFromRules(rules: string): string {
  const line = rules.split('\n').find((l) => /^\s*GAME\s*:/i.test(l)) ?? rules.split('\n')[0] ?? 'Saved game';
  const name = line.replace(/^\s*GAME\s*:\s*/i, '').split(/\s[—–-]\s|[.:]/)[0].trim();
  return (name || 'Saved game').slice(0, 40);
}

export function saveGame(rules: string, playerRange?: PlayerRange, program?: SavedProgram | null): SavedGame {
  const game: SavedGame = {
    id: `${Date.now()}`,
    title: titleFromRules(rules),
    rules,
    playerRange,
    ...(program && program.rules === rules ? { program } : {}),
    savedAt: new Date().toISOString(),
  };
  // Same rules saved again replace the old entry
  const list = [game, ...loadSavedGames().filter((g) => g.rules !== rules)].slice(0, 30);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: nothing to do */
  }
  return game;
}

export function deleteSavedGame(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadSavedGames().filter((g) => g.id !== id)));
  } catch {
    /* ignore */
  }
}

export function rangeLabel(range?: PlayerRange): string {
  if (!range) return '';
  if (range.min === range.max) return `${range.min} player${range.min === 1 ? '' : 's'}`;
  return `${range.min}–${range.max} players`;
}
