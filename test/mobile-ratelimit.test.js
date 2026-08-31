import test from 'node:test';
import assert from 'node:assert/strict';

import { createLimiter } from '../src/mobile/ratelimit.js';

test('fixed window: allows max hits, limits the next, resets after the window', () => {
  const limiter = createLimiter({ windowMs: 1000, max: 3 });
  assert.equal(limiter.hit('a', 0).limited, false);
  assert.equal(limiter.hit('a', 1).limited, false);
  assert.equal(limiter.hit('a', 2).limited, false);
  const over = limiter.hit('a', 3);
  assert.equal(over.limited, true);
  assert.equal(over.retryAfterMs, 997);
  assert.equal(limiter.hit('b', 3).limited, false);
  assert.equal(limiter.hit('a', 1000).limited, false);
});
