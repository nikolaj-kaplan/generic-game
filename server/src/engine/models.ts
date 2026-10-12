import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../paths';
import { llmConfig } from '../llm/client';

// =============================================================================
// Model routing. Programs never name a model: every g.ai call carries a
// complexity from 1 to 5, and models.json maps the numbers to models.
// The best model (the "generator") writes and fixes the game programs.
//
// models.json (project root, optional; GAME_MODELS_FILE overrides the path):
// {
//   "models": {
//     "local":  { "baseUrl": "http://localhost:11434/v1", "model": "gemma4:26b-a4b-it-qat" },
//     "strong": { "baseUrl": "http://127.0.0.1:11435/v1", "model": "bridge", "apiKeyEnv": "NONE" }
//   },
//   "complexity": { "1": "local", "2": "local", "3": "local", "4": "strong", "5": "strong" },
//   "generator": "strong"
// }
// Without the file (or with GAME_MODELS_FILE=none, as in automated tests), every
// level and the generator use the LLM_* settings from .env.
// =============================================================================

export interface ModelEndpoint {
  baseUrl: string;
  model: string;
  /** Env variable holding the API key (default: LLM_API_KEY / OPENROUTER_API_KEY). */
  apiKeyEnv?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
}

export interface ResolvedModel extends Omit<ModelEndpoint, 'apiKeyEnv'> {
  name: string;
  apiKey?: string;
}

interface ModelsFile {
  models: Record<string, ModelEndpoint>;
  complexity?: Record<string, string>;
  generator?: string;
}

/** What each complexity is good for; sent to the generator so it can pick numbers. */
export const COMPLEXITY_GUIDE: Record<number, string> = {
  1: 'pick from given options, yes/no checks, lists of well-known things (fastest, about 1 s)',
  2: 'simple creative content: prompts, words, short descriptions',
  3: 'content that must be correct: trivia questions with answers, honest answers about a secret',
  4: 'judging free text: which answer fits best, is a guess close enough',
  5: 'subtle judgment: humour, nuance, fairness (slowest, can take 10 s or more)',
};

function modelsFile(): string {
  return process.env.GAME_MODELS_FILE ? path.resolve(process.env.GAME_MODELS_FILE) : path.join(PROJECT_ROOT, 'models.json');
}

function fromEnv(): ResolvedModel {
  const c = llmConfig();
  return {
    name: 'default',
    baseUrl: c.baseUrl,
    model: c.model,
    apiKey: c.apiKey,
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    reasoningEffort: c.reasoningEffort,
  };
}

function resolve(name: string, file: ModelsFile): ResolvedModel {
  const m = file.models[name];
  if (!m) throw new Error(`models.json: unknown model "${name}"`);
  const apiKey = m.apiKeyEnv ? process.env[m.apiKeyEnv] : (process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY);
  return { name, baseUrl: m.baseUrl, model: m.model, apiKey, temperature: m.temperature, maxTokens: m.maxTokens, reasoningEffort: m.reasoningEffort };
}

function readFile(): ModelsFile | undefined {
  // Automated tests set GAME_MODELS_FILE=none: everything then uses the LLM_* settings (a local model).
  if (process.env.GAME_MODELS_FILE === 'none') return undefined;
  const file = modelsFile();
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as ModelsFile;
}

/** The model for a g.ai call of this complexity. */
export function modelForComplexity(complexity: number): ResolvedModel {
  const file = readFile();
  if (!file) return fromEnv();
  const level = String(Math.min(5, Math.max(1, Math.round(complexity))));
  const name = file.complexity?.[level] ?? file.generator ?? Object.keys(file.models)[0];
  return resolve(name, file);
}

/** The best model: writes and fixes programs. GAME_GENERATOR_MODEL picks another entry from models.json. */
export function generatorModel(): ResolvedModel {
  const file = readFile();
  if (!file) return fromEnv();
  const name = process.env.GAME_GENERATOR_MODEL ?? file.generator ?? file.complexity?.['5'] ?? Object.keys(file.models)[0];
  return resolve(name, file);
}

export function namedModel(name: string): ResolvedModel {
  const file = readFile();
  if (!file) {
    if (name === 'default') return fromEnv();
    throw new Error(`No models.json, so there is no model named "${name}"`);
  }
  return resolve(name, file);
}

/** "1: local, 2: local, …" for logs and reports. */
export function routingSummary(): string {
  const file = readFile();
  if (!file) return `all levels and the generator: ${fromEnv().model} (from .env)`;
  const levels = [1, 2, 3, 4, 5].map((l) => `${l}: ${file.complexity?.[String(l)] ?? file.generator}`).join(', ');
  return `${levels}; generator: ${process.env.GAME_GENERATOR_MODEL ?? file.generator}`;
}
