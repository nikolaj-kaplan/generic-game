import fs from 'fs';
import path from 'path';

/**
 * Locate the project root by walking up from this file until a folder with
 * client/package.json and shared/types.ts is found. Works from server/src (tsx)
 * and from server/dist/server/src (built output, which has its own server/ and
 * shared/ folders but no client/) alike.
 */
function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'client', 'package.json')) && fs.existsSync(path.join(dir, 'shared', 'types.ts'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`[paths] Could not find project root from ${__dirname}`);
}

export const PROJECT_ROOT = findProjectRoot();

/** DATA_DIR can be overridden (the playtest harness uses a temp folder). */
export function dataDir(): string {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(PROJECT_ROOT, 'data');
}

export const CLIENT_DIST = path.join(PROJECT_ROOT, 'client', 'dist');
export const ENV_FILE = path.join(PROJECT_ROOT, '.env');
