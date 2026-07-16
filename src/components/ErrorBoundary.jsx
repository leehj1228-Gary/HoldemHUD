import React from 'react';

/**
 * 렌더링 중 발생한 예외를 잡아 앱 전체 크래시를 막는 에러 경계 (docs/REBUILD_DESIGN.md §8 — E4).
 * 에러 발생 시 앱 다크 테마와 맞춘 폴백 UI를 보여주고, "다시 시작" 버튼으로 리로드한다.
 */
export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        // 콘솔 로깅 — 디버깅용 (componentStack 포함)
        console.error('[ErrorBoundary] 렌더링 오류:', error, info);
    }

    render() {
        if (this.state.error) {
            const message =
                (this.state.error && this.state.error.message) || String(this.state.error);
            return (
                <div
                    style={{
                        minHeight: '100vh',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '24px',
                        background: 'linear-gradient(135deg, #2c3e50 0%, #000000 100%)',
                        color: '#ecf0f1',
                        textAlign: 'center',
                    }}
                >
                    <h1 style={{ marginBottom: '16px' }}>문제가 발생했습니다</h1>
                    <pre
                        style={{
                            maxWidth: '90%',
                            overflowX: 'auto',
                            background: '#34495e',
                            color: '#e74c3c',
                            padding: '12px 16px',
                            borderRadius: '8px',
                            fontSize: '0.85rem',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                        }}
                    >
                        {message}
                    </pre>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            marginTop: '20px',
                            padding: '12px 28px',
                            fontSize: '1rem',
                            fontWeight: 'bold',
                            color: '#fff',
                            background: 'linear-gradient(to right, #27ae60, #2ecc71)',
                            border: 'none',
                            borderRadius: '8px',
                            cursor: 'pointer',
                        }}
                    >
                        다시 시작
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
