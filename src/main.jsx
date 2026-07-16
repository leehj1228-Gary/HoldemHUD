import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { GameProvider } from './state/GameContext.jsx';
import './index.css';

// ErrorBoundary가 GameProvider 바깥을 감싼다 — 프로바이더 자체의 useMemo
// (deriveHandState/computeAllStats over 영속 데이터)에서 던진 예외도 잡는다.
ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <ErrorBoundary>
            <GameProvider>
                <App />
            </GameProvider>
        </ErrorBoundary>
    </React.StrictMode>,
);
