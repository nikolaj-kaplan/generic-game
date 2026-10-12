import { chat } from '../llm/client';
import { extractJsonObject } from '../llm/turn';
import type { LLMMessage } from '../types';
import { botTest, BotReport } from './botTest';
import { COMPLEXITY_GUIDE, generatorModel, ResolvedModel } from './models';
import { presetProgram } from './presets';
import { describeProgram, EnginePlayer, EngineState, ProgramInfo, runDispatch } from './sandbox';
import { apiDeclarations, checkProgramSource } from './typecheck';
import { fakeAi } from './botTest';

// =============================================================================
// Program generator: the best model turns the agreed rules into a program,
// and later patches it when the host asks for a change mid-game. Every
// program passes three checks before anyone plays it: it loads, it type-checks
// against game-api.d.ts, and 20 bot games run without problems. Failures go
// back to the model, up to MAX_ATTEMPTS times.
// =============================================================================

const MAX_ATTEMPTS = 3;
const EXAMPLES = ['most-likely', 'band-buzzer', 'two-truths'];

export interface CheckResult {
  ok: boolean;
  problems: string[];
  info?: ProgramInfo;
  bots?: BotReport;
}

export interface GenerateResult {
  ok: boolean;
  program?: string;
  info?: ProgramInfo;
  summary?: string;
  assumptions: string[];
  /** The model asked instead of writing a program. */
  questions?: string;
  migration?: string;
  attempts: number;
  problems: string[];
  bots?: BotReport;
  model: string;
  ms: number;
}

export interface GenerateOptions {
  logDir?: string;
  model?: ResolvedModel;
  /** Leave this preset out of the examples (for fair evaluations). */
  excludeExample?: string;
  onProgress?: (message: string) => void;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    program: { type: 'string', description: 'The complete program (JavaScript). Empty only when asking questions.' },
    migration: { type: 'string', description: 'Patch only: code defining async function migrate(g), or "".' },
    summary: { type: 'string', description: 'One sentence for the host: what the program does, or what the change does.' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'Decisions you made where the rules were unclear.' },
    questions: { type: 'string', description: 'Only when the rules are too unclear to write any sensible game: your questions. Otherwise "".' },
  },
  required: ['program', 'migration', 'summary', 'assumptions', 'questions'],
};

function systemPrompt(excludeExample?: string): string {
  const examples = EXAMPLES.filter((id) => id !== excludeExample)
    .map((id) => `// ===== Example: ${id} =====\n${presetProgram(id).code.trim()}`)
    .join('\n\n');
  const guide = Object.entries(COMPLEXITY_GUIDE).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return `You write game programs for a multiplayer party-game engine. Players use phones; the engine shows each player their screen, waits for answers, runs timers, keeps scores and shows the end screen. You write one JavaScript program that calls defineGame({...}) and implements the agreed rules exactly.

THE API (TypeScript declarations; the program is JavaScript and may use only this):
\`\`\`ts
${apiDeclarations()}
\`\`\`

HOW TO WRITE A GOOD PROGRAM
- Use the library for everything it offers: phases (collect/turn/buzzer/show/slides), ui.*, g.scores, tally, match, g.random. Write as little custom code as possible.
- Do in code what code can do: counting, scoring, shuffling, string changes (hiding letters), comparing answers (match.close). Never ask the AI to transform data; ask for plain data and transform it in code.
- Create ALL content up front, in setup(), in as few g.ai calls as possible (ideally one). Ask for MORE than needed (about 3x the rounds) and pick with g.random.sample, so every game is different. Players wait for every AI call; a call during play is a pause in the game.
- Put everything needed to judge answers into that same up-front data, e.g. { band, alsoAccepted: [...] } so a guess is checked with match.close in code. Call g.ai during play only for what cannot be prepared: judging text players wrote, answering a player's question.
- Every g.ai prompt must be self-contained: the AI does not see the rules or the game. Say what you need, for what kind of game, the tone and the language (the language of the rules).
- Pick the lowest complexity that works for each g.ai call:
${guide}
- g.state must stay plain JSON. Decide random things (who is the imposter, option order) in enter() or setup() and store them in g.state. input/view/waiting functions must not change g.state or use g.random: they are called again whenever a screen is drawn.
- One kind of input per screen: one ui.choice OR one ui.pickPlayer OR text inputs (a Submit button is added) OR buttons.
- Answers: g.answers.<phaseId>[playerId]. A player who did not answer in time has no entry. Text inputs give the typed text (several inputs give { id: text }).
- Players who must not see something (secrets, their own answer in a vote) get a different screen: input/view receive \`me\`.
- Do not repeat what the engine already shows: the countdown, "Round x of y", the scoreboard (see the scoreboard option), who is still answering, the end message. Show it yourself only with scoreboard: 'never'.
- When the program changes or fills in something the players chose (a duplicate category replaced, a missing answer), say so on screen.
- Use timers where the rules say so. Give reveal phases show({ seconds: 5–15 }) or no seconds (the host continues).
- Keep clicks down: no screen that only waits for a Continue click when its information fits on the next screen (e.g. show the last answer at the top of the next question screen instead of a separate answer screen).
- End the game with g.end() (the winner by score is announced) or g.end('custom message').
- Every phase must lead somewhere: the game must always end. Guard against loops that only bots could break.
- Write all player-facing text in the language of the rules.
- Where the rules leave something open, choose what makes the best game and list it in "assumptions".
- Ask questions (and leave "program" empty) only when the rules are too unclear to write any sensible game.

EXAMPLE PROGRAMS
\`\`\`js
${examples}
\`\`\`

REPLY FORMAT: one JSON object: {"program": "<the whole program>", "migration": "", "summary": "<one sentence>", "assumptions": ["..."], "questions": ""}`;
}

