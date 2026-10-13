import { useGame, useCurrentPlayer } from '../context/GameContext';
import InviteCard from '../components/InviteCard';

export default function Lobby() {
  const { session, send, errorMessage, clearError, leaveSession } = useGame();
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

        <InviteCard joinCode={session.joinCode} players={session.players.map((p) => p.name)} />

        <p className="text-muted">
          {isHost
            ? 'You can define the game now. Friends can join any time, also while you define it, and help in the chat.'
            : 'Waiting for the host. You can help define the game once it starts.'}
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
            Define the game
          </button>
        )}

        {!isHost && (
          <p className="text-muted text-center">
            Waiting for the host to start…
          </p>
        )}

        <button className="btn btn--secondary btn--full lobby-leave" onClick={leaveSession}>
          Leave
        </button>
      </div>
    </div>
  );
}
