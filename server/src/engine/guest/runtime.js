// =============================================================================
// Game runtime: runs INSIDE the QuickJS sandbox, together with the generated
// game program. Plain JavaScript, no Node APIs.
//
// The host evaluates this file, then the program (which calls defineGame), then
// calls __engine.dispatch(inputJson) once per event. A fresh sandbox is made for
// every event, so a program can only keep data in g.state (passed in as JSON).
//
// Host functions provided to the sandbox:
//   __hostAi(requestJson) → Promise<resultJson>   (an LLM call, see g.ai)
// =============================================================================

(function () {
  'use strict';

  var GAME = null;
  var CTX = null; // g of the event being processed (ui.votes and friends use it)

  // ─── Program definition ────────────────────────────────────────────────────

  globalThis.defineGame = function defineGame(def) {
    if (GAME) throw new Error('defineGame() may only be called once.');
    if (!def || typeof def !== 'object') throw new Error('defineGame() needs an object.');
    GAME = def;
    return def;
  };

  function phaseKind(kind) {
    return function (spec) {
      if (!spec || typeof spec !== 'object') throw new Error(kind + '() needs an object.');
      var copy = {};
      for (var k in spec) copy[k] = spec[k];
      copy.__kind = kind;
      return copy;
    };
  }
  globalThis.collect = phaseKind('collect');
  globalThis.buzzer = phaseKind('buzzer');
  globalThis.turn = phaseKind('turn');
  globalThis.show = phaseKind('show');
  globalThis.slides = phaseKind('slides');

  // ─── Seeded random numbers (also replaces Math.random) ─────────────────────

  function makeRandom(E) {
    function next() {
      // mulberry32
      E.rng = (E.rng + 0x6d2b79f5) | 0;
      var t = E.rng;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    }
    function shuffle(arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(next() * (i + 1));
        var tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
      }
      return a;
    }
    return {
      next: next,
      int: int,
      pick: function (arr) {
        if (!arr || !arr.length) throw new Error('g.random.pick() needs a non-empty array.');
        return arr[Math.floor(next() * arr.length)];
      },
      shuffle: shuffle,
      sample: function (arr, n) {
        return shuffle(arr).slice(0, n);
      },
    };
  }

  // ─── Text helpers ──────────────────────────────────────────────────────────

  function normalize(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/^\s*(the|a|an)\s+/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    var prev = [];
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      var cur = [i];
      for (var k = 1; k <= b.length; k++) {
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  globalThis.match = {
    /** Same text ignoring case, accents, punctuation and a leading "the/a/an". */
    same: function (a, b) {
      return normalize(a) === normalize(b);
    },
    /** Like same(), but also allows small typos (about 1 wrong letter per 5). */
    close: function (a, b) {
      var x = normalize(a);
      var y = normalize(b);
      if (!x || !y) return false;
      if (x === y) return true;
      var nx = x.replace(/ /g, '');
      var ny = y.replace(/ /g, '');
      if (nx === ny) return true;
      return levenshtein(nx, ny) <= Math.max(1, Math.floor(Math.max(nx.length, ny.length) / 5));
    },
    normalize: normalize,
  };

  /** Count answers: tally({p1: 'x', p2: 'x', p3: 'y'}).top() → ['x']. */
  globalThis.tally = function tally(answers) {
    var counts = {};
    var order = [];
    var src = answers || {};
    for (var k in src) {
      var v = src[k];
      if (v === undefined || v === null || v === '') continue;
      var key = typeof v === 'string' ? v : JSON.stringify(v);
      if (!(key in counts)) {
        counts[key] = 0;
        order.push(key);
      }
      counts[key]++;
    }
    var max = 0;
    for (var c in counts) max = Math.max(max, counts[c]);
    return {
      counts: counts,
      /** The values with the most votes (several on a tie, none without votes). */
      top: function () {
        return max === 0 ? [] : order.filter(function (k) { return counts[k] === max; });
      },
      max: max,
      /** Votes for one value (0 if none). */
      of: function (value) {
        return counts[value] || 0;
      },
    };
  };

  // ─── UI builders ───────────────────────────────────────────────────────────

  function text(style) {
    return function (content) {
      return { type: 'text', content: String(content), style: style };
    };
  }

  globalThis.ui = {
    heading: text('heading'),
    subheading: text('subheading'),
    text: text('body'),
    muted: text('muted'),
    success: text('success'),
    error: text('error'),
    divider: function () {
      return { type: 'divider' };
    },
    list: function (items, opts) {
      return { type: 'list', items: (items || []).map(String), ordered: !!(opts && opts.ordered) };
    },
    textInput: function (label, opts) {
      opts = opts || {};
      return {
        type: 'input',
        fieldId: opts.id || 'text',
        label: label,
        placeholder: opts.placeholder,
        maxLength: opts.maxLength || 200,
        multiline: !!opts.multiline,
      };
    },
    choice: function (question, options, opts) {
      opts = opts || {};
      if (!Array.isArray(options) || options.length < 2) throw new Error('ui.choice() needs at least 2 options.');
      var c = { type: 'multiple_choice', fieldId: opts.id || 'choice', question: String(question), options: options.map(String) };
      if (opts.correct !== undefined && opts.correct !== null) {
        c.__key = {
          correct: String(opts.correct),
          points: opts.points === undefined ? 1 : Number(opts.points),
          penalty: opts.penalty === undefined ? 0 : -Math.abs(Number(opts.penalty)),
          feedback: opts.feedback === 'at-end' ? 'at-end' : 'now',
        };
      }
      return c;
    },
    pickPlayer: function (question, opts) {
      opts = opts || {};
      return { type: 'multiple_choice', fieldId: opts.id || 'player', question: String(question), options: [], __pick: { others: opts.others !== false, among: opts.among } };
    },
    button: function (id, label, opts) {
      return { type: 'button', actionId: String(id), label: String(label), style: (opts && opts.style) || 'primary' };
    },
    /** "Ana → Bob" for every answer; player ids are shown as names. */
    votes: function (answers) {
      var items = [];
      var src = answers || {};
      for (var pid in src) {
        var v = src[pid];
        if (v === undefined || v === null) continue;
        var shown = typeof v === 'string' ? nameOrValue(v) : typeof v === 'object' && v.button ? v.button : JSON.stringify(v);
        items.push(nameOrValue(pid) + ' → ' + shown);
      }
      return { type: 'list', items: items.length ? items : ['(no answers)'] };
    },
    scoreboard: function () {
      return { type: '__scoreboard' };
    },
  };

  function showValue(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v !== 'object') return nameOrValue(String(v));
    return Object.keys(v)
      .filter(function (k) { return k !== 'button' || v[k] !== 'submit'; })
      .map(function (k) { return nameOrValue(String(v[k])); })
      .join(' / ');
  }

  function nameOrValue(v) {
    if (!CTX) return String(v);
    var p = CTX.player(v);
    return p ? p.name : String(v);
  }

  // ─── Engine state helpers ──────────────────────────────────────────────────

  function roundKey(r) {
    return 'r' + r;
  }

  function marker(obj) {
    obj.__marker = true;
    return obj;
  }

  function makeCtx(E, players, hostAi) {
    var random = makeRandom(E);
    Math.random = random.next;
    var byId = {};
    players.forEach(function (p) {
      byId[p.id] = p;
    });

    function ids(x) {
      return Array.isArray(x) ? x : [x];
    }

    function aiCall(op, payload) {
      if (typeof __hostAi !== 'function') throw new Error('AI calls are not available here.');
      payload.op = op;
      return __hostAi(JSON.stringify(payload)).then(function (s) {
        return JSON.parse(s);
      });
    }

    var g = {
      state: E.state,
      players: players,
      get ids() {
        return players.map(function (p) { return p.id; });
      },
      get host() {
        var h = players.filter(function (p) { return p.isHost; })[0] || players[0];
        return h ? h.id : undefined;
      },
      get phase() {
        return E.phase;
      },
      get round() {
        return E.round;
      },
      get rounds() {
        return E.rounds;
      },
      get lastRound() {
        return E.rounds != null && E.round >= E.rounds;
      },
      setRounds: function (n) {
        E.rounds = Math.max(1, Math.round(Number(n)));
      },
      get answers() {
        return E.answers[roundKey(E.round)] || (E.answers[roundKey(E.round)] = {});
      },
      answersIn: function (round) {
        return E.answers[roundKey(round)] || {};
      },
      player: function (id) {
        return byId[id];
      },
      name: function (id) {
        var p = byId[id];
        return p ? p.name : String(id);
      },
      names: function (list) {
        var n = ids(list || []).map(g.name);
        if (n.length <= 1) return n.join('');
        return n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
      },
      others: function (me) {
        return players.filter(function (p) { return p.id !== me; }).map(function (p) { return p.id; });
      },
      scores: {
        add: function (who, points) {
          ids(who).forEach(function (id) {
            if (id === undefined || id === null) return;
            E.scores[id] = (E.scores[id] || 0) + Number(points || 0);
          });
        },
        set: function (who, points) {
          ids(who).forEach(function (id) {
            E.scores[id] = Number(points || 0);
          });
        },
        get: function (id) {
          return E.scores[id] || 0;
        },
        all: function () {
          var out = {};
          players.forEach(function (p) { out[p.id] = E.scores[p.id] || 0; });
          return out;
        },
        /** Player ids with the highest score (several on a tie). */
        leaders: function () {
          var best = -Infinity;
          players.forEach(function (p) { best = Math.max(best, E.scores[p.id] || 0); });
          return players.filter(function (p) { return (E.scores[p.id] || 0) === best; }).map(function (p) { return p.id; });
        },
      },
      random: random,
      nextRound: function (phase) {
        return marker({ nextRound: phase });
      },
      end: function (message) {
        return marker({ end: true, message: message });
      },
      ai: {
        text: function (prompt, opts) {
          return aiCall('text', { prompt: String(prompt), complexity: complexityOf(opts) });
        },
        json: function (prompt, schema, opts) {
          return aiCall('json', { prompt: String(prompt), schema: schema, complexity: complexityOf(opts) });
        },
        list: function (prompt, n, schema, opts) {
          if (schema && !opts && typeof schema === 'object' && 'complexity' in schema && Object.keys(schema).length === 1) {
            opts = schema;
            schema = undefined;
          }
          return aiCall('list', { prompt: String(prompt), n: Number(n), schema: schema || 'string', complexity: complexityOf(opts) });
        },
        choose: function (question, options, opts) {
          return aiCall('choose', { prompt: String(question), options: (options || []).map(String), complexity: complexityOf(opts) });
        },
        yesNo: function (question, opts) {
          return aiCall('choose', { prompt: String(question), options: ['Yes', 'No'], complexity: complexityOf(opts) }).then(function (r) {
            return r === 'Yes';
          });
        },
      },
      log: function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(typeof arguments[i] === 'string' ? arguments[i] : JSON.stringify(arguments[i]));
        E.log.push(parts.join(' '));
        if (E.log.length > 50) E.log.shift();
      },
    };
    return g;
  }

  function complexityOf(opts) {
    var c = opts && opts.complexity !== undefined ? Number(opts.complexity) : 1;
    return Math.min(5, Math.max(1, Math.round(c) || 1));
  }

  // ─── Components: flatten, validate, players as options ─────────────────────

  var KNOWN = { text: 1, input: 1, button: 1, multiple_choice: 1, list: 1, divider: 1, __scoreboard: 1 };

  function flatten(x, out) {
    out = out || [];
    if (x === null || x === undefined || x === false || x === '') return out;
    if (Array.isArray(x)) {
      x.forEach(function (y) { flatten(y, out); });
      return out;
    }
    if (typeof x === 'string' || typeof x === 'number') {
      out.push({ type: 'text', content: String(x), style: 'body' });
      return out;
    }
    if (typeof x !== 'object' || !KNOWN[x.type]) {
      throw new Error('Not a UI component: ' + JSON.stringify(x).slice(0, 120) + '. Build screens with ui.* functions.');
    }
    out.push(x);
    return out;
  }

  /** Turn ui.pickPlayer into options for this viewer; returns [components, meta]. */
  function resolveScreen(raw, g, me, interactive) {
    var comps = flatten(raw);
    var meta = { fields: {}, buttons: [] };
    var out = [];
    comps.forEach(function (c) {
      if (c.type === 'multiple_choice') {
        if (!interactive) {
          out.push({ type: 'text', content: c.question, style: 'subheading' });
          return;
        }
        var copy = { type: 'multiple_choice', fieldId: c.fieldId, question: c.question, options: c.options };
        var f = { kind: 'choice', options: c.options };
        if (c.__pick) {
          var pool = c.__pick.among ? c.__pick.among : g.ids;
          var choices = pool.filter(function (id) { return !(c.__pick.others && id === me); });
          var labels = uniqueLabels(choices.map(g.name));
          copy.options = labels;
          f = { kind: 'player', options: labels, ids: choices };
        }
        if (c.__key) f.key = c.__key;
        if (meta.fields[c.fieldId]) throw new Error('Two inputs on one screen use the id "' + c.fieldId + '". Give them different ids.');
        meta.fields[c.fieldId] = f;
        out.push(copy);
      } else if (c.type === 'input') {
        if (!interactive) return;
        if (meta.fields[c.fieldId]) throw new Error('Two inputs on one screen use the id "' + c.fieldId + '". Give them different ids.');
        meta.fields[c.fieldId] = { kind: 'text', maxLength: c.maxLength };
        out.push(c);
      } else if (c.type === 'button') {
        if (!interactive) return;
        meta.buttons.push(c.actionId);
        out.push(c);
      } else {
        out.push(c);
      }
    });
    if (interactive) {
      var choices = Object.keys(meta.fields).filter(function (k) { return meta.fields[k].kind !== 'text'; });
      var texts = Object.keys(meta.fields).filter(function (k) { return meta.fields[k].kind === 'text'; });
      if (choices.length > 1) throw new Error('A screen can hold only one ui.choice/ui.pickPlayer (players answer by clicking an option).');
      if (choices.length && (texts.length || meta.buttons.length)) {
        throw new Error('A ui.choice/ui.pickPlayer cannot share a screen with text inputs or buttons: clicking an option sends the answer.');
      }
      if (texts.length && meta.buttons.indexOf('submit') === -1) {
        var at = -1;
        out.forEach(function (c, i) { if (c.type === 'button' && at === -1) at = i; });
        var submit = { type: 'button', actionId: 'submit', label: 'Submit', style: 'primary' };
        if (at === -1) out.push(submit);
        else out.splice(at, 0, submit);
        meta.buttons.push('submit');
      }
    }
    return { components: out, meta: meta };
  }

  function uniqueLabels(names) {
    var seen = {};
    return names.map(function (n) {
      seen[n] = (seen[n] || 0) + 1;
      return seen[n] > 1 ? n + ' (' + seen[n] + ')' : n;
    });
  }

  function hasInteractive(meta) {
    return Object.keys(meta.fields).length > 0 || meta.buttons.length > 0;
  }

  // ─── Engine ────────────────────────────────────────────────────────────────

  var E = null;
  var g = null;
  var NOW = 0;

  function spec() {
    return E.phase ? GAME.phases[E.phase] : null;
  }

  function val(x) {
    return typeof x === 'function' ? x(g) : x;
  }

  function participants(s) {
    if (s.__kind === 'turn') {
      var who = typeof s.who === 'function' ? s.who(g) : s.who;
      if (Array.isArray(who)) who = who[0];
      return who && g.player(who) ? [who] : [];
    }
    if (s.__kind === 'show' || s.__kind === 'slides') return [];
    var list = s.who === undefined ? g.ids : typeof s.who === 'function' ? s.who(g) : s.who;
    if (!Array.isArray(list)) list = [list];
    return list.filter(function (id) { return !!g.player(id); });
  }

  function slideItems(s) {
    var items = val(s.items);
    if (!Array.isArray(items)) throw new Error('slides(): items must be an array (or a function returning one).');
    return items;
  }

  function startTimer(seconds) {
    if (seconds && seconds > 0) {
      E.cur.seconds = Math.round(seconds);
      E.cur.endsAt = Date.now() + Math.round(seconds) * 1000;
    } else {
      delete E.cur.seconds;
      delete E.cur.endsAt;
    }
  }

  async function goTo(target) {
    for (var hops = 0; ; hops++) {
      if (hops > 60) throw new Error('More than 60 phase changes without waiting for a player: next() or enter() probably loop.');
      if (target && target.__marker && target.end) {
        finish(target.message);
        return;
      }
      if (target && target.__marker && target.nextRound !== undefined) {
        E.round += 1;
        target = target.nextRound;
      }
      if (typeof target !== 'string' || !GAME.phases[target]) {
        throw new Error(
          'Phase "' + E.phase + '" went to ' + JSON.stringify(target) + '. A next() must return a phase id (' +
            Object.keys(GAME.phases).join(', ') + "), g.nextRound('<phase>') or g.end().",
        );
      }
      E.phase = target;
      E.turn += 1;
      E.cur = { responses: {}, checks: {}, index: 0, startedAt: Date.now() };
      var s = spec();
      if (s.enter) {
        var redirect = await s.enter(g);
        if (redirect) {
          target = redirect;
          continue;
        }
      }
      var who = participants(s);
      E.cur.expected = who;
      if (s.__kind === 'show') {
        startTimer(val(s.seconds));
        if (!E.cur.endsAt) E.cur.expected = [g.host];
      } else if (s.__kind === 'slides') {
        var items = slideItems(s);
        if (!items.length) {
          target = await nextOf(s, undefined);
          continue;
        }
        startTimer(val(s.seconds) || 3);
      } else {
        startTimer(val(s.timer));
        if (who.length === 0) {
          // Nobody can act: move on right away.
          target = await nextOf(s, s.__kind === 'collect' ? undefined : null);
          continue;
        }
      }
      return;
    }
  }

  async function nextOf(s, arg) {
    var n = s.next;
    if (typeof n === 'function') return await n(g, arg);
    return n;
  }

  function finish(message) {
    var leaders = g.scores.leaders();
    var anyScore = g.ids.some(function (id) { return (E.scores[id] || 0) !== 0; });
    var msg = message;
    if (!msg) {
      if (!anyScore || !leaders.length) msg = 'Game over!';
      else if (g.ids.length === 1) msg = 'Game over! You scored ' + g.scores.get(leaders[0]) + ' points.';
      else if (leaders.length === 1) msg = '🏆 ' + g.name(leaders[0]) + ' wins with ' + g.scores.get(leaders[0]) + ' points!';
      else msg = "🏆 It's a tie: " + g.names(leaders) + ' with ' + g.scores.get(leaders[0]) + ' points each!';
    }
    E.over = { message: String(msg), winners: anyScore ? leaders : [] };
    E.phase = null;
    E.cur = null;
    E.turn += 1;
  }

  /** Map a raw input to the value handed to the program; null = not acceptable. */
  function readInput(meta, input) {
    var fields = {};
    var button = null;
    if (input.kind === 'action') {
      if (meta.buttons.indexOf(input.id) === -1) return null;
      button = input.id;
    } else {
      var values = input.values || {};
      if (meta.buttons.indexOf(input.id) !== -1) button = input.id;
      for (var k in meta.fields) {
        var f = meta.fields[k];
        if (!(k in values)) continue;
        var v = String(values[k]);
        if (f.kind === 'text') {
          fields[k] = v.trim().slice(0, f.maxLength || 200);
        } else {
          var idx = f.options.indexOf(v);
          if (idx === -1) return null;
          fields[k] = f.kind === 'player' ? f.ids[idx] : f.options[idx];
        }
      }
      if (!button && Object.keys(fields).length === 0) return null;
    }
    var keys = Object.keys(fields);
    if ((!button || button === 'submit') && keys.length === 1) return { value: fields[keys[0]], fields: fields };
    var obj = {};
    keys.forEach(function (k) { obj[k] = fields[k]; });
    if (button) obj.button = button;
    return { value: obj, fields: fields };
  }

  function checkKeys(meta, fields, pid) {
    var out = [];
    for (var k in meta.fields) {
      var key = meta.fields[k].key;
      if (!key || !(k in fields)) continue;
      var right = match.same(fields[k], key.correct);
      var pts = right ? key.points : key.penalty;
      if (pts) g.scores.add(pid, pts);
      E.cur.checks[pid] = { correct: right, points: pts, answer: key.correct, feedback: key.feedback };
      out.push(E.cur.checks[pid]);
    }
    return out;
  }

  function record(pid, value) {
    var bucket = g.answers;
    if (!bucket[E.phase]) bucket[E.phase] = {};
    bucket[E.phase][pid] = value;
  }

  function inputScreen(s, pid) {
    if (s.__kind === 'collect' || s.__kind === 'turn') return resolveScreen(s.input(g, pid), g, pid, true);
    if (s.__kind === 'buzzer') {
      var buttons = [];
      var b = val(s.buttons) || { buzz: 'Buzz!' };
      if (Array.isArray(b)) b.forEach(function (x) { buttons.push(ui.button(x.id, x.label, x)); });
      else Object.keys(b).forEach(function (id, i) { buttons.push(ui.button(id, b[id], { style: i === 0 ? 'primary' : 'secondary' })); });
      return resolveScreen([s.view ? s.view(g, pid) : [], buttons], g, pid, true);
    }
    if (s.__kind === 'show') return resolveScreen([s.view(g, pid), ui.button('continue', s.continueLabel || 'Continue ▶')], g, pid, true);
    throw new Error('Phase kind ' + s.__kind + ' takes no input.');
  }

  async function handleInput(ev) {
    var s = spec();
    if (!s || !E.cur) return { error: 'The game is over.' };
    if (ev.turn !== undefined && ev.turn !== E.turn) return { ignored: 'old screen' };
    var pid = ev.playerId;
    if (E.cur.expected.indexOf(pid) === -1) return { error: "It's not your turn." };
    if (E.cur.responses[pid] !== undefined) return { ignored: 'already answered' };
    var screen = inputScreen(s, pid);
    var read = readInput(screen.meta, ev.input);
    if (!read) return { error: 'That answer was not understood. Try again.' };

    if (s.__kind === 'collect') {
      E.cur.responses[pid] = true;
      record(pid, read.value);
      checkKeys(screen.meta, read.fields, pid);
      var all = E.cur.expected.every(function (id) { return E.cur.responses[id]; });
      if (all) await goTo(await nextOf(s, undefined));
      return {};
    }
    if (s.__kind === 'turn') {
      E.cur.responses[pid] = true;
      record(pid, read.value);
      checkKeys(screen.meta, read.fields, pid);
      await goTo(await nextOf(s, read.value));
      return {};
    }
    if (s.__kind === 'buzzer') {
      var press = { player: pid, button: typeof read.value === 'object' && read.value ? read.value.button : read.value };
      E.cur.responses[pid] = true;
      record(pid, press.button);
      await goTo(await nextOf(s, press));
      return {};
    }
    if (s.__kind === 'show') {
      await goTo(await nextOf(s, undefined));
      return {};
    }
    return { error: 'This screen takes no input.' };
  }

  async function handleTimer(ev) {
    var s = spec();
    if (!s || !E.cur || ev.turn !== E.turn) return { ignored: 'old timer' };
    if (s.__kind === 'slides') {
      var items = slideItems(s);
      if (E.cur.index + 1 < items.length) {
        E.cur.index += 1;
        E.turn += 1;
        startTimer(val(s.seconds) || 3);
        return {};
      }
      await goTo(await nextOf(s, undefined));
      return {};
    }
    E.cur.timedOut = true;
    if (s.__kind === 'turn') await goTo(await nextOf(s, undefined));
    else if (s.__kind === 'buzzer') await goTo(await nextOf(s, null));
    else await goTo(await nextOf(s, undefined));
    return {};
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  function scoreboardComponent() {
    return {
      type: 'scoreboard',
      players: g.players.map(function (p) { return { id: p.id, name: p.name, score: E.scores[p.id] || 0 }; }),
    };
  }

  function chrome(s, comps, opts) {
    var out = [];
    // Slides change by themselves every few seconds: a countdown on each one is noise.
    if (E.cur && E.cur.endsAt && !opts.answered && s.__kind !== 'slides') {
      out.push({
        type: 'countdown',
        timerId: 't' + E.turn,
        seconds: E.cur.seconds,
        endsAt: E.cur.endsAt,
        label: s.__kind === 'show' || s.__kind === 'slides' ? 'Next screen in' : undefined,
      });
    }
    if (E.rounds && E.rounds > 1 && s.showRound !== false && GAME.showRound !== false) {
      out.push({ type: 'text', content: 'Round ' + E.round + ' of ' + E.rounds, style: 'muted' });
    }
    var hasBoard = false;
    comps.forEach(function (c) {
      if (c.type === '__scoreboard') {
        hasBoard = true;
        out.push(scoreboardComponent());
      } else out.push(c);
    });
    var mode = GAME.scoreboard || 'reveal';
    var reveal = s.__kind === 'show';
    if (!hasBoard && (mode === 'always' || (mode === 'reveal' && reveal))) out.push(scoreboardComponent());
    return out;
  }

  function waitingText(names) {
    return { type: 'text', content: 'Waiting for ' + names + '…', style: 'muted' };
  }

  function feedbackFor(pid) {
    var c = E.cur.checks[pid];
    if (!c || c.feedback !== 'now') return [];
    var pts = c.points ? ' (' + (c.points > 0 ? '+' : '') + c.points + ')' : '';
    return [c.correct ? ui.success('✓ Correct!' + pts) : ui.error('✗ The answer was ' + c.answer + pts)];
  }

  function renderFor(pid) {
    if (E.over) {
      var extra = GAME.final ? resolveScreen(GAME.final(g, pid), g, pid, false).components : [];
      var hasBoard = extra.some(function (c) { return c.type === '__scoreboard'; });
      extra = extra.map(function (c) { return c.type === '__scoreboard' ? scoreboardComponent() : c; });
      // The app shows E.over.message in its game-over panel; the screen holds the results.
      var end = extra.concat(GAME.scoreboard === 'never' || hasBoard ? [] : [scoreboardComponent()]);
      return end.length ? end : [{ type: 'text', content: E.over.message, style: 'heading' }];
    }
    var s = spec();
    if (!s) return [];
    var expected = E.cur.expected.indexOf(pid) !== -1;
    var answered = !!E.cur.responses[pid];

    if (s.__kind === 'slides') {
      var items = slideItems(s);
      return chrome(s, resolveScreen(s.view(g, items[E.cur.index], E.cur.index, pid), g, pid, false).components, {});
    }
    if (s.__kind === 'show') {
      if (expected) return chrome(s, inputScreen(s, pid).components, {});
      return chrome(s, resolveScreen(s.view(g, pid), g, pid, false).components, {});
    }
    if (expected && !answered) return chrome(s, inputScreen(s, pid).components, {});
    if (expected && answered) {
      // Who is still answering is shown by the app above the screen.
      if (s.waiting) return chrome(s, resolveScreen(s.waiting(g, pid), g, pid, false).components, { answered: true });
      var base = resolveScreen(s.input(g, pid), g, pid, false).components;
      var mine = (g.answers[E.phase] || {})[pid];
      var fb = feedbackFor(pid);
      var yours = !fb.length && mine !== undefined ? [ui.muted('Your answer: ' + showValue(mine))] : [];
      return chrome(s, resolveScreen(base, g, pid, false).components.concat(fb, yours, [ui.success('✓ Your answer is in.')]), { answered: true });
    }
    // Not taking part in this phase
    if (s.__kind === 'turn') {
      var view = s.waitingView ? s.waitingView(g, pid) : waitingText(g.names(E.cur.expected));
      return chrome(s, resolveScreen(view, g, pid, false).components, {});
    }
    if (s.view) return chrome(s, resolveScreen(s.view(g, pid), g, pid, false).components, {});
    return chrome(s, [waitingText(g.names(E.cur.expected))], {});
  }

  function renderAll(players) {
    var screens = {};
    players.forEach(function (p) {
      screens[p.id] = renderFor(p.id);
    });
    return screens;
  }

  // ─── Entry point ───────────────────────────────────────────────────────────

  function fresh(seed) {
    return {
      v: 1,
      phase: null,
      round: 1,
      rounds: null,
      turn: 0,
      state: {},
      scores: {},
      answers: {},
      cur: null,
      over: null,
      rng: seed | 0,
      log: [],
    };
  }

  function check() {
    if (!GAME) throw new Error('The program never called defineGame({...}).');
    if (!GAME.phases || typeof GAME.phases !== 'object') throw new Error('defineGame needs "phases": { id: collect({...}), ... }.');
    var ids = Object.keys(GAME.phases);
    if (!ids.length) throw new Error('defineGame needs at least one phase.');
    ids.forEach(function (id) {
      var s = GAME.phases[id];
      if (!s || !s.__kind) throw new Error('Phase "' + id + '" must be made with collect(), buzzer(), turn(), show() or slides().');
      if ((s.__kind === 'collect' || s.__kind === 'turn') && typeof s.input !== 'function') throw new Error('Phase "' + id + '" (' + s.__kind + ') needs input(g, me).');
      if ((s.__kind === 'show' || s.__kind === 'slides') && typeof s.view !== 'function') throw new Error('Phase "' + id + '" (' + s.__kind + ') needs view().');
      if (s.__kind === 'turn' && s.who === undefined) throw new Error('Phase "' + id + '" (turn) needs who: (g) => playerId.');
      if (s.__kind === 'slides' && s.items === undefined) throw new Error('Phase "' + id + '" (slides) needs items.');
      if (s.next === undefined) throw new Error('Phase "' + id + '" needs next.');
    });
    if (!GAME.start || !GAME.phases[GAME.start]) throw new Error('defineGame needs "start": the id of the first phase (' + ids.join(', ') + ').');
  }

  globalThis.__engine = {
    describe: function () {
      check();
      var phases = {};
      Object.keys(GAME.phases).forEach(function (id) { phases[id] = GAME.phases[id].__kind; });
      return JSON.stringify({ start: GAME.start, rounds: GAME.rounds || null, players: GAME.players || null, phases: phases, scoreboard: GAME.scoreboard || 'reveal' });
    },

    /** One event in, the new engine state and every player's screen out. */
    dispatch: async function (inputJson) {
      var input = JSON.parse(inputJson);
      var result = {};
      check();
      E = input.engine ? input.engine : fresh(input.seed);
      g = makeCtx(E, input.players, null);
      CTX = g;
      var ev = input.event;
      if (ev.type === 'start') {
        E = fresh(input.seed);
        g = makeCtx(E, input.players, null);
        CTX = g;
        if (GAME.rounds) E.rounds = Math.max(1, Math.round(val(GAME.rounds)));
        g.ids.forEach(function (id) { E.scores[id] = 0; });
        if (GAME.setup) await GAME.setup(g);
        await goTo(GAME.start);
      } else if (ev.type === 'input') {
        result = await handleInput(ev);
      } else if (ev.type === 'timer') {
        result = await handleTimer(ev);
      } else if (ev.type === 'migrate') {
        // A one-off migration function evaluated by the host as __migrate.
        if (typeof globalThis.__migrate === 'function') {
          var to = await globalThis.__migrate(g);
          if (to) {
            // A change after game over may reopen the game.
            E.over = null;
            await goTo(to);
          }
        }
      }
      if (E.phase && !GAME.phases[E.phase]) {
        throw new Error('The current phase "' + E.phase + '" does not exist in the program. A migration must return the phase to continue in.');
      }
      // 'render' changes nothing.
      E.state = g.state;
      var screens = renderAll(input.players);
      var s = spec();
      return JSON.stringify({
        engine: E,
        screens: screens,
        result: result,
        timer: E.cur && E.cur.endsAt ? { turn: E.turn, endsAt: E.cur.endsAt } : null,
        waiting: E.cur
          ? {
              kind: s ? s.__kind : null,
              expected: E.cur.expected,
              answered: Object.keys(E.cur.responses),
            }
          : null,
        over: E.over,
      });
    },
  };
})();
