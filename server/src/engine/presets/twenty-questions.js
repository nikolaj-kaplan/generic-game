// 20 Questions: the AI picks a secret; the player has 10 yes/no questions (guesses count too).
defineGame({
  scoreboard: 'never',
  final: (g) => g.state.log.length > 0 && ui.list(g.state.log.map((l) => `Q: ${l.q} → ${l.a}`), { ordered: true }),

  async setup(g) {
    g.state.secret = await g.ai.text(
      'Pick one well-known person, place or object for a game of 20 Questions. Avoid the most obvious picks. Reply with only its name.',
      { complexity: 2 },
    );
    g.state.log = [];
  },

  start: 'ask',
  phases: {
    ask: turn({
      who: (g) => g.ids[0],
      input: (g) => [
        ui.heading('20 Questions'),
        ui.muted(`${10 - g.state.log.length} questions left`),
        g.state.log.length > 0 && ui.list(g.state.log.map((l) => `Q: ${l.q} → ${l.a}`), { ordered: true }),
        ui.textInput('Your yes/no question, or a guess', { placeholder: 'Is it alive?' }),
      ],
      async next(g, answer) {
        const question = typeof answer === 'string' ? answer.trim() : '';
        if (!question) return 'ask';
        const r = await g.ai.json(
          `We play 20 Questions. The secret is "${g.state.secret}". The player asks: "${question}". ` +
            'Answer honestly with Yes, No, or Sometimes (only if truly mixed). correctGuess is true only if the player named the secret.',
          { answer: ['Yes', 'No', 'Sometimes'], correctGuess: 'boolean' },
          { complexity: 3 },
        );
        g.state.log.push({ q: question, a: r.correctGuess ? 'Yes, that is it!' : r.answer });
        if (r.correctGuess) return g.end(`🎉 Yes! It was ${g.state.secret}. You win with ${10 - g.state.log.length} questions to spare.`);
        if (g.state.log.length >= 10) return g.end(`Out of questions! It was ${g.state.secret}. The AI wins this time.`);
        return 'ask';
      },
    }),
  },
});
