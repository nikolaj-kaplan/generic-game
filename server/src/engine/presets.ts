import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../paths';

// =============================================================================
// Hand-written programs for the preset games. They test the library, serve as
// examples in the generator prompt, and are the reference for "how a program
// should look".
// =============================================================================

export const PRESETS_DIR = path.join(PROJECT_ROOT, 'server', 'src', 'engine', 'presets');

export interface PresetProgram {
  id: string;
  code: string;
  range: { min: number; max: number };
}

/** Player ranges of the presets (same as client/src/data/presets.ts). */
export const PRESET_RANGES: Record<string, { min: number; max: number }> = {
  'twenty-questions': { min: 1, max: 1 },
  'quiz-battle': { min: 2, max: 2 },
  'most-likely': { min: 3, max: 8 },
  'memory-flash': { min: 1, max: 1 },
  imposter: { min: 3, max: 8 },
  'funny-answers': { min: 3, max: 8 },
  'band-buzzer': { min: 1, max: 4 },
  'two-truths': { min: 3, max: 8 },
};

export function presetProgram(id: string): PresetProgram {
  const code = fs.readFileSync(path.join(PRESETS_DIR, `${id}.js`), 'utf-8');
  return { id, code, range: PRESET_RANGES[id] ?? { min: 1, max: 8 } };
}

export function allPresetPrograms(): PresetProgram[] {
  return Object.keys(PRESET_RANGES).map(presetProgram);
}
