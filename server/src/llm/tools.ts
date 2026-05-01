import { LLMTool } from '../types';

// =============================================================================
// Definition-phase tools
// =============================================================================

export const definitionTools: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'propose_rules',
      description:
        'Call this when you have a complete, unambiguous picture of the game rules. ' +
        'Provide a structured summary that covers all mechanics, scoring, and win conditions. ' +
        'The host will confirm before the game starts.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'A detailed, unambiguous description of the game rules. Be explicit about: ' +
              'player count, turn order, all mechanics, scoring system, win conditions, and timing.',
          },
        },
        required: ['summary'],
      },
    },
  },
];

// =============================================================================
// Playing-phase tools
// =============================================================================

const uiComponentSchema = {
  type: 'array',
  description:
    'Array of UI components. Each element is one of: ' +
    'text, input, button, multiple_choice, countdown, scoreboard, form, list, divider.',
  items: { type: 'object' },
};

export const gameTools: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'set_state_schema',
      description:
        'Define the JSON schema for the game state. Call this once when starting the game.',
      parameters: {
        type: 'object',
        properties: {
          schema: {
            type: 'object',
            description: 'JSON Schema object describing the game state structure.',
          },
        },
        required: ['schema'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_state',
      description: 'Retrieve the current game state.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_state',
      description: 'Update the game state. Use merge:true to do a shallow merge instead of replacing.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'object',
            description: 'The new (or partial, if merge=true) game state.',
          },
          merge: {
            type: 'boolean',
            description: 'If true, shallow-merge state into the existing state. Defaults to false.',
          },
        },
        required: ['state'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_user_ui',
      description:
        'Push a UI to one player or all players. Use playerId "all" to target everyone.',
      parameters: {
        type: 'object',
        properties: {
          playerId: {
            type: 'string',
            description: 'Player ID to target, or "all" for everyone.',
          },
          ui: uiComponentSchema,
        },
        required: ['playerId', 'ui'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sequence',
      description:
        'Execute a deterministic series of UI updates and state changes with delays between steps. ' +
        'All steps are planned UPFRONT in one call — the server runs them automatically with no LLM call between steps. ' +
        'Use this for: flashcard sequences, reveal animations, intro slides — any timed flow where you know every step in advance. ' +
        'The game loop resumes AFTER the entire sequence finishes, so you can immediately follow up with set_user_ui for the next interaction. ' +
        'delayBefore on step[0] = pause before the first item. delayBefore on step[N] = how long step[N-1] stays on screen.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Ordered steps to execute in sequence.',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['set_ui', 'set_state'],
                  description: 'set_ui: push UI components to a player. set_state: update game state.',
                },
                delayBefore: {
                  type: 'number',
                  description: 'Seconds to wait before executing this step. Default 0.',
                },
                playerId: {
                  type: 'string',
                  description: 'Required for set_ui. Player ID or "all".',
                },
                ui: {
                  type: 'array',
                  description: 'Required for set_ui. UI components array.',
                  items: { type: 'object' },
                },
                state: {
                  type: 'object',
                  description: 'Required for set_state. State object to apply.',
                },
                merge: {
                  type: 'boolean',
                  description: 'For set_state: shallow-merge instead of replace. Default false.',
                },
              },
              required: ['action'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_timer',
      description:
        'Start a countdown timer for player interactions that may time out (e.g. a 30-second answer window). ' +
        'When it expires the server will feed a timer_expired event back to you. ' +
        'Do NOT use this for deterministic sequences — use run_sequence instead.',
      parameters: {
        type: 'object',
        properties: {
          timerId: {
            type: 'string',
            description: 'Unique ID for this timer (e.g. "question-1").',
          },
          seconds: {
            type: 'number',
            description: 'Duration in seconds.',
          },
          playerId: {
            type: 'string',
            description: 'Player to notify on expiry, or "all". Defaults to "all".',
          },
        },
        required: ['timerId', 'seconds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_rules',
      description:
        'Record a mid-game rule amendment requested by the host. Call this when you accept a HOST ADJUSTMENT. ' +
        'The amendment is appended to the agreed rules so it is visible in future turns.',
      parameters: {
        type: 'object',
        properties: {
          amendment: {
            type: 'string',
            description: 'A concise description of the rule change (e.g. "Scoring changed: +3 correct, -1 wrong").',
          },
        },
        required: ['amendment'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end_game',
      description: 'Signal that the game is over and show results to all players.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'End-of-game message to display (e.g. "Alice wins with 15 points!").',
          },
          results: {
            type: 'object',
            description: 'Structured results object (e.g. player scores, winner).',
          },
          ui: {
            ...uiComponentSchema,
            description: 'Optional final UI to display to all players.',
          },
        },
        required: ['message', 'results'],
      },
    },
  },
];
