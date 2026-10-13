// Band Buzzer: guess the band name with vowels and spaces removed. First to press "I know!" guesses.
// "Give up!" counts per player: the round is skipped only when everyone has given up.
defineGame({
  rounds: 10,
  scoreboard: 'always',

  async setup(g) {
    // All content up front, three times more than needed, with the spellings to accept:
    // no AI calls during play, and a different set of bands every game.
    const pool = await g.ai.list(
      'Well-known bands from different decades, countries and genres (bands, not solo artists). alsoAccepted: other common ways to write the name, e.g. without "The" or with "&" written out.',
      g.rounds * 3,
      { band: 'string', alsoAccepted: 'string[]' },
      { complexity: 1 },
    );
    const unique = pool.filter((b, i) => b.band.replace(/[aeiou\s]/gi, '').length >= 2 && pool.findIndex((x) => match.same(x.band, b.band)) === i);
    g.state.bands = g.random.sample(unique, g.rounds);
    g.setRounds(g.state.bands.length);
    g.state.gaveUp = [];
  },

  start: 'buzz',
  phases: {
    buzz: buzzer({
      enter(g) {
        // Derived from the round, so re-entering after a wrong guess keeps the same band.
        g.state.band = g.state.bands[g.round - 1];
        g.state.puzzle = g.state.band.band.replace(/[^a-z0-9]/gi, '').replace(/[aeiou]/gi, '').toUpperCase();
      },
      view: (g, me) => [
        ui.heading(g.state.puzzle),
        g.state.note && ui.muted(g.state.note),
        g.ids.length > 1 && g.state.gaveUp.length > 0 && ui.muted(`${g.state.gaveUp.length} of ${g.ids.length} gave up`),
        g.state.gaveUp.includes(me) && ui.muted('You gave up. You can still press "I know!" if it comes to you.'),
      ],
      buttons: { know: 'I know!', giveUp: 'Give up!' },
      next(g, press) {
        g.state.note = '';
        if (!press) return 'reveal';
        if (press.button === 'giveUp') {
          // One player giving up only counts their own vote; pressing again changes nothing.
          if (!g.state.gaveUp.includes(press.player)) g.state.gaveUp.push(press.player);
          return g.ids.every((id) => g.state.gaveUp.includes(id)) ? 'reveal' : 'buzz';
        }
        g.state.guesser = press.player;
        return 'guess';
      },
    }),

    guess: turn({
      who: (g) => g.state.guesser,
      timer: 30,
      input: (g) => [ui.heading(g.state.puzzle), ui.textInput('Band name', { placeholder: 'Type the band' }), ui.button('giveUp', 'Give up', { style: 'secondary' })],
      waitingView: (g) => [ui.heading(g.state.puzzle), ui.muted(`${g.name(g.state.guesser)} is guessing…`)],
      next(g, answer) {
        const guess = typeof answer === 'string' ? answer : '';
        const names = [g.state.band.band, ...(g.state.band.alsoAccepted || [])];
        const right = !!guess && names.some((n) => match.close(guess, n));
        g.scores.add(g.state.guesser, right ? 1 : -1);
        g.state.solved = right;
        if (right) return 'reveal';
        g.state.note = guess ? `${g.name(g.state.guesser)} guessed "${guess}": wrong (−1)` : `${g.name(g.state.guesser)} gave up (−1)`;
        return 'buzz';
      },
    }),

    reveal: show({
      seconds: 5,
      view: (g) => [
        ui.muted('The band was'),
        ui.heading(g.state.band.band),
        g.state.solved ? ui.success(`${g.name(g.state.guesser)} got it (+1)`) : ui.muted(g.ids.length > 1 ? 'Everyone gave up. No points this round.' : 'Skipped. No points this round.'),
      ],
      next(g) {
        g.state.gaveUp = [];
        g.state.solved = false;
        return g.lastRound ? g.end() : g.nextRound('buzz');
      },
    }),
  },
});
