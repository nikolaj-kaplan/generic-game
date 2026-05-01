# Generic Game — Application Specification

## Overview

A browser-based multiplayer game platform where **all game logic is driven by an LLM**. Users define the rules of any game through a chat interface, and the LLM orchestrates gameplay using a set of tools and a structured state machine. No game-specific code is written — the framework handles communication, state persistence, UI rendering, and player management.

---

## User Flow

### 1. Session Creation (Lobby)

1. A user (the **host**) opens the app URL on their phone.
2. The app creates a new session and displays a **join code** (short alphanumeric, e.g., `AXKF`).
3. Other users open the same URL, enter the join code, and pick a display name.
4. The host sees a list of joined players and has a **"Start"** button.
5. All joined users can participate in the game-definition chat (next step), but only the host can trigger the game start.

### 2. Game Definition (Chat Phase)

1. Once the host starts the definition phase, all players see a chat-style interface.
2. The AI opens with: _"Let me know the rules of the game you want to play."_
3. Players and the AI converse until the AI determines it has a clear, unambiguous set of rules.
4. The AI posts a **final summary** of the agreed rules and asks: _"Ready to start?"_
5. The host confirms. The app transitions to the **Playing** state.

### 3. Playing the Game

- The LLM drives all gameplay by:
  - Generating a **JSON state schema** that matches the game's logic.
  - Using tools to read/write game state.
  - Pushing UI updates to each player individually or collectively.
- Players interact through the UI elements pushed to their screen.
- A persistent **"Show Rules"** button is always visible, allowing any player to review the agreed rules at any time.

### 4. Game Over

- The LLM determines when the game ends (per the agreed rules).
- A final screen is pushed to all players showing results/winner.
- Players can choose to play again or return to lobby.

---

## Architecture

```
┌──────────────┐         WebSocket          ┌──────────────────┐
│   Browser    │ ◄─────────────────────────► │     Server       │
│  (Client)    │         REST API            │                  │
│              │ ────────────────────────────►│  ┌────────────┐  │
└──────────────┘                             │  │  LLM Layer  │  │
                                             │  │  (prompts + │  │
                                             │  │   tools)    │  │
                                             │  └─────┬───────┘  │
                                             │        │          │
                                             │  ┌─────▼───────┐  │
                                             │  │   NoSQL DB   │  │
                                             │  │  (sessions,  │  │
                                             │  │   state)     │  │
                                             │  └──────────────┘  │
                                             └──────────────────┘
```

### Components

| Component | Responsibility |
|-----------|---------------|
| **Client (Browser)** | Renders UI pushed by server, captures user input, sends events via WebSocket/REST |
| **Server** | Manages sessions, relays messages to LLM, executes tool calls, pushes UI via WebSocket |
| **LLM Layer** | Drives all game logic — defines schema, manages state transitions, generates UI |
| **NoSQL DB** | Persists sessions, player lists, game state, chat history |

---

## Communication

### Client → Server

- **REST API** for discrete actions:
  - `POST /session` — create a new session (returns join code)
  - `POST /session/:code/join` — join a session (body: `{ name }`)
  - `POST /session/:id/start` — host starts the game definition phase
  - `POST /session/:id/message` — send a chat message during definition phase
  - `POST /session/:id/input` — submit form/input data during gameplay

- **WebSocket** for persistent connection:
  - Client connects on join and stays connected for the session lifetime.
  - Used to receive pushed UI updates and state changes in real time.

### Server → Client (via WebSocket)

- `ui_update` — push a new UI to a specific player or all players
- `state_update` — broadcast updated game state (scores, timers, etc.)
- `chat_message` — relay AI or player messages during definition phase
- `game_over` — signal end of game with results
- `player_joined` / `player_left` — lobby updates

---

## LLM Integration

### System Prompt Structure

The LLM receives a system prompt that instructs it to:

1. Converse with players to establish clear, unambiguous game rules.
2. Once rules are agreed, generate a **JSON schema** describing the full game state.
3. Use the provided tools to manage game state and push UI to players.
4. Enforce all game rules (turn order, timing, scoring, win conditions).
5. Handle edge cases gracefully (timeouts, disconnects, invalid input).

### Tools

The LLM has access to the following tools (not a full MCP implementation — a lightweight custom tool layer):

| Tool | Description |
|------|-------------|
| `set_state_schema` | Define/update the JSON schema for the game state. Called once after rules are agreed. |
| `get_state` | Retrieve the current game state. |
| `set_state` | Update the game state (partial or full). Triggers relevant `state_update` pushes to clients. |
| `set_user_ui` | Push a UI to one or all players. Accepts a UI definition (see below). |
| `start_timer` | Start a countdown timer for a player or all players. Server handles the countdown and notifies LLM on expiry. |
| `end_game` | Signal that the game is over. Payload includes final results. |

