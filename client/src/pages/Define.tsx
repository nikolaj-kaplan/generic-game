import { useEffect, useState } from 'react';
import { useGame, useCurrentPlayer } from '../context/GameContext';
import Chat from '../components/Chat';
import { InvitePopup } from '../components/InviteCard';
import { GAME_PRESETS } from '../data/presets';
import { deleteSavedGame, loadSavedGames, rangeLabel, SavedGame } from '../data/savedGames';
import { useConfirm } from '../components/ConfirmDialog';

export default function Define() {
  const { chatMessages, send, isAiThinking, agreedRules, playerRange, errorMessage, clearError, session, leaveSession, toast } = useGame();
  // Progress while the game program is built ("Testing the program with bot players…")
  const [progress, setProgress] = useState<string | null>(null);
  useEffect(() => {
    if (!isAiThinking) setProgress(null);
    else if (toast) setProgress(toast.text);
  }, [toast, isAiThinking]);
  const currentPlayer = useCurrentPlayer();
  const [input, setInput] = useState('');
  const { ask, dialog } = useConfirm();
  const [showInvite, setShowInvite] = useState(false);
  const [savedGames, setSavedGames] = useState<SavedGame[]>(() => loadSavedGames());
  const isHost = currentPlayer?.isHost ?? false;
  const playerCount = session?.players.length ?? 0;
  const tooFew = !!playerRange && playerCount < playerRange.min;
  const tooMany = !!playerRange && playerCount > playerRange.max;

  /** Only show the presets panel before any messages have been exchanged
   * (i.e., the only message is the AI greeting). */
  const showPresets = !agreedRules && !chatMessages.some((m) => m.role === 'player');

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

  function handleSaved(game: SavedGame) {
    if (isAiThinking) return;
    send({ type: 'load_rules', rules: game.rules, playerRange: game.playerRange, program: game.program });
  }

  function handleDeleteSaved(game: SavedGame) {
    deleteSavedGame(game.id);
    setSavedGames(loadSavedGames());
  }

  function handleFullReset() {
    ask('Clear the chat and rules and go back to the waiting room?', () => send({ type: 'full_reset' }), 'Restart');
  }

  function handleLeave() {
    ask('Leave this game?', leaveSession, 'Leave');
  }

  return (
    <div className="page page--chat">
      {dialog}
      <header className="chat-header">
        <span className="chat-header__title">🎮 Define your game</span>
        <div className="chat-header__actions">
          <button
            className="btn btn--sm btn--secondary"
            onClick={() => setShowInvite(true)}
            title="Show the QR code so friends can join now, while the game is defined"
          >
            👥 {playerCount} · Invite
          </button>
          {isHost && (
            <button
              className="btn btn--secondary btn--sm"
              onClick={handleFullReset}
              title="Clear the chat and rules and return to the waiting room"
            >
              Restart
            </button>
          )}
          <button className="btn btn--secondary btn--sm" onClick={handleLeave} title="Leave this game">
            Leave
          </button>
        </div>
      </header>

      {showInvite && session && (
        <InvitePopup joinCode={session.joinCode} players={session.players.map((p) => p.name)} onClose={() => setShowInvite(false)} />
      )}

      {isAiThinking && (
        <div className="thinking-banner">
          <div className="thinking-banner__dots">
            <span className="thinking-banner__dot" />
            <span className="thinking-banner__dot" />
            <span className="thinking-banner__dot" />
          </div>
          {progress ?? 'AI is thinking…'}
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
          {isHost && savedGames.length > 0 && (
            <>
              <p className="presets__heading">Your saved games</p>
              <div className="presets__list presets__list--saved">
                {savedGames.map((game) => (
                  <div key={game.id} className="saved-game">
                    <button className="preset-card" onClick={() => handleSaved(game)} disabled={isAiThinking}>
                      <span className="preset-card__emoji">💾</span>
                      <span className="preset-card__body">
                        <span className="preset-card__title">{game.title}</span>
                        <span className="preset-card__meta">
                          {[rangeLabel(game.playerRange), new Date(game.savedAt).toLocaleDateString()].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </button>
                    <button className="saved-game__delete" onClick={() => handleDeleteSaved(game)} aria-label={`Delete ${game.title}`}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
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
        <div className={`confirm-banner${tooFew || tooMany ? ' confirm-banner--waiting' : ''}`}>
          <p className="confirm-banner__text">
            {tooFew
              ? `Needs ${rangeLabel(playerRange!)} · ${playerCount} joined. Invite more!`
              : tooMany
                ? `Allows ${rangeLabel(playerRange!)} · ${playerCount} joined.`
                : `Rules are ready${playerRange ? ` (${rangeLabel(playerRange)})` : ''}. Start the game?`}
          </p>
          {tooFew ? (
            <button className="btn btn--secondary" onClick={() => setShowInvite(true)}>
              Invite
            </button>
          ) : (
            <button className="btn btn--primary" onClick={() => send({ type: 'confirm_rules' })} disabled={tooMany || isAiThinking}>
              Start game
            </button>
          )}
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
