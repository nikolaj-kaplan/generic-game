// Two Truths and a Lie: everyone writes two truths and a lie; then each player is in the spotlight once.
defineGame({
  start: 'write',

  phases: {
    write: collect({
      timer: 120,
      input: () => [
        ui.heading('Two truths and a lie'),
        ui.text('Write three statements about yourself. Only you see this screen.'),
        ui.textInput('A true statement', { id: 'truth1' }),
        ui.textInput('Another true statement', { id: 'truth2' }),
        ui.textInput('A lie', { id: 'lie' }),
      ],
      next(g) {
        const written = g.answers.write || {};
        g.state.spotlights = g.ids.filter((id) => written[id] && written[id].truth1 && written[id].truth2 && written[id].lie);
        g.state.statements = {};
        for (const id of g.state.spotlights) g.state.statements[id] = written[id];
        if (g.state.spotlights.length === 0) return g.end('Nobody wrote their statements, so there is nothing to guess.');
        g.setRounds(g.state.spotlights.length);
        return 'guess';
      },
    }),

    guess: collect({
      timer: 30,
      enter(g) {
        g.state.star = g.state.spotlights[g.round - 1];
        const s = g.state.statements[g.state.star];
        g.state.order = g.random.shuffle([s.truth1, s.truth2, s.lie]);
      },
      who: (g) => g.others(g.state.star),
      input: (g) => [ui.muted(`${g.name(g.state.star)} is in the spotlight`), ui.choice('Which one is the lie?', g.state.order)],
      view: (g) => [ui.heading('You are in the spotlight'), ui.list(g.state.order), ui.muted('The others are guessing which one is your lie…')],
      next: 'reveal',
    }),

    reveal: show({
      seconds: 10,
      enter(g) {
        const lie = g.state.statements[g.state.star].lie;
        const guesses = g.answers.guess || {};
        g.state.right = Object.keys(guesses).filter((id) => guesses[id] === lie);
        g.state.fooled = Object.keys(guesses).filter((id) => guesses[id] !== lie);
        g.scores.add(g.state.right, 1);
        g.scores.add(g.state.star, g.state.fooled.length);
      },
      view: (g) => [
        ui.subheading(`${g.name(g.state.star)}'s lie was:`),
        ui.heading(g.state.statements[g.state.star].lie),
        g.state.right.length ? ui.success(`Spotted it (+1): ${g.names(g.state.right)}`) : ui.muted('Nobody spotted it.'),
        g.state.fooled.length ? ui.text(`${g.name(g.state.star)} fooled ${g.names(g.state.fooled)} (+${g.state.fooled.length})`) : null,
      ],
      next: (g) => (g.lastRound ? g.end() : g.nextRound('guess')),
    }),
  },
});
