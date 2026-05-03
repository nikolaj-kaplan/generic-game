import { useState } from 'react';
import { useGame, useCurrentPlayer } from '../context/GameContext';
import UIRenderer from '../components/UIRenderer';

const INTERACTIVE_UI_TYPES = new Set(['button', 'input', 'multiple_choice', 'form']);

export default function Play() {
  const { currentUI, isAiThinking, agreedRules, errorMessage, clearError, send, sessionStatus, endGameMessage } =
    useGame();
  const currentPlayer = useCurrentPlayer();
  const [showRules, setShowRules] = useState(false);
  const [showTweak, setShowTweak] = useState(false);
  const [tweakInput, setTweakInput] = useState('');
  const isFinished = sessionStatus === 'finished';
  const isStuck =
    !isFinished &&
    !isAiThinking &&
    currentUI.length > 0 &&
    !currentUI.some((c) => INTERACTIVE_UI_TYPES.has(c.type));

  function handleStuckNudge() {
    send({
      type: 'game_tweak',
      content:
        "I don't have any buttons or inputs — I can't do anything. Please give me an action to perform.",
    });
  }

  function handlePlayAgain() {
    send({ type: 'reset_session' });
  }

  function handleTweakSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = tweakInput.trim();
    if (!trimmed || isAiThinking) return;
    send({ type: 'game_tweak', content: trimmed });
    setTweakInput('');
    setShowTweak(false);
  }

  return (
    <div className={`page page--play${isAiThinking ? ' page--thinking' : ''}`}>
      <header className="play-header">
        <span className="play-header__title">🎮 Game</span>
        <div className="play-header__actions">
          {currentPlayer?.isHost && (
            <button
              className="btn btn--secondary btn--sm"
              onClick={handlePlayAgain}
              title="Reset and go back to game setup"
            >
              Play again
            </button>
          )}
          {currentPlayer?.isHost && (
            <button
              className={`btn btn--sm ${showTweak ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setShowTweak((v) => !v)}
              title="Send a mid-game adjustment to the AI"
            >
              🎛️ Adjust
            </button>
          )}
          {agreedRules && (
            <button
              className="btn btn--secondary btn--sm"
              onClick={() => setShowRules((v) => !v)}
            >
              {showRules ? 'Hide rules' : 'Rules'}
            </button>
          )}
        </div>
      </header>

      {showTweak && currentPlayer?.isHost && (
        <form className="tweak-bar" onSubmit={handleTweakSubmit}>
          <input
            className="tweak-bar__input"
            type="text"
            value={tweakInput}
            onChange={(e) => setTweakInput(e.target.value)}
            placeholder='e.g. "show question + answer together" or "+3 for correct, -1 for wrong"'
            autoFocus
            disabled={isAiThinking}
          />
          <button
            className="btn btn--primary btn--sm"
            type="submit"
            disabled={!tweakInput.trim() || isAiThinking}
          >
            Send
          </button>
        </form>
      )}

      {errorMessage && (
        <div className="alert alert--error alert--inline" onClick={clearError}>
          {errorMessage} <span className="alert__dismiss">✕</span>
        </div>
      )}

      {showRules && agreedRules && (
        <div className="rules-overlay" onClick={() => setShowRules(false)}>
          <div className="rules-panel" onClick={(e) => e.stopPropagation()}>
            <div className="rules-panel__header">
              <h3>Game Rules</h3>
              <button className="btn btn--secondary btn--sm" onClick={() => setShowRules(false)}>
                Close
              </button>
            </div>
            <pre className="rules-panel__body">{agreedRules}</pre>
          </div>
        </div>
      )}

      <div className="play-content">
        {isStuck && (
          <div className="stuck-banner">
            <span className="stuck-banner__msg">No action available.</span>
            <button className="btn btn--secondary btn--sm" onClick={handleStuckNudge}>
              Nudge AI →
            </button>
          </div>
        )}
        {currentUI.length === 0 && !isAiThinking ? (
          <div className="play-waiting">
            <p>Waiting for the game to start…</p>
          </div>
        ) : (
          <UIRenderer components={currentUI} />
        )}
      </div>

      {isFinished && (
        <div className="game-over-overlay">
          <div className="game-over-panel">
            <div className="game-over-panel__title">🏁 Game over</div>
            {endGameMessage && (
              <p className="game-over-panel__message">{endGameMessage}</p>
            )}
            {currentPlayer?.isHost ? (
              <>
                <button className="btn btn--primary" onClick={handlePlayAgain}>
                  Play again 🔄
                </button>
                <button className="btn btn--secondary" onClick={() => send({ type: 'full_reset' })}>
                  Back to lobby
                </button>
              </>
            ) : (
              <p className="game-over-panel__waiting">Waiting for the host…</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
