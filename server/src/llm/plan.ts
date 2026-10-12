import { Player, PendingTurn } from '../types';

// =============================================================================
// Game plan: rounds and phases written by the AI, bookkeeping done by the server
//
// The plan is data the AI invents per game (phase names, timers, content).
// The plan is a help, not a rulebook: the server tracks where the game is,
// reminds the AI, applies phase timers and records every answer under
// round/phase. It never refuses a turn because of the plan, so games that
// don't fit "N rounds x fixed phases" still work. Games without a plan work too.
// =============================================================================

export interface PlanPhase {
  id: string;
  description?: string;
  /** Seconds players get in this phase (applied when the AI forgets timer_seconds). */
  timer_seconds?: number;
}

export interface GamePlan {
  rounds: number;
  phases: PlanPhase[];
  /** Anything the AI decides up front (secret words per round, question bank, …). */
  content?: Record<string, unknown>;
}

export interface Progress {
  round: number;
  phase: string;
  /** True once the last phase of the last round has been shown. */
  finalPhase: boolean;
}

/** Keys the server owns; the AI cannot overwrite them through state_update. */
export const RESERVED_STATE_KEYS = ['plan', 'progress', 'answers'];

const MAX_ROUNDS = 50;
const MAX_PHASES = 12;

export function parsePlan(raw: unknown): { plan?: GamePlan; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: '"plan" must be an object {"rounds": n, "phases": [...]}.' };
  const r = raw as Record<string, unknown>;
  const rounds = Math.round(Number(r.rounds ?? 1));
  if (!Number.isFinite(rounds) || rounds < 1 || rounds > MAX_ROUNDS) return { error: `"plan.rounds" must be between 1 and ${MAX_ROUNDS}.` };
  if (!Array.isArray(r.phases) || r.phases.length === 0 || r.phases.length > MAX_PHASES) {
    return { error: `"plan.phases" must list 1-${MAX_PHASES} phases, e.g. [{"id": "answer", "timer_seconds": 30}, {"id": "reveal"}].` };
  }
  const phases: PlanPhase[] = [];
  for (const p of r.phases) {
    const o = (typeof p === 'string' ? { id: p } : p) as Record<string, unknown>;
    const id = typeof o?.id === 'string' ? o.id.trim() : '';
    if (!id) return { error: 'Every phase in "plan.phases" needs an "id".' };
    if (phases.some((x) => x.id === id)) return { error: `Phase id "${id}" is used twice in the plan.` };
    const timer = Number(o.timer_seconds);
    phases.push({
      id,
      ...(typeof o.description === 'string' ? { description: o.description } : {}),
      ...(Number.isFinite(timer) && timer > 0 ? { timer_seconds: Math.round(timer) } : {}),
    });
  }
  const content = typeof r.content === 'object' && r.content !== null && !Array.isArray(r.content) ? (r.content as Record<string, unknown>) : undefined;
  return { plan: { rounds, phases, ...(content ? { content } : {}) } };
}

/**
 * Where the game is after this turn. The AI may name the round itself; without
 * it, going back to an earlier (or the same) phase counts as the next round.
 * Never an error: the plan only informs.
 */
export function advance(
  plan: GamePlan,
  current: Progress | undefined,
  phaseId: string | undefined,
  explicitRound?: number,
): Progress {
  const ids = plan.phases.map((p) => p.id);
  const known = phaseId && ids.includes(phaseId) ? phaseId : undefined;
  const phase = known ?? current?.phase ?? ids[0];
  let round: number;
  if (explicitRound !== undefined && Number.isFinite(explicitRound) && explicitRound >= 1) round = Math.round(explicitRound);
  else if (!current) round = 1;
  else if (!known || known === current.phase) round = current.round;
  else round = ids.indexOf(known) < ids.indexOf(current.phase) ? current.round + 1 : current.round;
  return { round, phase, finalPhase: round >= plan.rounds && phase === ids[ids.length - 1] };
}

/** "Where are we" line sent with every event. */
export function progressLine(plan: GamePlan | undefined, progress: Progress | undefined): string {
  if (!plan || !progress) return '';
  const ids = plan.phases.map((p) => p.id);
  const i = ids.indexOf(progress.phase);
  const phase = plan.phases[i];
  const next =
    i < ids.length - 1
      ? `next phase: "${ids[i + 1]}" (same round)`
      : progress.round < plan.rounds
        ? `next: round ${progress.round + 1}, phase "${ids[0]}"`
        : 'this was the last phase of the last planned round: end the game next, unless the rules say otherwise';
  return (
    `\nPLAN PROGRESS: round ${progress.round} of ${plan.rounds}, current phase "${progress.phase}"` +
    `${phase?.description ? ` (${phase.description})` : ''}; ${next}. Set "phase" (and "round" if it is not what the server assumes) for your next screens.`
  );
}

export function phaseTimer(plan: GamePlan | undefined, progress: Progress | undefined): number | undefined {
  return plan?.phases.find((p) => p.id === progress?.phase)?.timer_seconds;
}

/**
 * Record a finished turn's answers in state.answers so the AI never has to
 * copy (or invent) them: answers.round2.vote.Ana = "Bob". Without a plan the
 * key is the turn number.
 */
export function recordAnswers(
  state: Record<string, unknown>,
  pending: PendingTurn,
  players: Player[],
): Record<string, unknown> {
  if (pending.responses.length === 0) return state;
  const plan = state.plan as GamePlan | undefined;
  const progress = state.progress as Progress | undefined;
  const answers = { ...((state.answers as Record<string, Record<string, Record<string, unknown>>>) ?? {}) };
  const outer = plan && progress ? `round${progress.round}` : `turn${pending.turn}`;
  const bucket = { ...(answers[outer] ?? {}) };
  for (const r of pending.responses) {
    const name = players.find((p) => p.id === r.playerId)?.name ?? r.playerName;
    const inner = plan && progress ? progress.phase : r.id;
    const values = r.values ?? {};
    const keys = Object.keys(values);
    const value = r.kind === 'action' ? `clicked ${r.id}` : keys.length === 1 ? values[keys[0]] : values;
    bucket[inner] = { ...(bucket[inner] ?? {}), [name]: value };
  }
  answers[outer] = bucket;
  // Without a plan, keep only the most recent turns to bound the prompt size.
  if (!plan) {
    const turnKeys = Object.keys(answers).filter((k) => k.startsWith('turn'));
    for (const k of turnKeys.slice(0, Math.max(0, turnKeys.length - 12))) delete answers[k];
  }
  return { ...state, answers };
}
