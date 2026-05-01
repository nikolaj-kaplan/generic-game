export interface GamePreset {
  id: string;
  title: string;
  emoji: string;
  playerCount: string;
  description: string;
  /** The message sent to the AI as if the user typed it */
  prompt: string;
}

export const GAME_PRESETS: GamePreset[] = [
  {
    id: 'twenty-questions',
    title: '20 Questions',
    emoji: '🤔',
    playerCount: '1 player',
    description: 'The AI picks a secret person, place or thing. You have 10 yes/no questions to guess it.',
    prompt: `I want to play 20 Questions — single player, just me vs the AI.

Rules:
- The AI secretly picks a well-known person, place, or object (real, not fictional obscurity).
- I get exactly 10 yes/no questions to figure out what it is.
- The AI must answer every question honestly with only "Yes", "No", or "Sometimes / Partially" if truly needed.
- I can make a direct guess at any time (it counts as one of my 10 questions).
- If I guess correctly before question 10, I win immediately.
- After my 10th question (whether a guess or not), the game ends and the AI reveals the answer.
- If I guessed it, I win. If not, the AI wins.
- Show a counter of how many questions I have remaining.
- This is a single-player game — exactly 1 player required.

UI rule: After each question, the answer screen MUST show both the player's question AND the AI's answer together (e.g. "Q: Is it a living person? → No"). Never show just "Answer: No" without the question text.`,
  },

  {
    id: 'quiz-battle',
    title: 'Quiz Battle',
    emoji: '⚡',
    playerCount: '2 players',
    description: 'Both players pick categories, then race to answer multiple-choice questions. 30 seconds per question.',
    prompt: `I want to play a two-player Quiz Battle. Exactly 2 players required.

Rules:
- Setup phase: Both players simultaneously each choose 2 trivia categories (4 categories total). Wait for both players to submit before moving on.
- Question generation: The AI creates 2 multiple-choice questions for each of the 4 categories = 8 questions total. Each question has 4 answer options (A, B, C, D). Difficulty: easy to medium, accessible general knowledge.
- Gameplay: Questions are presented one at a time to both players simultaneously. The order is random.
- Timer: Each question has a 30-second countdown. Both players see it.
- Answering: Each player answers independently. Once a player answers, they see "Answer submitted" but the correct answer is NOT revealed until both players have answered or time runs out.
- Scoring: +5 points for a correct answer, 0 points for no answer (timeout), -2 points for a wrong answer.
- The scoreboard (both players' scores) is always visible throughout the game.
- After all 8 questions, the player with the most points wins. Show the final scores and declare the winner.
- This game requires exactly 2 players.`,
  },

  {
    id: 'most-likely',
    title: 'Most Likely To',
    emoji: '🎉',
    playerCount: '3–8 players',
    description: 'Each round everyone votes for who best fits a prompt. The most-voted player gets a point. 8 rounds.',
    prompt: `I want to play a multiplayer "Most Likely To..." party game. Requires 3 to 8 players.

Rules:
- The game has 8 rounds.
- Each round the AI reveals a fun prompt, for example: "Most likely to survive a zombie apocalypse" or "Most likely to become famous one day".
- All players simultaneously vote for which OTHER player best fits the prompt. You cannot vote for yourself.
- Players have 20 seconds to submit their vote.
- Once all players have voted (or time expires), the votes are revealed to everyone.
- The player who received the most votes earns 1 point. If there is a tie, all tied players earn 1 point.
- After 8 rounds, the player with the most points wins. In case of a final tie, declare all tied players as co-winners.
- The scoreboard is always visible.
- Prompts should be lighthearted, fun, and positive — nothing mean-spirited or embarrassing.
- This game requires between 3 and 8 players.`,
  },
  {
    id: 'memory-flash',
    title: 'Flash Memory',
    emoji: '🧠',
    playerCount: '1 player',
    description: '8 country names flash on screen one at a time, 2 seconds each. Then answer: which one did you NOT see?',
    prompt: `I want to play a single-player memory game called Flash Memory. Exactly 1 player required.

Rules:
- The AI secretly picks 8 real country names AND 4 decoy country names (12 total). The decoys must be real countries too — just ones that were NOT shown.
- Flash all 8 countries using a SINGLE run_sequence call. Each step is a set_ui action with delayBefore: 2 (except the first step which has delayBefore: 0). Each step's UI shows just the country name (large, centred, style "heading") and a progress indicator like "3 / 8" (style "muted"). Do NOT show any input during this phase.
- After run_sequence returns, call set_user_ui to present the multiple-choice question: "Which of these countries did NOT appear in the sequence?" with 4 options: 3 of the 8 shown countries (chosen at random) plus 1 decoy that was never shown. The correct answer is the decoy.
- The player selects one option. If correct, they win. If wrong, they lose. Reveal the correct answer and show the full list of countries that were displayed.
- This is a single-player game — exactly 1 player required.
- Scoring: 1 point for a correct answer, 0 for wrong. Show the score at the end.`,
  },
];
