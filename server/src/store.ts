import fs from 'fs';
import path from 'path';
import { Session } from './types';
import { dataDir } from './paths';

const DATA_DIR = dataDir();
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// ─── Ensure data directory exists ────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── In-memory store ──────────────────────────────────────────────────────────
const sessions = new Map<string, Session>();

// ─── Disk persistence ─────────────────────────────────────────────────────────

function load(): void {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const data = JSON.parse(raw) as Record<string, Session>;
    for (const session of Object.values(data)) {
      sessions.set(session.id, session);
    }
    console.log(`[store] Loaded ${sessions.size} session(s) from disk`);
  } catch (err) {
    console.error('[store] Failed to load sessions from disk:', err);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write — coalesces rapid sequential updates into a single write. */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data: Record<string, Session> = Object.fromEntries(sessions.entries());
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[store] Failed to save sessions to disk:', err);
    }
  }, 500);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function getSessionByCode(joinCode: string): Session | undefined {
  return Array.from(sessions.values()).find(
    (s) => s.joinCode === joinCode.toUpperCase(),
  );
}

export function saveSession(session: Session): void {
  session.updatedAt = new Date().toISOString();
  sessions.set(session.id, session);
  scheduleSave();
}

export function allSessions(): Session[] {
  return Array.from(sessions.values());
}

export function deleteSession(id: string): void {
  sessions.delete(id);
  scheduleSave();
}

// Load existing sessions on module initialisation
load();
