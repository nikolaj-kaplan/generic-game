import { useEffect, useState } from 'react';
import { useGame, useCurrentPlayer } from '../context/GameContext';
import UIRenderer from '../components/UIRenderer';
import { saveGame, titleFromRules } from '../data/savedGames';
import { useConfirm } from '../components/ConfirmDialog';

const INTERACTIVE_UI_TYPES = new Set(['button', 'input', 'multiple_choice', 'form']);

export default function Play() {
  const {
    currentUI,
    isAiThinking,
    agreedRules,
    errorMessage,
    clearError,
    send,
    sessionStatus,
    endGameMessage,
    turnStatus,
    gameError,
    currentTurn,
    screenVersion,
    toast,
    playerRange,
    leaveSession,
    paused,
    patchProposal,
    program,
  } = useGame();
  const [savedTitle, setSavedTitle] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();
  const currentPlayer = useCurrentPlayer();
  const [showRules, setShowRules] = useState(false);
  const [showTweak, setShowTweak] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [tweakInput, setTweakInput] = useState('');
  const isFinished = sessionStatus === 'finished';
  // Stuck = a real turn screen (not an intro slide) where nobody can act, for a while.
  const looksStuck =
    !isFinished &&
    !isAiThinking &&
    !gameError &&
    currentTurn !== null &&
    currentUI.length > 0 &&
    !currentUI.some((c) => INTERACTIVE_UI_TYPES.has(c.type) || c.type === 'countdown') &&
    !(turnStatus && turnStatus.waitingFor.length > 0);
  const [isStuck, setIsStuck] = useState(false);
  useEffect(() => {
    setIsStuck(false);
    if (!looksStuck) return;
    const id = setTimeout(() => setIsStuck(true), 10_000);
    return () => clearTimeout(id);
  }, [looksStuck, screenVersion]);

  function handleRetry() {
    send({ type: 'retry_turn' });
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
    <div className="page page--play">
      {dialog}
      {toast && (
        <div key={toast.id} className="toast" role="status">
          {toast.text}
        </div>
      )}
      <header className="play-header">
        <span className="play-header__title">
          🎮 Game
          {isAiThinking && <span className="thinking-pill">Thinking…</span>}
        </span>
        <div className="play-header__actions">
          {agreedRules && (
            <button className="btn btn--secondary btn--sm" onClick={() => setShowRules((v) => !v)}>
              Rules
            </button>
          )}
          {!currentPlayer?.isHost && (
            <button className="btn btn--secondary btn--sm" onClick={() => ask('Leave this game?', leaveSession, 'Leave')}>
              Leave
            </button>
          )}
          {currentPlayer?.isHost && (
            <div className="menu">
              <button
                className="btn btn--secondary btn--sm btn--icon"
                onClick={() => setShowMenu((v) => !v)}
                aria-label="Host options"
                aria-expanded={showMenu}
              >
                •••
              </button>
              {showMenu && (
                <>
                  <div className="menu__scrim" onClick={() => setShowMenu(false)} />
                  <div className="menu__panel" role="menu">
                    <button
                      role="menuitem"
                      onClick={() => {
                        setShowTweak(true);
                        setShowMenu(false);
                      }}
                    >
                      🎛️ Adjust the game
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setShowMenu(false);
                        handlePlayAgain();
                      }}
                    >
                      🔄 Restart with same rules
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setShowMenu(false);
                        send({ type: 'full_reset' });
                      }}
                    >
                      Back to waiting room
                    </button>
                    <button
                      role="menuitem"
                      className="menu__danger"
                      onClick={() => {
                        setShowMenu(false);
                        ask('Leave this game?', leaveSession, 'Leave');
                      }}
                    >
                      Leave game
                    </button>
                  </div>
                </>
              )}
            </div>
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
          <button className="btn btn--secondary btn--sm" type="button" onClick={() => setShowTweak(false)}>
            Cancel
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

      {patchProposal && currentPlayer?.isHost && (
        <div className="patch-panel" role="dialog" aria-label="Proposed change">
          <p className="patch-panel__title">Proposed change</p>
          <p className="patch-panel__summary">{patchProposal.summary}</p>
          {patchProposal.assumptions.length > 0 && (
            <ul className="patch-panel__notes">
              {patchProposal.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
          <div className="patch-panel__actions">
            <button className="btn btn--primary btn--sm" onClick={() => send({ type: 'patch_decision', id: patchProposal.id, apply: true })}>
              Apply
            </button>
            <button className="btn btn--secondary btn--sm" onClick={() => send({ type: 'patch_decision', id: patchProposal.id, apply: false })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {paused && <div className="paused-banner" role="status">{paused}</div>}

      <div className={`play-content${isFinished ? ' play-content--finished' : ''}${paused ? ' play-content--paused' : ''}`}>
        {gameError && !isAiThinking && (
          <div className="stuck-banner">
            <span className="stuck-banner__msg">{gameError}</span>
            <button className="btn btn--primary btn--sm" onClick={handleRetry}>
              Retry
            </button>
          </div>
        )}
        {isStuck && currentPlayer?.isHost && (
          <div className="stuck-banner">
            <span className="stuck-banner__msg">Nobody can act on this screen.</span>
            <button className="btn btn--secondary btn--sm" onClick={handleRetry}>
              Nudge AI →
            </button>
          </div>
        )}
        {turnStatus && turnStatus.waitingFor.length > 0 && !isFinished && (
          <p className="turn-status">
            <span>
              Waiting for {turnStatus.waitingFor.join(', ')}
              {turnStatus.answered.length > 0 && ` · answered: ${turnStatus.answered.join(', ')}`}
            </span>
          </p>
        )}
        {currentUI.length === 0 ? (
          <div className="play-waiting">
            {isAiThinking ? (
              <p className="play-waiting__busy">Setting up the game…</p>
            ) : (
              <p>Waiting for the game to start…</p>
            )}
          </div>
        ) : (
          <UIRenderer key={screenVersion} components={currentUI} />
        )}
      </div>

      {/* Docked at the bottom so the final results stay readable above it */}
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
                <button className="btn btn--secondary" onClick={() => setShowTweak(true)}>
                  🎛️ Adjust (e.g. add a final screen)
                </button>
                {agreedRules && (
                  <button
                    className="btn btn--secondary"
                    disabled={savedTitle !== null}
                    onClick={() => setSavedTitle(saveGame(agreedRules, playerRange ?? undefined, program).title)}
                  >
                    {savedTitle ? `💾 Saved as “${savedTitle}”` : `💾 Save “${titleFromRules(agreedRules)}” for next time`}
                  </button>
                )}
                <button className="btn btn--secondary" onClick={() => send({ type: 'full_reset' })}>
                  Back to waiting room
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
