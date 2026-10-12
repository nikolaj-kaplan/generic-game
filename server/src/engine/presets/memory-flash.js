// Flash Memory: 8 countries flash for 2 seconds each; which of 4 options was NOT shown?
const COUNTRIES = [
  'Argentina', 'Australia', 'Austria', 'Belgium', 'Brazil', 'Canada', 'Chile', 'China', 'Colombia', 'Croatia',
  'Cuba', 'Denmark', 'Egypt', 'Estonia', 'Ethiopia', 'Finland', 'France', 'Germany', 'Ghana', 'Greece',
  'Hungary', 'Iceland', 'India', 'Indonesia', 'Ireland', 'Italy', 'Jamaica', 'Japan', 'Kenya', 'Mexico',
  'Morocco', 'Nepal', 'Netherlands', 'New Zealand', 'Nigeria', 'Norway', 'Peru', 'Poland', 'Portugal', 'Romania',
  'Senegal', 'South Korea', 'Spain', 'Sweden', 'Switzerland', 'Thailand', 'Turkey', 'Ukraine', 'Uruguay', 'Vietnam',
];

defineGame({
  scoreboard: 'end',

  setup(g) {
    const picks = g.random.sample(COUNTRIES, 12);
    g.state.shown = picks.slice(0, 8);
    g.state.decoy = picks[8];
    g.state.options = g.random.shuffle([...g.random.sample(g.state.shown, 3), g.state.decoy]);
  },

  start: 'flash',
  phases: {
    flash: slides({
      items: (g) => g.state.shown,
      seconds: 2,
      view: (g, country, i) => [ui.muted(`${i + 1} / 8`), ui.heading(country)],
      next: 'question',
    }),

    question: collect({
      timer: 20,
      input: (g) => ui.choice('Which of these countries did NOT appear?', g.state.options, { correct: g.state.decoy, points: 1 }),
      next: 'reveal',
    }),

    reveal: show({
      view: (g) => [
        ui.subheading(`The country that was not shown: ${g.state.decoy}`),
        ui.text('The countries you saw:'),
        ui.list(g.state.shown, { ordered: true }),
      ],
      continueLabel: 'Finish',
      next: (g) => {
        const right = g.scores.get(g.ids[0]) > 0;
        return g.end(right ? '🎉 Correct! You win.' : `Not quite: it was ${g.state.decoy}. Better luck next time.`);
      },
    }),
  },
});
