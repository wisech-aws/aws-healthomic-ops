import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/enrichment/rateLimiter.js';

/**
 * A deterministic clock + sleep pair: `sleep(ms)` advances the virtual clock so
 * the limiter's timing math is exercised without real timers.
 */
function fakeClock() {
  let nowMs = 0;
  const now = () => nowMs;
  const sleep = async (ms: number) => {
    nowMs += ms;
  };
  const advance = (ms: number) => {
    nowMs += ms;
  };
  return { now, sleep, advance };
}

describe('RateLimiter — token-bucket pacing', () => {
  it('paces N immediate acquires at 1000/rate ms spacing', async () => {
    const clock = fakeClock();
    // 10 TPS => 100ms between grants.
    const limiter = new RateLimiter(10, clock.now, clock.sleep);
    const grantTimes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await limiter.acquire();
      grantTimes.push(clock.now());
    }
    // First is immediate; each subsequent is 100ms after the previous.
    expect(grantTimes).toEqual([0, 100, 200, 300, 400]);
  });

  it('does not wait when calls are already spaced beyond the interval', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(10, clock.now, clock.sleep);
    await limiter.acquire(); // t=0
    clock.advance(500); // caller idle 500ms (> 100ms interval)
    const before = clock.now();
    await limiter.acquire();
    // No additional sleep needed — the slot was already available.
    expect(clock.now()).toBe(before);
  });

  it('rejects a non-positive rate', () => {
    expect(() => new RateLimiter(0)).toThrow();
    expect(() => new RateLimiter(-1)).toThrow();
  });

  it('respects a custom rate (2 TPS => 500ms spacing)', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, clock.now, clock.sleep);
    const t: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await limiter.acquire();
      t.push(clock.now());
    }
    expect(t).toEqual([0, 500, 1000]);
  });
});
