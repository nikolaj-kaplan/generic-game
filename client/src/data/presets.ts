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
- Flash the 8 countries as timed intro slides, 2 seconds each. Each slide shows just the country name (large, as a heading) and a progress indicator like "3 / 8". No input during this phase.
- Right after the slides, show the multiple-choice question: "Which of these countries did NOT appear in the sequence?" with 4 options: 3 of the 8 shown countries (chosen at random) plus 1 decoy that was never shown. The correct answer is the decoy.
- The player selects one option. If correct, they win. If wrong, they lose. Reveal the correct answer and show the full list of countries that were displayed.
- This is a single-player game — exactly 1 player required.
- Scoring: 1 point for a correct answer, 0 for wrong. Show the score at the end.`,
  },
  {
    id: 'imposter',
    title: 'Imposter',
    emoji: '🕵️',
    playerCount: '3–8 players',
    description: 'Everyone gets the same secret word, except the imposter. Give one-word clues, then vote out the imposter.',
    prompt: `I want to play Imposter, a social deduction party game. Requires 3 to 8 players.

Rules:
- The AI secretly picks one player as the imposter and one secret word (an everyday thing, place or animal).
- Each player sees a private screen: everyone except the imposter sees the secret word. The imposter only sees "You are the imposter" (and the category, e.g. "an animal").
- Clue round: all players at the same time type ONE word that relates to the secret word, without making it too obvious. 45 seconds.
- Then everyone sees all clues next to the players' names.
- Voting: everyone votes at the same time for who they think the imposter is (not themselves). 30 seconds.
- Reveal the votes, the imposter and the secret word.
- If the imposter got the most votes, the other players each get 1 point. Otherwise the imposter gets 2 points.
- Play 3 rounds with a new imposter and a new word each round. The player with the most points wins.`,
  },
  {
    id: 'funny-answers',
    title: 'Funny Answers',
    emoji: '😂',
    playerCount: '3–8 players',
    description: 'The AI asks a silly question, everyone writes the funniest answer, then everyone votes. 4 rounds.',
    prompt: `I want to play a funny-answers party game, like Quiplash. Requires 3 to 8 players.

Rules:
- Each round the AI shows a silly fill-in-the-blank prompt, e.g. "The worst thing to say at a job interview: ___".
- All players type an answer at the same time. 60 seconds.
- Then all answers are shown anonymously (without names) and everyone votes for their favourite at the same time. You cannot vote for your own answer. 30 seconds.
- Reveal who wrote what and the votes. Each vote gives the author 1 point.
- Play 4 rounds with different prompts. The scoreboard is shown after each round. Most points wins.
- Keep prompts funny and friendly, nothing mean or explicit.`,
  },
  {
    id: 'band-buzzer',
    title: 'Band Buzzer',
    emoji: '🎸',
    playerCount: '1–4 players',
    description: 'Guess the band name with all vowels and spaces removed. Hit "I know!" first, then you have 30 seconds. 10 rounds.',
    prompt: `I want to play Band Buzzer. 1 to 4 players.

Rules:
- Each round the AI picks a well-known band and shows its name to everyone with all vowels (A, E, I, O, U) and all spaces removed, e.g. "Pink Floyd" becomes "PNKFLYD".
- Everyone sees an "I know!" button and a "Give up!" button. The first player to press "I know!" gets to guess; the other players see who is guessing.
- If anyone presses "Give up!", nobody knows it: reveal the band name, no points change, and go to the next round with a new band.
- The guessing player has 30 seconds to type the band name, or press "Give up".
- Correct guess: +1 point. Small spelling mistakes are fine. Wrong guess, giving up or running out of time: -1 point.
- After a correct guess, show the full band name and the scores, then go to the next round with a new band.
- After a wrong guess or giving up, the round opens up again with the same name and the "I know!" button for everyone, including the player who just guessed.
- Play 10 rounds. Show the scoreboard at the end. Most points wins.`,
  },
  {
    id: 'two-truths',
    title: 'Two Truths and a Lie',
    emoji: '🤥',
    playerCount: '3–8 players',
    description: 'Each player writes two true facts and one lie about themselves. Everyone else guesses the lie.',
    prompt: `I want to play Two Truths and a Lie. Requires 3 to 8 players.

Rules:
- Setup: all players at the same time write three statements about themselves (two true, one lie) and mark which one is the lie. Nobody else sees this screen.
- Then one player at a time is in the spotlight: their three statements are shown to everyone in random order.
- Everyone else votes at the same time on which statement is the lie (the spotlight player waits). 30 seconds.
- Reveal the lie. Each correct guess gives the guesser 1 point. The spotlight player gets 1 point for each player they fooled.
- After every player has been in the spotlight, show the final scores. Most points wins.`,
  },
];
