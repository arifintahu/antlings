import { expect, it } from 'vitest';
import { APP_NAME } from './index.js';
it('exports the app name', () => expect(APP_NAME).toBe('antlings'));
