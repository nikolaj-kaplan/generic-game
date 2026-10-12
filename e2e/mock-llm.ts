/**
 * A scripted, OpenAI-compatible chat completions server for browser tests.
 * It speaks the json protocol (response_format json_schema):
 *   definition_reply  → proposes quiz rules
 *   game_program      → a one-question quiz program (secret hint for the first player)
 *                       or, for a mid-game change, the same program with a final summary
 *   ai_*              → small fake answers for g.ai calls
 */
import http from 'http';

const PORT = 11998;

interface ChatRequest {
  messages: Array<{ role: string; content: string | null }>;
  response_format?: { json_schema?: { name?: string; schema?: Record<string, unknown> } };
}

function quizProgram(seconds: number, finalScreen: boolean): string {
  return `defineGame({
  start: 'question',
  ${finalScreen ? "final: (g) => [ui.subheading('Score per question'), ui.list(g.ids.map((id) => 'Q1: ' + g.name(id) + ' ' + g.scores.get(id)))]," : ''}
  phases: {
    question: collect({
      timer: ${seconds},
      input: (g, me) => [
        ui.heading('Question 1'),
        me === g.ids[0] && ui.muted('Psst: the answer is 4'),
        ui.choice('What is 2 + 2?', ['3', '4', '5'], { correct: '4', points: 1 }),
      ],
      next: 'results',
    }),
    results: show({
      view: (g) => [ui.heading('Results'), ui.votes(g.answers.question)],
      continueLabel: 'Next',
      next: (g) => g.end('Mock game over!'),
    }),
  },
});`;
}

function reply(req: ChatRequest): Record<string, unknown> {
  const schemaName = req.response_format?.json_schema?.name ?? '';
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const firstUser = req.messages.find((m) => m.role === 'user')?.content ?? '';

  if (schemaName === 'definition_reply') {
    const quick = /quick/i.test(lastUser);
    return {
      message: 'Sounds fun! Here are the rules.',
      proposed_rules:
        `GAME: ${quick ? 'Quick Quiz' : 'Mock Quiz'}\nPLAYERS: 1-8\nSETUP: none\nROUND FLOW: 1. One question for all players at once${quick ? ', 2 seconds' : ''}.\nSCORING: 1 point per correct answer\nEND: after one question\nNOTES: none`,
      min_players: /two players/i.test(lastUser) ? 2 : 1,
      max_players: 8,
    };
  }
  if (schemaName === 'game_program') {
    const patch = firstUser.includes('HOST REQUEST');
    return {
      program: quizProgram(firstUser.includes('Quick Quiz') ? 2 : 60, patch),
      migration: '',
      summary: patch ? 'Adds a score summary to the end screen.' : 'A one-question quiz.',
      assumptions: [],
      questions: '',
    };
  }
  if (schemaName === 'ai_list') return { items: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'] };
  if (schemaName === 'ai_choose') return { answer: 'Yes' };
  if (schemaName === 'ai_text') return { text: 'Mock text' };
  return { value: 'Mock' };
}

http
  .createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.end('ok');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as ChatRequest;
    const content = JSON.stringify(reply(request));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  })
  .listen(PORT, () => console.log(`[mock-llm] listening on ${PORT}`));