function newGameRequest(rules: string, range: { min: number; max: number } | undefined): string {
  return `Write the program for these agreed rules.\n\nRULES:\n${rules}\n\nPLAYERS: ${range ? `${range.min}–${range.max}` : 'any number'}`;
}

function patchRequest(input: PatchInput): string {
  const e = input.engine;
  const snapshot = e
    ? JSON.stringify(
        {
          phase: e.phase,
          round: e.round,
          rounds: e.rounds,
          state: e.state,
          scores: e.scores,
          answersThisRound: e.answers[`r${e.round}`] ?? {},
          over: e.over,
        },
        null,
        1,
      )
    : '(the game has not started)';
  return `A game is running and the host wants a change. Write the complete new program, and a migration if the current state must change.

ORIGINAL RULES:
${input.rules}

EARLIER ADJUSTMENTS (oldest first; a later one wins over the rules and earlier ones):
${input.adjustments.length ? input.adjustments.map((a, i) => `${i + 1}. ${a}`).join('\n') : '(none)'}

CURRENT PROGRAM:
\`\`\`js
${input.program}
\`\`\`

PLAYERS: ${input.players.map((p) => `${p.name} (${p.id})`).join(', ')}

CURRENT STATE (the game continues from here):
${snapshot}
${input.error ? `\nTHE PROGRAM CRASHED WITH THIS ERROR (fix it):\n${input.error}\n` : ''}
HOST REQUEST: ${input.request}

The new program replaces the old one; the state above is kept. If the state must change (new content, other rounds, renamed fields), write "migration" as JavaScript defining \`async function migrate(g)\`: it runs once with the new program, can change g.state, g.scores, g.setRounds() and call g.ai, and may return a Next (a phase id, g.nextRound(...) or g.end()) to jump; returning nothing stays in the current phase, whose screens are redrawn with the new program. If the current phase no longer exists, migrate must return where to continue. Keep phase ids that still make sense.
"summary": one short sentence for the host describing the change.`;
}

/** Load, type-check and bot-test a program. */
export async function checkProgram(
  program: string,
  range: { min: number; max: number },
  options: { runs?: number } = {},
): Promise<CheckResult> {
  const problems: string[] = [];
  let info: ProgramInfo | undefined;
  try {
    info = await describeProgram(program);
  } catch (err) {
    return { ok: false, problems: [`The program does not load: ${err instanceof Error ? err.message : String(err)}`] };
  }
  problems.push(...checkProgramSource(program));
  if (problems.length) return { ok: false, problems, info };
  const bots = await botTest(program, range, { runs: options.runs ?? 20, phaseIds: Object.keys(info.phases) });
  problems.push(...bots.problems.map((p) => `Bot test: ${p}`));
  if (bots.unreached.length && bots.ok) {
    problems.push(`Bot test: phase(s) ${bots.unreached.map((p) => `"${p}"`).join(', ')} were never reached in ${bots.runs.length} games. Remove them or make them reachable.`);
  }
  return { ok: problems.length === 0, problems, info, bots };
}

interface Draft {
  program: string;
  migration: string;
  summary: string;
  assumptions: string[];
  questions: string;
}

function parseDraft(content: string | null): Draft | null {
  const obj = extractJsonObject(content ?? '');
  if (!obj) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  let program = str(obj.program).trim();
  // Tolerate a fenced program inside the string.
  const fenced = /```(?:js|javascript)?\s*\n([\s\S]*?)```/.exec(program);
  if (fenced) program = fenced[1].trim();
  return {
    program,
    migration: str(obj.migration).trim(),
    summary: str(obj.summary).trim(),
    assumptions: Array.isArray(obj.assumptions) ? obj.assumptions.map(String) : [],
    questions: str(obj.questions).trim(),
  };
}

