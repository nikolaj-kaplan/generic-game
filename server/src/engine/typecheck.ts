import fs from 'fs';
import path from 'path';
import type * as TS from 'typescript';
import { PROJECT_ROOT } from '../paths';
import { prepareProgram } from './sandbox';

// =============================================================================
// Static checks on a generated program, before it ever runs:
//   1. Shape rules: top level holds only defineGame(...), const and functions
//      (a top-level `let` would silently reset on every event), no imports.
//   2. A type check against game-api.d.ts (wrong names, wrong arguments).
// The TypeScript compiler is a dev dependency: without it only the rules run.
// =============================================================================

export const API_FILE = path.join(PROJECT_ROOT, 'server', 'src', 'engine', 'guest', 'game-api.d.ts');

let ts: typeof TS | null | undefined;
function compiler(): typeof TS | null {
  if (ts === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ts = require('typescript') as typeof TS;
    } catch {
      ts = null;
    }
  }
  return ts;
}

export function apiDeclarations(): string {
  return fs.readFileSync(API_FILE, 'utf-8');
}

const libCache = new Map<string, TS.SourceFile>();

/** Problems found, each as "line N: message". Empty means the program looks fine. */
export function checkProgramSource(code: string): string[] {
  const t = compiler();
  const source = prepareProgram(code);
  if (!t) return basicRules(source);

  const file = t.createSourceFile('game.js', source, t.ScriptTarget.ES2022, true, t.ScriptKind.JS);
  const problems = shapeRules(t, file);

  const options: TS.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: t.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    types: [],
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
  };
  const host = t.createCompilerHost(options);
  const libDir = path.dirname(t.getDefaultLibFilePath(options));
  const api = apiDeclarations();
  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === 'game.js') return file;
    if (fileName === 'game-api.d.ts') return t.createSourceFile(fileName, api, languageVersion, true);
    const full = path.isAbsolute(fileName) ? fileName : path.join(libDir, fileName);
    let sf = libCache.get(full);
    if (!sf && fs.existsSync(full)) {
      sf = t.createSourceFile(full, fs.readFileSync(full, 'utf-8'), languageVersion, true);
      libCache.set(full, sf);
    }
    return sf;
  };
  host.fileExists = (f) => f === 'game.js' || f === 'game-api.d.ts' || fs.existsSync(path.isAbsolute(f) ? f : path.join(libDir, f));
  host.readFile = (f) => (f === 'game.js' ? source : f === 'game-api.d.ts' ? api : fs.readFileSync(path.isAbsolute(f) ? f : path.join(libDir, f), 'utf-8'));
  host.writeFile = () => undefined;

  const program = t.createProgram(['game.js', 'game-api.d.ts'], options, host);
  const diagnostics = t.getPreEmitDiagnostics(program).filter((d) => !d.file || d.file.fileName === 'game.js');
  for (const d of diagnostics.slice(0, 15)) {
    const msg = withHint(t.flattenDiagnosticMessageText(d.messageText, '\n'));
    const where = d.file && d.start !== undefined ? `line ${d.file.getLineAndCharacterOfPosition(d.start).line + 1}: ` : '';
    problems.push(`${where}${msg}`);
  }
  return problems;
}

/** Plain-language fixes for the mistakes models make most often. */
function withHint(msg: string): string {
  if (/Cannot find name 'g'/.test(msg)) return `${msg} g only exists as a function parameter: write who: (g) => g.ids, view: (g, me) => [...], next: (g) => ..., never () => g.…`;
  if (/Cannot find name 'me'/.test(msg)) return `${msg} me is the second parameter of input/view/waiting: (g, me) => [...]`;
  return msg;
}

function shapeRules(t: typeof TS, file: TS.SourceFile): string[] {
  const problems: string[] = [];
  let defineCalls = 0;
  const line = (n: TS.Node) => file.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  for (const stmt of file.statements) {
    if (t.isImportDeclaration(stmt) || t.isExportDeclaration(stmt) || t.isExportAssignment(stmt)) {
      problems.push(`line ${line(stmt)}: no import/export: everything a program can use is already there (see the API).`);
    } else if (t.isVariableStatement(stmt)) {
      if (!(stmt.declarationList.flags & t.NodeFlags.Const)) {
        problems.push(`line ${line(stmt)}: top-level variables must be const. A program runs fresh for every event; keep changing data in g.state.`);
      }
    } else if (t.isExpressionStatement(stmt)) {
      const e = stmt.expression;
      if (t.isCallExpression(e) && t.isIdentifier(e.expression) && e.expression.text === 'defineGame') defineCalls++;
      else problems.push(`line ${line(stmt)}: the top level may only hold defineGame({...}), const values and functions.`);
    } else if (!t.isFunctionDeclaration(stmt) && !t.isEmptyStatement(stmt)) {
      problems.push(`line ${line(stmt)}: the top level may only hold defineGame({...}), const values and functions.`);
    }
  }
  if (defineCalls !== 1) problems.push(`The program must call defineGame({...}) exactly once (found ${defineCalls}).`);
  return problems;
}

/** Fallback without the TypeScript compiler. */
function basicRules(source: string): string[] {
  const problems: string[] = [];
  if (/^\s*(import|export)\s/m.test(source)) problems.push('no import/export: everything a program can use is already there.');
  if (/^(let|var)\s/m.test(source)) problems.push('top-level variables must be const; keep changing data in g.state.');
  if ((source.match(/\bdefineGame\s*\(/g) ?? []).length !== 1) problems.push('The program must call defineGame({...}) exactly once.');
  return problems;
}