### Tool Call Flow (Example: Quiz Game)

```
1. LLM calls set_state_schema({ ... quiz state schema ... })
2. LLM calls set_state({ phase: "category_input", players: [...], scores: {...} })
3. LLM calls set_user_ui(player_1, { type: "form", fields: [{ type: "text", label: "Enter two categories", ... }] })
4. LLM calls set_user_ui(player_2, { ... same ... })
   — players submit categories —
5. LLM generates questions, calls set_state({ questions: [...], phase: "answering" })
6. LLM calls set_user_ui(all, { type: "question", ... }) + start_timer(all, 30)
   — loop until all questions answered —
7. LLM calls end_game({ winner: "player_1", scores: {...} })
```

---

## UI Rendering

### Approach

The server pushes **UI definitions** to the client. Two possible strategies (to be decided):

#### Option A: Predefined UI Components (Recommended for V1)

A fixed set of composable UI components the LLM can reference:

| Component | Props |
|-----------|-------|
| `text` | `content`, `style` (heading, body, muted) |
| `input` | `placeholder`, `maxLength`, `fieldId` |
| `button` | `label`, `actionId`, `style` (primary, secondary, danger) |
| `multiple_choice` | `question`, `options[]`, `fieldId` |
| `countdown` | `seconds`, `label` |
| `scoreboard` | `players[]` (each with `name`, `score`) |
| `form` | `fields[]`, `submitLabel` — wraps other components into a submittable group |
| `list` | `items[]`, `ordered` |
| `image` | `url`, `alt` |
| `divider` | — |

The client has a renderer that maps these component definitions to actual HTML/CSS.

#### Option B: Raw HTML (Future consideration)

The LLM generates full HTML snippets. The client renders them in a sandboxed container. Form submissions are captured and sent back to the server. More flexible but harder to secure and maintain consistency.

### UI Update Semantics

- Each `set_user_ui` call **replaces** the current game UI for that player (not the persistent elements like scoreboard or rules button).
- Persistent elements (scoreboard, rules button, timer) are managed separately and overlaid.

---

## Data Model (NoSQL)

### Session Document

```json
{
  "id": "uuid",
  "joinCode": "AXKF",
  "hostPlayerId": "uuid",
  "status": "lobby | defining | playing | finished",
  "players": [
    { "id": "uuid", "name": "Alice", "connectedAt": "timestamp" }
  ],
  "chatHistory": [
    { "role": "ai | player", "playerId": "uuid?", "content": "...", "timestamp": "..." }
  ],
  "agreedRules": "Final rules summary text",
  "stateSchema": { ... },
  "gameState": { ... },
  "createdAt": "timestamp",
  "updatedAt": "timestamp"
}
```

---

## Session Lifecycle

```
lobby → defining → playing → finished
  │                              │
  └──────── (play again) ───────►└─► lobby
```

| State | Description |
|-------|-------------|
| `lobby` | Players joining. Host sees player list + start button. |
| `defining` | Chat phase. AI and players agree on rules. |
| `playing` | Game in progress. LLM drives state and UI. |
| `finished` | Results shown. Option to restart. |

---

## Technical Decisions (To Be Made)

| Decision | Options | Notes |
|----------|---------|-------|
| Server runtime | Node.js / Deno / Bun | Needs good WebSocket support |
| NoSQL database | MongoDB / Redis / DynamoDB / SQLite (JSON mode) | Redis is fast for ephemeral sessions; MongoDB if persistence matters |
| LLM provider | OpenRouter / OpenAI direct / Anthropic | Already have OpenRouter key in `.env` |
| Client framework | Vanilla JS / React / Svelte / Vue | Mobile-first, lightweight preferred |
| Hosting | Fly.io / Railway / VPS | Needs WebSocket support |

---

## Non-Functional Requirements

- **Mobile-first**: UI must work well on phone screens.
- **Low latency**: WebSocket for all real-time updates.
- **Resilience**: Handle player disconnects gracefully (rejoin by session code).
- **Security**: Sanitize any LLM-generated content before rendering. Rate-limit API calls.
- **Scalability**: V1 targets small groups (2–6 players). No need for massive scale initially.

---

## Out of Scope (V1)

- User accounts / authentication (players are ephemeral per session)
- Game history / leaderboards
- Voice or video
- Complex graphics / canvas-based games
- Monetization