async function runLoop(
  messages: LLMMessage[],
  range: { min: number; max: number },
  options: GenerateOptions,
  phase: 'generate' | 'patch',
  extraCheck?: (draft: Draft, check: CheckResult) => Promise<string[]>,
): Promise<GenerateResult> {
  const model = options.model ?? generatorModel();
  const t0 = Date.now();
  let problems: string[] = [];
  let last: { draft?: Draft; check?: CheckResult } = {};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    options.onProgress?.(attempt === 1 ? 'Writing the game program…' : `Fixing the program (attempt ${attempt} of ${MAX_ATTEMPTS})…`);
    let content: string | null = null;
    try {
      const response = await chat({
        messages,
        endpoint: { ...model, maxTokens: model.maxTokens ?? 16000 },
        responseSchema: { name: 'game_program', schema: RESPONSE_SCHEMA },
        logDir: options.logDir,
        phase,
      });
      content = response.choices[0].message.content;
    } catch (err) {
      problems = [`The model could not be reached: ${err instanceof Error ? err.message : String(err)}`];
      break;
    }
    const draft = parseDraft(content);
    messages.push({ role: 'assistant', content: content ?? '' });
    if (!draft) {
      problems = ['The reply was not the requested JSON object.'];
      messages.push({ role: 'user', content: 'Reply with one JSON object in the requested format.' });
      continue;
    }
    if (!draft.program && draft.questions) {
      return { ok: false, questions: draft.questions, assumptions: draft.assumptions, attempts: attempt, problems: [], model: model.model, ms: Date.now() - t0 };
    }
    options.onProgress?.('Testing the program with bot players…');
    const check = await checkProgram(draft.program, range);
    const extra = check.ok && extraCheck ? await extraCheck(draft, check) : [];
    problems = [...check.problems, ...extra];
    last = { draft, check };
    if (problems.length === 0) {
      return {
        ok: true,
        program: draft.program,
        info: check.info,
        summary: draft.summary,
        assumptions: draft.assumptions,
        migration: draft.migration || undefined,
        attempts: attempt,
        problems: [],
        bots: check.bots,
        model: model.model,
        ms: Date.now() - t0,
      };
    }
    messages.push({
      role: 'user',
      content: `The program failed these checks:\n- ${problems.join('\n- ')}\n\nFix every problem and reply with the complete corrected program in the same JSON format.`,
    });
  }
  return {
    ok: false,
    program: last.draft?.program,
    info: last.check?.info,
    summary: last.draft?.summary,
    assumptions: last.draft?.assumptions ?? [],
    attempts: MAX_ATTEMPTS,
    problems,
    bots: last.check?.bots,
    model: model.model,
    ms: Date.now() - t0,
  };
}

/** Rules → a checked program. */
export async function generateProgram(
  rules: string,
  range: { min: number; max: number } | undefined,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt(options.excludeExample) },
    { role: 'user', content: newGameRequest(rules, range) },
  ];
  return runLoop(messages, range ?? { min: 1, max: 8 }, options, 'generate');
}

export interface PatchInput {
  rules: string;
  adjustments: string[];
  program: string;
  engine: EngineState | null;
  players: EnginePlayer[];
  request: string;
  error?: string;
  range: { min: number; max: number };
}

/** Try a migration on a copy of the running game, then let bots play on from there. */
async function checkPatch(input: PatchInput, draft: Draft): Promise<string[]> {
  if (!input.engine || input.engine.over) return [];
  try {
    const migrated = await runDispatch(
      draft.program,
      { engine: structuredClone(input.engine), players: input.players, event: draft.migration ? { type: 'migrate' } : { type: 'render' } },
      { ai: fakeAi(Math.random), migration: draft.migration || undefined },
    );
    if (migrated.over) return [];
    const bots = await botTest(draft.program, input.range, { runs: 6, from: migrated.engine, players: input.players });
    return bots.problems.map((p) => `Continuing the running game: ${p}`);
  } catch (err) {
    return [`Applying the change to the running game failed: ${err instanceof Error ? err.message : String(err)}`];
  }
}

/** A host's mid-game change → a checked new program (+ migration). */
export async function patchProgram(input: PatchInput, options: GenerateOptions = {}): Promise<GenerateResult> {
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: patchRequest(input) },
  ];
  return runLoop(messages, input.range, options, 'patch', (draft) => checkPatch(input, draft));
}
