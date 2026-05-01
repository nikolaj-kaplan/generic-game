import { useGame, useCurrentPlayer } from '../context/GameContext';

export default function Lobby() {
  const { session, send, errorMessage, clearError } = useGame();
  const currentPlayer = useCurrentPlayer();

  if (!session) return null;

  const isHost = currentPlayer?.isHost ?? false;

  return (
    <div className="page page--center">
      <div className="card card--narrow">
        <div className="lobby-header">
          <h2 className="lobby-header__title">Waiting room</h2>
          <div className="join-code">
            <span className="join-code__label">Join code</span>
            <span className="join-code__value">{session.joinCode}</span>
          </div>
        </div>

        <p className="text-muted">
          Share the code above with your friends. Once everyone has joined, the host starts the game.
        </p>

        {errorMessage && (
          <div className="alert alert--error" onClick={clearError}>
            {errorMessage} <span className="alert__dismiss">✕</span>
          </div>
        )}

        <div className="player-list">
          <p className="player-list__heading">
            Players ({session.players.length})
          </p>
          {session.players.map((player) => (
            <div key={player.id} className="player-list__item">
              <span className="player-list__name">
                {player.name}
                {player.id === currentPlayer?.id && (
                  <span className="player-list__you"> (you)</span>
                )}
              </span>
              {player.isHost && <span className="badge badge--host">host</span>}
            </div>
          ))}
        </div>

        {isHost && (
          <button
            className="btn btn--primary btn--full"
            onClick={() => send({ type: 'start_defining' })}
            disabled={session.players.length < 1}
          >
            Start — define the game
          </button>
        )}

        {!isHost && (
          <p className="text-muted text-center">
            Waiting for the host to start…
          </p>
        )}
      </div>
    </div>
  );
}
