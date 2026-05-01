import { useState } from 'react';
import { useGame, useCurrentPlayer } from '../context/GameContext';
import Chat from '../components/Chat';
import { GAME_PRESETS } from '../data/presets';

export default function Define() {
  const { chatMessages, send, isAiThinking, agreedRules, errorMessage, clearError } = useGame();
  const currentPlayer = useCurrentPlayer();
  const [input, setInput] = useState('');
  const isHost = currentPlayer?.isHost ?? false;

  /** Only show the presets panel before any messages have been exchanged
   * (i.e., the only message is the AI greeting). */
  const showPresets = chatMessages.length <= 1 && !agreedRules;

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isAiThinking) return;
    send({ type: 'chat', content: trimmed });
    setInput('');
  }

  function handlePreset(prompt: string) {
    if (isAiThinking) return;
    send({ type: 'chat', content: prompt });
  }

  function handleFullReset() {
    if (confirm('Clear everything and go back to the lobby?')) {
      send({ type: 'full_reset' });
    }
  }

  return (
    <div className="page page--chat">
      <header className="chat-header">
        <span className="chat-header__title">🎮 Define your game</span>
        <div className="chat-header__actions">
          {isHost && (
            <button
              className="btn btn--secondary btn--sm"
              onClick={handleFullReset}
              title="Clear everything and return to lobby"
            >
              Back to lobby
            </button>
          )}
        </div>
      </header>

      {isAiThinking && (
        <div className="thinking-banner">
          <div className="thinking-banner__dots">
            <span className="thinking-banner__dot" />
            <span className="thinking-banner__dot" />
            <span className="thinking-banner__dot" />
          </div>
          AI is thinking…
        </div>
      )}

      {errorMessage && (
        <div className="alert alert--error alert--inline" onClick={clearError}>
          {errorMessage} <span className="alert__dismiss">✕</span>
        </div>
      )}

      <Chat messages={chatMessages} />

      {showPresets && (
        <div className="presets">
          <p className="presets__heading">Quick start — pick a game</p>
          <div className="presets__list">
            {GAME_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className="preset-card"
                onClick={() => handlePreset(preset.prompt)}
                disabled={isAiThinking}
              >
                <span className="preset-card__emoji">{preset.emoji}</span>
                <span className="preset-card__body">
                  <span className="preset-card__title">{preset.title}</span>
                  <span className="preset-card__meta">{preset.playerCount}</span>
                  <span className="preset-card__desc">{preset.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {agreedRules && isHost && (
        <div className="confirm-banner">
          <p className="confirm-banner__text">Rules are ready. Start the game?</p>
          <button
            className="btn btn--primary"
            onClick={() => send({ type: 'confirm_rules' })}
          >
            Start game
          </button>
        </div>
      )}

      <form className="chat-input" onSubmit={handleSend}>
        <input
          className="chat-input__field"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe your game…"
          disabled={isAiThinking}
          autoFocus
        />
        <button
          className="btn btn--primary chat-input__send"
          type="submit"
          disabled={!input.trim() || isAiThinking}
        >
          Send
        </button>
      </form>
    </div>
  );
}
