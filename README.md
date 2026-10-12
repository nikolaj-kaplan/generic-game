# Generic Game

A browser-based multiplayer game platform for **any game you can describe**. Players describe a game in a chat, the AI proposes rules, and once the host confirms them a strong model **writes a small program** for the game. The engine runs that program in a sandbox: player clicks and timers are handled instantly, and the AI is only called when a step needs it (creating content, judging an answer). The host can change the game mid-way; the AI patches the program and the game continues with its state. No game-specific code exists in the engine itself.

---

## How it works

```
┌─────────────┐   WebSocket   ┌───────────────────────────────────┐
│   Browser   │◄─────────────►│            Server                 │
│  (React)    │               │                                   │
└─────────────┘               │  ws-handler → orchestrator        │
                              │   (one event at a time per game)  │
                              │       ↓               ↓           │
                              │  LLM (Ollama or   session store   │
                              │   OpenRouter)     (JSON on disk)  │
                              └───────────────────────────────────┘
```

1. **Lobby** — host creates a session and gets a 5-letter join code. Other players join by code + name.
2. **Define** — players chat with the AI to agree on rules. The AI asks at most a few questions, then proposes rules in a fixed template (GAME / PLAYERS / SETUP / ROUND FLOW / SCORING / END / NOTES). The host confirms.
3. **Build** — the generator model writes a JavaScript program for the rules against the game library (`server/src/engine/guest/game-api.d.ts`). Before anyone plays, the program must load, pass a type check and survive 20 games played by random bots. Failures go back to the model (up to 3 attempts).
4. **Play** — every event (player input, timer) runs through the program in a QuickJS sandbox and returns the new state and every player's screen in milliseconds. `g.ai.*` calls (content, judging) go to a model chosen by the call's complexity.
5. **Change** — the host describes a change; the game pauses, the generator patches the program (plus an optional state migration), the patch is checked against the running game, and the host approves it. The game continues where it was.
6. **Finish** — the program calls `g.end()`. An overlay gives the host options to play again (same program, no rebuild), save the rules with their program, or return to the lobby.

`GAME_ENGINE=legacy` brings back the previous design, where the AI runs every turn (`llm/orchestrator.ts`).

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Server runtime | Node.js + TypeScript (`tsx watch` dev, `tsc` + `node` prod) |
| HTTP / WebSocket | Fastify 4 + `@fastify/websocket` |
| LLM provider | Any OpenAI-compatible endpoint: local Ollama (default in `.env`) or OpenRouter |
| Persistence | JSON file (`data/sessions.json`), debounced writes, in-memory Map |
| Tests | Vitest (unit), a WebSocket bot playtest harness, Playwright (browser) |
| Client | Vite 5 + React 18 + React Router 6 + TypeScript |
| Shared types | `/shared/types.ts` — single source of truth, imported by both packages |

---

## Project structure

```
generic-game/
├── client/               # Vite + React frontend
│   └── src/
│       ├── pages/        # Home, Lobby, Define, Play
│       ├── components/   # UIRenderer, Chat
│       ├── context/      # GameContext (WebSocket state)
│       ├── data/         # presets.ts (quick-start games)
│       └── styles/       # globals.css
├── server/               # Fastify backend
│   ├── src/
│   │   ├── index.ts      # Server entry; static file serving + WebSocket
│   │   ├── paths.ts      # Project root / data dir (DATA_DIR override)
│   │   ├── ws-handler.ts # All client message handling
│   │   ├── store.ts      # Session persistence
│   │   ├── connection-store.ts  # Active WebSocket connections
│   │   ├── engine/
│   │   │   ├── guest/runtime.js     # Game library, runs inside the sandbox
│   │   │   ├── guest/game-api.d.ts  # The API programs are written against (also the generator's spec)
│   │   │   ├── presets/*.js         # Hand-written programs for the 8 presets (examples + tests)
│   │   │   ├── sandbox.ts      # QuickJS: one fresh sandbox per event, CPU/memory limits
│   │   │   ├── host.ts         # Runs a session's program: inputs, timers, pause, patches
│   │   │   ├── generator.ts    # Rules → program, host change → patch; check-and-fix loop
│   │   │   ├── botTest.ts      # Random bot games with fake AI
│   │   │   ├── typecheck.ts    # Static rules + TypeScript check against game-api.d.ts
│   │   │   ├── ai.ts / shape.ts / models.ts  # g.ai calls, reply shapes, model routing
│   │   └── llm/
│   │       ├── client.ts       # OpenAI-compatible API wrapper, local-only guard
│   │       ├── orchestrator.ts # Event queue, definition chat, legacy AI-per-turn engine
│   │       ├── turn.ts         # next_turn validation/normalisation, history trimming
│   │       ├── prompts.ts      # System prompts for definition + playing phases
│   │       ├── tools.ts        # next_turn / propose_rules schemas
│   │       └── logger.ts       # Per-call JSON + YAML logs, metrics.json
│   └── scripts/
│       ├── playtest.ts       # Bot players play presets against a local model
│       └── codegen-eval.ts   # Models write the preset programs; report + results page
├── e2e/                  # Playwright tests (+ mock LLM server)
├── shared/
│   └── types.ts          # All protocol + domain types
├── data/                 # sessions.json, llm-logs/, playtests/, e2e/ (all git-ignored)
├── specs/
│   └── game-spec.md      # Original design specification
└── package.json          # Root scripts (dev, start, test, playtest, e2e)
```

