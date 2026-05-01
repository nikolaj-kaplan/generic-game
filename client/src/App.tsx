import { useEffect } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { useGame } from './context/GameContext';
import Home from './pages/Home';
import Lobby from './pages/Lobby';
import Define from './pages/Define';
import Play from './pages/Play';

export default function App() {
  const { sessionStatus } = useGame();
  const navigate = useNavigate();

  // Automatically navigate when session status changes
  useEffect(() => {
    if (!sessionStatus) {
      navigate('/');
    } else if (sessionStatus === 'lobby') {
      navigate('/lobby');
    } else if (sessionStatus === 'defining') {
      navigate('/define');
    } else if (sessionStatus === 'playing' || sessionStatus === 'finished') {
      navigate('/play');
    }
  }, [sessionStatus, navigate]);

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/lobby" element={<Lobby />} />
      <Route path="/define" element={<Define />} />
      <Route path="/play" element={<Play />} />
    </Routes>
  );
}
