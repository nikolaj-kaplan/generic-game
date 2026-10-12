// Most Likely To: 8 rounds of voting for the player who best fits a prompt.
defineGame({
  rounds: 8,
  scoreboard: 'always',

  async setup(g) {
    // Three times more than needed: every game gets a different random set.
    const pool = await g.ai.list(
      'Lighthearted, positive "Most likely to…" prompts for a party game with friends, e.g. "Most likely to survive a zombie apocalypse". Nothing mean or embarrassing.',
      g.rounds * 3,
      'string',
      { complexity: 2 },
    );
    g.state.prompts = g.random.sample(pool, g.rounds);
  },

  start: 'vote',
  phases: {
    vote: collect({
      timer: 20,
      input: (g) => [ui.heading(g.state.prompts[g.round - 1]), ui.pickPlayer('Who fits best?', { others: true })],
      next: 'reveal',
    }),

    reveal: show({
      seconds: 8,
      enter(g) {
        g.state.winners = tally(g.answers.vote).top();
        g.scores.add(g.state.winners, 1);
      },
      view: (g) => [
        ui.heading(g.state.prompts[g.round - 1]),
        ui.votes(g.answers.vote),
        g.state.winners.length ? ui.success(`+1 to ${g.names(g.state.winners)}`) : ui.muted('Nobody voted this round.'),
      ],
      next: (g) => (g.lastRound ? g.end() : g.nextRound('vote')),
    }),
  },
});
