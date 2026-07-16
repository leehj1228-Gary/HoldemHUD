// vitest 전용 설정 (docs/REBUILD_DESIGN.md §8 — vite.config.js는 건드리지 않음)
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.js'],
    },
});
