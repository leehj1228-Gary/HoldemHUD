// 최소 preload 스크립트 (docs/REBUILD_DESIGN.md §8)
// 이 앱은 렌더러에서 Node API를 사용하지 않으므로 contextBridge 스텁만 노출한다.
// 참고: Electron preload는 .js 확장자면 package.json의 "type": "module"과 무관하게
// 항상 CommonJS로 로드된다 → require 사용.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('holdemHud', {
    platform: 'electron',
});
