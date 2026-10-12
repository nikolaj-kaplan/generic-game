import { LLMTool, Player } from '../types';
import type { GamePlan } from './plan';

// =============================================================================
// Definition-phase tools
// =============================================================================

export const definitionTools: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'propose_rules',
      description:
        'Propose the final rules once the game is clear. The host confirms before the game starts. ' +
        'Write them with the GAME / PLAYERS / SETUP / ROUND FLOW / SCORING / END / NOTES template.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'The complete rules, using the template headings. ' +
              'ROUND FLOW must say what each player sees, whether players act at the same time or in turns, and any timers.',
          },
          min_players: { type: 'number', description: 'Fewest players the game works with.' },
          max_players: { type: 'number', description: 'Most players the game works with.' },
        },
        required: ['summary', 'min_players', 'max_players'],
      },
    },
  },
];

// =============================================================================
// Playing phase: one next_turn per event
//
// Two protocols share the same schema:
//   tools: next_turn is a tool, forced with tool_choice "required"
//   json:  the reply itself must match the schema (response_format json_schema).
//          Ollama enforces this with a grammar, so small local models cannot
//          produce broken JSON.
// The schema is built per session so the only allowed screen keys are "all"
// and the real player ids.
// =============================================================================

const TEXT_AND_BUTTON_STYLES = ['heading', 'subheading', 'body', 'muted', 'success', 'error', 'primary', 'secondary', 'danger'];

/**
 * One flat schema for every component type. A flat object with optional fields
 * is easier for small models (and more providers) than a oneOf per type.
 */
const componentSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['text', 'multiple_choice', 'button', 'input', 'form', 'scoreboard', 'list', 'divider'],
    },
    content: { type: 'string', description: 'text: the text to show' },
    style: {
      type: 'string',
      enum: TEXT_AND_BUTTON_STYLES,
      description: 'text: heading | subheading | body | muted | success | error. button: primary | secondary | danger',
    },
    fieldId: { type: 'string', description: 'multiple_choice / input: key the answer is reported under' },
    question: { type: 'string', description: 'multiple_choice: the question' },
    options: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: { label: { type: 'string' }, owner: { type: 'string', description: 'player id who wrote it; hidden from that player' } },
            required: ['label'],
          },
        ],
      },
      description: 'multiple_choice: 2-6 options. Use {"label", "owner"} for answers written by players.',
    },
    correct: {
      type: 'string',
      description: 'multiple_choice: the right option (exactly as written in options). The server then shows each player instantly whether they were right and adds the points to state.scores.',
    },
    points: { type: 'number', description: 'multiple_choice with correct: points for a right answer (default 1).' },
    penalty: { type: 'number', description: 'multiple_choice with correct: points for a wrong answer, e.g. -1 (default 0).' },
    player_options: {
      type: 'string',
      enum: ['others', 'all'],
      description: 'multiple_choice: instead of options, list the players ("others" = everyone except the viewer).',
    },
    label: { type: 'string', description: 'button / input: visible label' },
    actionId: { type: 'string', description: 'button: id reported when clicked' },
    placeholder: { type: 'string', description: 'input: hint text' },
    formId: { type: 'string', description: 'form: id reported on submit' },
    fields: {
      type: 'array',
      description: 'form: input components',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['input'] },
          fieldId: { type: 'string' },
          label: { type: 'string' },
          placeholder: { type: 'string' },
        },
        required: ['type', 'fieldId'],
      },
    },
    submitLabel: { type: 'string', description: 'form: submit button label' },
    players: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, score: { type: 'number' } }, required: ['name', 'score'] },
      description: 'scoreboard: one entry per player',
    },
    items: { type: 'array', items: { type: 'string' }, description: 'list: the items' },
    ordered: { type: 'boolean', description: 'list: numbered or not' },
  },
  required: ['type'],
};

const screenSchema = { type: 'array', items: componentSchema };

