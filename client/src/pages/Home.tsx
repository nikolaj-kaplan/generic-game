import { useState } from 'react';
import { useGame } from '../context/GameContext';

export default function Home() {
  const { send, connectionStatus, errorMessage, clearError } = useGame();
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // Clear any saved session so the WS reconnect logic doesn't rejoin the old one
    localStorage.removeItem('gg_playerId');
    localStorage.removeItem('gg_joinCode');
    send({ type: 'create_session', playerName: trimmed });
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedCode = joinCode.trim().toUpperCase();
    if (!trimmedName || !trimmedCode) return;
    send({ type: 'join_session', joinCode: trimmedCode, playerName: trimmedName });
  }

  return (
    <div className="page page--center">
      <div className="card card--narrow">
        <div className="logo">
          <span className="logo__icon">🎲</span>
          <h1 className="logo__title">Generic Game</h1>
          <p className="logo__subtitle">Any game, powered by AI</p>
        </div>

        {connectionStatus === 'disconnected' && (
          <div className="alert alert--warning">Reconnecting…</div>
        )}

        {errorMessage && (
          <div className="alert alert--error" onClick={clearError}>
            {errorMessage} <span className="alert__dismiss">✕</span>
          </div>
        )}

        <div className="tabs">
          <button
            className={`tabs__tab ${tab === 'create' ? 'tabs__tab--active' : ''}`}
            onClick={() => setTab('create')}
          >
            Create game
          </button>
          <button
            className={`tabs__tab ${tab === 'join' ? 'tabs__tab--active' : ''}`}
            onClick={() => setTab('join')}
          >
            Join game
          </button>
        </div>

        {tab === 'create' ? (
          <form onSubmit={handleCreate} className="form">
            <label className="field">
              <span className="field__label">Your name</span>
              <input
                className="field__input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
                maxLength={20}
                autoFocus
              />
            </label>
            <button
              className="btn btn--primary btn--full"
              type="submit"
              disabled={!name.trim() || connectionStatus !== 'connected'}
            >
              Create a new session
            </button>
          </form>
        ) : (
          <form onSubmit={handleJoin} className="form">
            <label className="field">
              <span className="field__label">Your name</span>
              <input
                className="field__input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
                maxLength={20}
                autoFocus
              />
            </label>
            <label className="field">
              <span className="field__label">Join code</span>
              <input
                className="field__input field__input--code"
                type="text"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="e.g. AXKF2"
                maxLength={5}
              />
            </label>
            <button
              className="btn btn--primary btn--full"
              type="submit"
              disabled={!name.trim() || !joinCode.trim() || connectionStatus !== 'connected'}
            >
              Join session
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
