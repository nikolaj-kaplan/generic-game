import { useState } from 'react';
import { useGame } from '../context/GameContext';

/** A shared link like /?join=ABCDE opens with the code filled in. */
function codeFromLink(): string {
  return (new URLSearchParams(window.location.search).get('join') ?? '').toUpperCase().slice(0, 5);
}

const NAME_KEY = 'gg_name';

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export default function Home() {
  const { send, connectionStatus, errorMessage, clearError } = useGame();
  const linkCode = codeFromLink();
  // The name is asked once, like a login, and remembered on this device.
  const [name, setName] = useState(savedName);
  const [editingName, setEditingName] = useState(() => !savedName());
  const [draft, setDraft] = useState(savedName);
  const [joinCode, setJoinCode] = useState(linkCode);
  const connected = connectionStatus === 'connected';

  function handleName(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim().slice(0, 20);
    if (!trimmed) return;
    try {
      localStorage.setItem(NAME_KEY, trimmed);
    } catch {
      /* storage blocked: the name still works for this visit */
    }
    setName(trimmed);
    setEditingName(false);
  }

  function forgetOldSession() {
    // Clear any saved session so the WS reconnect logic doesn't rejoin the old one
    localStorage.removeItem('gg_playerId');
    localStorage.removeItem('gg_joinCode');
  }

  function handleCreate() {
    forgetOldSession();
    send({ type: 'create_session', playerName: name });
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    forgetOldSession();
    send({ type: 'join_session', joinCode: code, playerName: name });
  }

  const createButton = (
    <button className={`btn btn--full ${linkCode ? 'btn--secondary' : 'btn--primary'}`} onClick={handleCreate} disabled={!connected}>
      Create a new session
    </button>
  );

  const joinForm = (
    <form onSubmit={handleJoin} className="form">
      <label className="field">
        <span className="field__label">Join code</span>
        <input
          className="field__input field__input--code"
          type="text"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          placeholder="e.g. AXKF2"
          maxLength={5}
          autoFocus={!!linkCode}
        />
      </label>
      <button className={`btn btn--full ${linkCode ? 'btn--primary' : 'btn--secondary'}`} type="submit" disabled={joinCode.trim().length < 5 || !connected}>
        Join session
      </button>
    </form>
  );

  return (
    <div className="page page--center">
      <div className="card card--narrow">
        <div className="logo">
          <span className="logo__icon">🎲</span>
          <h1 className="logo__title">Generic Game</h1>
          <p className="logo__subtitle">Any game, powered by AI</p>
        </div>

        {connectionStatus === 'disconnected' && <div className="alert alert--warning">Reconnecting…</div>}

        {errorMessage && (
          <div className="alert alert--error" onClick={clearError}>
            {errorMessage} <span className="alert__dismiss">✕</span>
          </div>
        )}

        {editingName ? (
          <form onSubmit={handleName} className="form">
            <label className="field">
              <span className="field__label">Your name</span>
              <input
                className="field__input"
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Enter your name"
                maxLength={20}
                autoFocus
              />
            </label>
            <button className="btn btn--primary btn--full" type="submit" disabled={!draft.trim()}>
              Continue
            </button>
          </form>
        ) : (
          <>
            <p className="home-greeting">
              Playing as <strong>{name}</strong>
              <button className="link-button" onClick={() => setEditingName(true)}>
                Change
              </button>
            </p>
            {linkCode ? (
              <>
                {joinForm}
                <p className="home-divider">or</p>
                {createButton}
              </>
            ) : (
              <>
                {createButton}
                <p className="home-divider">or join a game</p>
                {joinForm}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