/** JSON schema for next_turn arguments, with the session's player ids as screen keys. */
export function nextTurnSchema(players: Player[], plan?: GamePlan): Record<string, unknown> {
  const screenProps: Record<string, unknown> = {
    all: { ...screenSchema, description: 'Screen for everyone (unless a player has their own).' },
  };
  for (const p of players) {
    screenProps[p.id] = { ...screenSchema, description: `Screen only for ${p.name}; overrides "all".` };
  }
  return {
    type: 'object',
    properties: {
      state_update: {
        type: 'object',
        description:
          'Keys to set in the game state (merged into the current state; null deletes a key). ' +
          'The state is your memory: store secrets, questions, answers, scores, round and turn.',
      },
      state_append: {
        type: 'object',
        description:
          'Items to append to list keys in the state, e.g. {"history": [{"q": "Is it alive?", "a": "No"}]}. ' +
          'Use this instead of resending a whole list in state_update.',
      },
      state_add: {
        type: 'object',
        description: 'Numbers to add to the state, e.g. {"scores": {"Ana": 2, "Bob": 1}}. Use this for points instead of computing totals.',
      },
      screens: {
        type: 'object',
        description: 'What players see now. "all" = everyone; a player id = a screen just for that player.',
        properties: screenProps,
        additionalProperties: false,
      },
      wait_for: {
        type: 'string',
        enum: ['any', 'all'],
        description:
          '"any" (default): next event as soon as one player responds. ' +
          '"all": collect one response from every player who has something to click, then send them together.',
      },
      timer_seconds: {
        type: 'number',
        description: 'Optional countdown. When it runs out you get an event with the answers received so far.',
      },
      intro: {
        type: 'array',
        description: 'Optional timed slides shown to everyone before the screens (no input possible).',
        items: {
          type: 'object',
          properties: { screen: screenSchema, seconds: { type: 'number' } },
          required: ['screen', 'seconds'],
        },
      },
      game_over: {
        type: 'boolean',
        description: 'true only when the end condition of the rules is reached in this turn; otherwise false.',
      },
      final_message: {
        type: 'string',
        description: 'Only with game_over true: the result, e.g. "Ana wins with 12 points!"',
      },
      rule_change: {
        type: 'string',
        description: 'Only when you accept a HOST ADJUSTMENT: a short description of the changed rule. Otherwise leave it out.',
      },
      plan: {
        type: 'object',
        description:
          'Optional game plan for games with rounds, usually written on the first turn: {"rounds": 3, "phases": [{"id": "answer", "description": "...", "timer_seconds": 30}, ...], "content": {...}}. ' +
          'The server then counts rounds, applies phase timers and records answers.',
        properties: {
          rounds: { type: 'number' },
          phases: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, description: { type: 'string' }, timer_seconds: { type: 'number' } },
              required: ['id'],
            },
          },
          content: { type: 'object', description: 'Content decided up front, e.g. secret words or questions per round.' },
        },
        required: ['rounds', 'phases'],
      },
      phase: plan
        ? { type: 'string', enum: plan.phases.map((p) => p.id), description: 'The plan phase these screens belong to.' }
        : { type: 'string', description: 'With a plan: the phase these screens belong to.' },
      round: {
        type: 'number',
        description: 'With a plan: the round these screens belong to, when it differs from what PLAN PROGRESS assumes (e.g. the same question opens again after a wrong guess).',
      },
    },
    // Explicit decisions every turn: constrained decoding tends to fill optional
    // fields with placeholders, so game_over is a required boolean.
    required: ['screens', 'wait_for', 'game_over'],
  };
}

export function gameToolsFor(players: Player[]): LLMTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'next_turn',
        description:
          'Update the game state and show the next screen(s). Call this exactly once for every EVENT you receive.',
        parameters: nextTurnSchema(players) as LLMTool['function']['parameters'],
      },
    },
  ];
}

/** json protocol, definition phase: a chat reply plus optional proposed rules. */
export const definitionResponseSchema = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'Your chat reply to the players (1-3 sentences).' },
    proposed_rules: {
      type: 'string',
      description: 'The complete rules using the template, only when you propose them. Otherwise an empty string.',
    },
    min_players: { type: 'number', description: 'With proposed rules: fewest players the game works with (else 0).' },
    max_players: { type: 'number', description: 'With proposed rules: most players the game works with (else 0).' },
  },
  required: ['message', 'proposed_rules', 'min_players', 'max_players'],
};
