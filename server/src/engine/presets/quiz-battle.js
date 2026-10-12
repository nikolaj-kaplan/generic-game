// Quiz Battle: both players pick two categories, then race through 8 multiple-choice questions.
defineGame({
  scoreboard: 'always',
  start: 'categories',

  phases: {
    categories: collect({
      input: () => [
        ui.heading('Pick two trivia categories'),
        ui.textInput('Category 1', { id: 'cat1', placeholder: 'e.g. Space' }),
        ui.textInput('Category 2', { id: 'cat2', placeholder: 'e.g. Football' }),
      ],
      async next(g) {
        const cats = [];
        for (const id of g.ids) {
          const a = g.answers.categories?.[id] || {};
          for (const c of [a.cat1, a.cat2]) if (c) cats.push(c);
        }
        if (cats.length === 0) cats.push('General knowledge', 'Geography');
        const questions = await g.ai.list(
          `Easy-to-medium multiple-choice trivia questions, two per category, for these categories: ${cats.join(', ')}. Four answer options each; exactly one is right.`,
          cats.length * 2,
          { category: 'string', question: 'string', options: 'string[4]', correct: 'string' },
          { complexity: 3 },
        );
        g.state.questions = g.random.shuffle(questions).map((q) => {
          let options = q.options.slice(0, 4);
          if (!options.some((o) => match.same(o, q.correct))) options[options.length - 1] = q.correct;
          return { ...q, options: g.random.shuffle(options) };
        });
        g.setRounds(g.state.questions.length);
        return 'question';
      },
    }),

    question: collect({
      timer: 30,
      input: (g) => {
        const q = g.state.questions[g.round - 1];
        return [ui.muted(q.category), ui.choice(q.question, q.options, { correct: q.correct, points: 5, penalty: -2, feedback: 'at-end' })];
      },
      next: 'answer',
    }),

    answer: show({
      seconds: 6,
      view: (g) => {
        const q = g.state.questions[g.round - 1];
        const given = g.answers.question || {};
        return [
          ui.subheading(q.question),
          ui.success(`Answer: ${q.correct}`),
          ui.list(g.ids.map((id) => {
            const a = given[id];
            if (a === undefined) return `${g.name(id)}: no answer (0)`;
            return match.same(a, q.correct) ? `${g.name(id)}: ${a} ✓ (+5)` : `${g.name(id)}: ${a} ✗ (−2)`;
          })),
        ];
      },
      next: (g) => (g.lastRound ? g.end() : g.nextRound('question')),
    }),
  },
});