---

## Getting started

### Prerequisites

- Node.js 22+
- Either [Ollama](https://ollama.com) for local models, or an [OpenRouter](https://openrouter.ai) API key

### Install

```bash
npm run install:all
npm install
```

### Configure

Create a `.env` file in the project root. Local model (recommended for development):

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=gemma4:26b-a4b-it-qat
LLM_API_KEY=
LLM_PROTOCOL=json
LLM_REASONING_EFFORT=none
```

Start Ollama with a large enough context window (the default 4K silently truncates the game prompt):

```bash
OLLAMA_CONTEXT_LENGTH=16384 ollama serve
```

OpenRouter instead: remove the `LLM_*` lines and set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`.

| Variable | Meaning |
|----------|---------|
| `LLM_BASE_URL` | OpenAI-compatible base URL (default OpenRouter) |
| `LLM_MODEL` / `LLM_API_KEY` | Model and key (fall back to `OPENROUTER_MODEL` / `OPENROUTER_API_KEY`) |
| `LLM_PROTOCOL` | `json` = schema-constrained JSON replies (best for local models); `tools` = tool calling (default) |
| `LLM_REASONING_EFFORT` | Passed through as `reasoning_effort` (`none`, `low`, `medium`, `high`) |
| `LLM_TEMPERATURE` | Default 0.4; empty omits it for models that reject it |
| `LLM_FORCE_TOOLS` | `false` stops sending `tool_choice: "required"` |
| `LLM_HISTORY_MESSAGES` | Game history sent per call (default 45) |
| `LLM_LOCAL_ONLY` | `1` refuses any non-localhost LLM endpoint (set by all automated tests) |
| `DATA_DIR` | Where sessions and logs go (default `data/`) |
| `LOG_LEVEL` | Fastify log level (default `warn`) |

### Development (two ports)

```bash
npm run dev
```

- Server: `http://localhost:3101` (Fastify + WebSocket)
- Client: `http://localhost:5173` (Vite dev server, proxies `/ws` to server)

### Production / single-port (for phone testing, Dev Tunnels, etc.)

```bash
npm start
```

Builds the client, compiles the server, and starts everything on `http://0.0.0.0:3101`. Forward only port 3101 (in dev mode, forward 5173).

---

## Game programs

A program is one JavaScript file that calls `defineGame({...})`. The engine owns waiting, timers, the countdown, "waiting for…", the round line, the scoreboard and the end screen; a program declares phases:

| Phase | What happens |
|-------|--------------|
| `collect` | Everyone (or `who`) answers at the same time; ends when all answered or the timer runs out |
| `turn` | One player acts, the others watch |
| `buzzer` | The first player to press a button wins the phase |
| `show` | A reveal; moves on after `seconds`, or when the host presses Continue |
| `slides` | Timed slides for everyone |

```js
defineGame({
  rounds: 8,
  async setup(g) { g.state.prompts = await g.ai.list('Lighthearted "Most likely to…" prompts', g.rounds); },
  start: 'vote',
  phases: {
    vote: collect({ timer: 20, input: (g) => ui.pickPlayer(g.state.prompts[g.round - 1]), next: 'reveal' }),
    reveal: show({
      seconds: 8,
      enter(g) { g.scores.add(tally(g.answers.vote).top(), 1); },
      view: (g) => [ui.heading(g.state.prompts[g.round - 1]), ui.votes(g.answers.vote)],
      next: (g) => (g.lastRound ? g.end() : g.nextRound('vote')),
    }),
  },
});
```

Rules that make pausing and patching safe: all data lives in `g.state` (plain JSON); a fresh sandbox runs every event, so nothing else survives; screens are drawn from state and may be drawn again at any time; randomness comes from a seeded `g.random`.

### Sandbox

Programs run in [QuickJS](https://github.com/justjake/quickjs-emscripten) compiled to WebAssembly: no `require`, `process`, network or files, only the game library. A synchronous stretch of more than 250 ms is interrupted (an endless loop cannot freeze the server) and memory is capped at 64 MB.

### Model routing (`models.json`)

Programs never name a model. Every `g.ai` call carries a complexity from 1 (pick from options) to 5 (judge humour); `models.json` in the project root maps the numbers to models and names the generator (the best model). Copy `models.example.json` to start. Without the file, everything uses the `LLM_*` settings. Automated tests set `GAME_MODELS_FILE=none`, so they never use the strong model.

## The AI protocol (legacy engine)

### Definition phase

The AI chats and proposes rules (`propose_rules` tool, or `proposed_rules` in the JSON reply). The host sees a confirmation banner before the game starts.

### Playing phase: one `next_turn` per event

| Field | Meaning |
|-------|---------|
| `state_update` | Keys merged into the game state (`null` deletes). The state is the AI's memory and is never sent to browsers. |
| `screens` | `{"all": [...], "<player id>": [...]}`. A player key overrides `all` for that player (secret info, "your turn" screens). |
| `wait_for` | `any` (default): next event on the first response. `all`: collect one response from every player who has something to click. |
| `timer_seconds` | Server-owned countdown (shown automatically). On expiry the AI gets the answers so far and who did not answer. |
| `intro` | Timed slides shown before the screens (flash cards, reveals). |
| `game_over` | `{"message": "..."}` ends the game. |
| `rule_change` | Records an accepted host adjustment in the rules. |

The JSON schema is built per session, so the only allowed screen keys are `all` and the real player ids. With `LLM_PROTOCOL=json` Ollama enforces the schema with a grammar, so the model cannot produce broken JSON.

### Validation and recovery

`turn.ts` normalises harmless mistakes (player names as keys, `"text"` instead of `"content"`, a `countdown` component instead of `timer_seconds`, a text style used as a type) and rejects real problems (unknown components, inputs without a button, dead-end screens nobody can act on). Rejections go back to the model with the list of problems; after 3 failed attempts the turn is reported as stalled and players get a **Retry** button. Failed attempts are not kept in the history.

### Events

Players' clicks carry the screen's turn number; clicks on old screens are ignored. All events for a session run through one queue, so simultaneous clicks never run two AI turns at once. A reset while the AI is thinking discards the late result.

---

## UI component system

The LLM pushes arrays of typed UI components. The `UIRenderer` on the client maps them to React elements.

| Component | Key props |
|-----------|-----------|
| `text` | `content`, `style` (`heading` \| `subheading` \| `body` \| `muted` \| `error` \| `success`) |
| `input` | `fieldId`, `label`, `placeholder`, `maxLength` |
| `button` | `label`, `actionId`, `style` (`primary` \| `secondary` \| `danger`) |
| `multiple_choice` | `fieldId`, `question`, `options[]` |
| `countdown` | added by the server for turns with `timer_seconds` (`endsAt` keeps it right after reloads) |
| `scoreboard` | `players[]` — each with `id`, `name`, `score` |
| `form` | `formId`, `fields[]`, `submitLabel` |
| `list` | `items[]`, `ordered` |
| `divider` | — |

Standalone `input` components outside a `form` share state via a top-level map and submit alongside adjacent buttons via `form_submit`. A `multiple_choice` submits on click. After a player submits, the whole screen is disabled until the next screen arrives.

---

## WebSocket protocol

All communication after the initial connection is via a single persistent WebSocket.

### Client → Server

| Message | Description |
|---------|-------------|
| `create_session` | Host creates a new session |
| `join_session` | Player joins by join code |
| `start_defining` | Host moves from lobby to definition chat |
| `chat` | Player sends a message during definition phase |
| `confirm_rules` | Host confirms the AI-proposed rules and starts the game |
| `form_submit` | Player submits a form or choice (`formId` + `values` + `turn`) |
| `action` | Player clicks a button (`actionId` + `turn`) |
| `retry_turn` | Ask the AI again after a stall (anyone) or to unstick a screen (host) |
| `reset_session` | Host soft-resets: keeps rules + chat history, wipes game state, returns to defining |
| `full_reset` | Host hard-resets: wipes everything, returns to lobby |
| `game_tweak` | Host sends a mid-game instruction to the AI |

### Server → Client

| Message | Description |
|---------|-------------|
| `session_created` / `session_joined` | Full initial session state |
| `player_joined` / `player_left` | Lobby updates |
| `chat_message` | AI or player message |
| `ui_update` | New screen for a player, with its `turn` number |
| `turn_status` | Who still has to answer in a `wait_for: all` turn |
| `game_error` | The AI failed to produce a screen (`null` clears it) |
| `status_change` | Session phase transition; carries `agreedRules` when relevant |
| `timer_expired` | Timer fired (forwarded to client for countdown display) |
| `ai_thinking` | Spinner on/off |
| `error` | Server-side error message |

---

## Session lifecycle

```
lobby → defining → playing → finished
              ↑                  │
              └──── reset_session (soft reset, keeps rules)
              
lobby ← full_reset (wipes everything)
```

- **Soft reset** (`reset_session`): preserves `chatHistory`, `definitionLlmMessages`, and `agreedRules`. The define page shows a confirmation banner so the host can start the same game again immediately.
- **Hard reset** (`full_reset`): wipes all state and returns to the lobby join code screen.

---

## Host controls

During gameplay the host sees extra controls in the header:

- **Play again** — soft reset (prompts confirmation)
- **🎛️ Adjust** — opens an inline text bar to send a mid-game instruction to the AI. Minor adjustments (scoring, display format) are accepted; conflicting changes are declined via the UI.
- **Rules** — toggles a slide-up panel showing the agreed rules

At game end a modal overlay appears with **Play again 🔄** and **Back to lobby** buttons. Non-host players see "Waiting for the host…".

---

## Quick-start presets

The define page offers four preset prompts to kick off a game instantly:

| Preset | Players | Description |
|--------|---------|-------------|
| 🤔 20 Questions | 1 | AI picks a secret thing; 10 yes/no questions to guess it |
| ⚡ Quiz Battle | 2 | Both players pick categories; 8 multiple-choice questions; 30 s each |
| 🎉 Most Likely To | 3–8 | 8 rounds of voting for who best fits a silly prompt |
| 🧠 Flash Memory | 1 | 8 country names flash 2 s each; guess which one was NOT shown |

Presets are just pre-filled chat messages. The AI still negotiates and confirms rules before starting.

---

## LLM call logging

Every LLM exchange is written to a folder per definition chat or game:

```
data/llm-logs/2026-10-10_07-13-18_NX4ZV_play/
├── 00001_playing.json   # full request/response, tool arguments parsed
├── 00001_playing.yaml   # readable summary: messages, reasoning, screens
├── ...
└── metrics.json         # LLM calls, time, invalid replies, stalls, finished
```

The server console prints one line per event and a one-line summary of each screen. Clear all logs with `npm run logs:clear`.

---

## Testing (local models only)

Automated tests never call a paid API: everything runs with `LLM_LOCAL_ONLY=1`, which makes the server refuse any non-localhost endpoint.

```bash
npm test             # unit tests (model mocked)
npm run e2e          # Playwright against a scripted mock LLM (~40 s)
npm run playtest -- --game quiz-battle   # bot players vs local Ollama, prints a scorecard
npm run playtest -- --all                # all presets
npm run e2e:llm      # Playwright plays real games against local Ollama (slow; HEADED=1 to watch)
npm run codegen:eval -- --game imposter --model strong   # a model writes preset programs; see below
```

`codegen:eval` writes `data/codegen-evals/<run>/report.json` and the programs, and rebuilds `data/codegen-evals/index.html`: pass rate, attempts, time, lines of code and "own logic" (lines that use no library name, i.e. candidates for the library) per model and game. Runs with the strong model go through the Claude bridge: keep them small.

Playtest options: `--model`, `--protocol json|tools`, `--reasoning none|low|medium|high|default`, `--players`, `--max-minutes`, `--quiet`. Results go to `data/playtests/<timestamp>/` (report.json, server.log and the LLM logs per game), so model and prompt variants can be compared.

---

## Reliability features

- **Schema-constrained output** (`LLM_PROTOCOL=json`) — no broken JSON from small local models.
- **Validation with feedback** — rejected turns go back to the model with a list of problems; stalls surface as a Retry button instead of a frozen game.
- **Text-reply recovery** — a `next_turn` written as text (tools protocol) is parsed and used.
- **Serialised events** — one event at a time per session; stale clicks are ignored by turn number.
- **Safe history trimming** — never separates a tool call from its result and always keeps the game-start event.
- **Prompt-cache friendly** — system prompts are static per phase; the current state rides on the latest event.
- **Unicode sanitisation** — zero-width characters are stripped before requests.
- **React StrictMode deduplication** — WebSocket connections are deduplicated via an `active` flag; chat messages are deduplicated by ID.
