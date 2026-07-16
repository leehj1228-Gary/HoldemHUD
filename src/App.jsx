// 5-way 화면 스위치 (docs/REBUILD_DESIGN.md §6) — ErrorBoundary로 감싼다.
import React from 'react';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { useGame } from './state/GameContext.jsx';
import HomeScreen from './components/screens/HomeScreen.jsx';
import GameScreen from './components/screens/GameScreen.jsx';
import HistoryScreen from './components/screens/HistoryScreen.jsx';
import ProfileScreen from './components/screens/ProfileScreen.jsx';
import AICoachScreen from './components/screens/AICoachScreen.jsx';

const SCREEN_COMPONENTS = {
    home: HomeScreen,
    game: GameScreen,
    history: HistoryScreen,
    profile: ProfileScreen,
    coach: AICoachScreen,
};

function CurrentScreen() {
    const { screen } = useGame();
    const Screen = SCREEN_COMPONENTS[screen] || HomeScreen;
    return (
        <div className="app-container">
            <Screen />
        </div>
    );
}

export default function App() {
    return (
        <ErrorBoundary>
            <CurrentScreen />
        </ErrorBoundary>
    );
}
