// Funny Answers: everyone answers a silly prompt, then votes for the funniest answer (not their own).
defineGame({
  rounds: 4,

  async setup(g) {
    g.state.prompts = await g.ai.list(
      'Silly fill-in-the-blank prompts for a Quiplash-style party game, e.g. "The worst thing to say at a job interview: ___". Funny and friendly, nothing mean or explicit.',
      g.rounds,
      'string',
      { complexity: 3 },
    );
  },

  start: 'write',
  phases: {
    write: collect({
      timer: 60,
      input: (g) => [ui.heading(g.state.prompts[g.round - 1]), ui.textInput('Your answer', { maxLength: 120 })],
      next: 'vote',
    }),

    vote: collect({
      timer: 30,
      enter(g) {
        // Anonymous and in random order (decided once, so every screen shows the same order).
        const written = g.answers.write || {};
        g.state.entries = g.random.shuffle(g.ids.filter((id) => written[id]).map((id) => ({ author: id, text: written[id] })));
      },
      who: (g) => g.ids.filter((id) => g.state.entries.filter((e) => e.author !== id).length >= 2),
      input: (g, me) =>
        ui.choice(
          g.state.prompts[g.round - 1],
          g.state.entries.filter((e) => e.author !== me).map((e) => e.text),
        ),
      next: 'reveal',
    }),

    reveal: show({
      seconds: 12,
      enter(g) {
        const votes = tally(g.answers.vote);
        for (const e of g.state.entries) g.scores.add(e.author, votes.of(e.text));
      },
      view: (g) => {
        const votes = tally(g.answers.vote);
        return [
          ui.subheading(g.state.prompts[g.round - 1]),
          ui.list(
            g.state.entries
              .slice()
              .sort((a, b) => votes.of(b.text) - votes.of(a.text))
              .map((e) => `"${e.text}" by ${g.name(e.author)}: ${votes.of(e.text)} vote${votes.of(e.text) === 1 ? '' : 's'}`),
          ),
        ];
      },
      next: (g) => (g.lastRound ? g.end() : g.nextRound('write')),
    }),
  },
});
