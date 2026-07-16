// Electron 메인 프로세스 (docs/REBUILD_DESIGN.md §8)
// package.json이 "type": "module"이므로 이 파일은 ESM으로 작성한다 (Electron 28+ 지원).
// 렌더러는 Node API가 전혀 필요 없다 → contextIsolation:true, nodeIntegration:false.
/* global process */ // eslint 플랫 설정이 browser globals만 제공 — 메인 프로세스는 Node 환경
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 메인 브라우저 윈도우를 생성한다.
 * - ELECTRON_START_URL 환경변수가 있으면 그 URL을 로드하고,
 * - 없고 패키징 전(!app.isPackaged, electron:dev)이면 Vite dev 서버를 로드하며,
 * - 패키징된 앱에서는 빌드 산출물(dist/index.html)을 파일로 로드한다.
 * - 아이콘은 실제 파일이 존재할 때만 참조한다.
 */
function createWindow() {
    /** @type {import('electron').BrowserWindowConstructorOptions} */
    const options = {
        width: 1280,
        height: 800,
        autoHideMenuBar: true, // 기본 메뉴바 숨김
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    };

    // 존재하지 않는 아이콘 파일 참조로 인한 경고 방지
    const iconPath = path.join(__dirname, '../public/icon.png');
    if (fs.existsSync(iconPath)) {
        options.icon = iconPath;
    }

    const mainWindow = new BrowserWindow(options);

    const startUrl = process.env.ELECTRON_START_URL;
    if (startUrl) {
        // 명시적 오버라이드 — 지정한 URL 로드
        mainWindow.loadURL(startUrl);
    } else if (!app.isPackaged) {
        // electron:dev — Vite dev 서버 로드 (stale dist/ 로드 방지)
        mainWindow.loadURL('http://localhost:5173');
    } else {
        // 프로덕션(패키징) — 로컬 빌드 산출물 로드
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // 디버깅 시: mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        // macOS: 독 아이콘 클릭 시 윈도우가 없으면 재생성
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
