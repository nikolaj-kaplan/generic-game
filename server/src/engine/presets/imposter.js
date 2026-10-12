// Imposter: everyone but the imposter sees a secret word. Give one-word clues, then vote out the imposter.
defineGame({
  rounds: 3,

  async setup(g) {
    g.state.words = await g.ai.list(
      'Secret words for the party game Imposter: everyday things, places or animals that are easy to give clues about. Give the category too.',
      g.rounds,
      { word: 'string', category: ['a thing', 'a place', 'an animal'] },
      { complexity: 2 },
    );
    g.state.past = [];
  },

  start: 'clue',
  phases: {
    clue: collect({
      timer: 45,
      enter(g) {
        const fresh = g.ids.filter((id) => !g.state.past.includes(id));
        g.state.imposter = g.random.pick(fresh.length ? fresh : g.ids);
        g.state.past.push(g.state.imposter);
        g.state.secret = g.state.words[g.round - 1];
      },
      input: (g, me) => [
        me === g.state.imposter
          ? [ui.heading('🕵️ You are the imposter'), ui.text(`The word is ${g.state.secret.category}. Blend in!`)]
          : [ui.muted('The secret word is'), ui.heading(g.state.secret.word)],
        ui.textInput('Your clue: ONE word', { maxLength: 30 }),
      ],
      next: 'clues',
    }),

    clues: show({
      seconds: 15,
      view: (g) => [
        ui.heading('The clues'),
        ui.list(g.ids.map((id) => `${g.name(id)}: ${g.answers.clue?.[id] ?? '(no clue)'}`)),
      ],
      next: 'vote',
    }),

    vote: collect({
      timer: 30,
      input: (g) => [
        ui.list(g.ids.map((id) => `${g.name(id)}: ${g.answers.clue?.[id] ?? '(no clue)'}`)),
        ui.pickPlayer('Who is the imposter?', { others: true }),
      ],
      next: 'reveal',
    }),

    reveal: show({
      seconds: 12,
      enter(g) {
        const top = tally(g.answers.vote).top();
        g.state.caught = top.includes(g.state.imposter);
        if (g.state.caught) g.scores.add(g.others(g.state.imposter), 1);
        else g.scores.add(g.state.imposter, 2);
      },
      view: (g) => [
        ui.heading(`The imposter was ${g.name(g.state.imposter)}`),
        ui.text(`The word was "${g.state.secret.word}".`),
        ui.votes(g.answers.vote),
        g.state.caught ? ui.success('Caught! Everyone else gets 1 point.') : ui.error('The imposter got away: +2 for the imposter.'),
      ],
      next: (g) => (g.lastRound ? g.end() : g.nextRound('clue')),
    }),
  },
});
