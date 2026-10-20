import test from 'node:test';
import assert from 'node:assert/strict';
import { executeReserveSlot, loadReserveSlotScript } from '../redis-scripts/loader.js';
import { redisClient } from '../lib/redis.js';
import { ONE_HOUR_MS } from '../lib/time.js';

test('Atomic slot reservation respects minDelay and enforces hourly limit under concurrent workers', async () => {
  const testSender = `test_sender_conc_${Date.now()}`;
  const now = 1700000000000; // aligned deterministic base timestamp
  const minDelayMs = 2000;
  const hourlyLimit = 5;

  await loadReserveSlotScript();

  // Simulate 7 simultaneous worker reservations for the same sender
  const promises = [];
  for (let i = 0; i < 7; i++) {
    promises.push(executeReserveSlot(testSender, now, minDelayMs, hourlyLimit));
  }

  const results = await Promise.all(promises);
  const timestamps = results.map((r) => r.targetTs).sort((a, b) => a - b);

  // 1. All reservations succeed without dropping any job
  assert.ok(timestamps.every((t) => t > 0));

  // 2. First 5 slots are in the initial hour window and spaced by at least minDelayMs (2000ms)
  for (let i = 1; i < 5; i++) {
    assert.ok(
      timestamps[i] - timestamps[i - 1] >= minDelayMs,
      `Slot ${i} (${timestamps[i]}) must be >= ${minDelayMs}ms after slot ${i - 1} (${timestamps[i - 1]})`
    );
  }

  // 3. Slots 6 and 7 overflow into the next hour window and are also spaced by minDelayMs
  const initialWindow = Math.floor(now / ONE_HOUR_MS);
  const nextWindowStart = (initialWindow + 1) * ONE_HOUR_MS;
  assert.equal(timestamps[5], nextWindowStart);
  assert.equal(timestamps[6], nextWindowStart + minDelayMs);

  // 4. Verify limitHit was flagged on the overflow reservations
  const limitHitResults = results.filter((r) => r.limitHit);
  assert.equal(limitHitResults.length, 2);

  await redisClient.del(`slot:{${testSender}}`);
});

test('Multiple independent senders reserve slots concurrently without cross-sender contention', async () => {
  const senderA = `sender_a_${Date.now()}`;
  const senderB = `sender_b_${Date.now()}`;
  const now = 1700003600000;
  const minDelayMs = 3000;
  const hourlyLimit = 10;

  const [resA1, resB1, resA2, resB2] = await Promise.all([
    executeReserveSlot(senderA, now, minDelayMs, hourlyLimit),
    executeReserveSlot(senderB, now, minDelayMs, hourlyLimit),
    executeReserveSlot(senderA, now, minDelayMs, hourlyLimit),
    executeReserveSlot(senderB, now, minDelayMs, hourlyLimit),
  ]);

  // Both Sender A and Sender B get immediate first slot at `now` and second slot at `now + 3000`
  assert.equal(resA1.targetTs, now);
  assert.equal(resB1.targetTs, now);
  assert.equal(resA2.targetTs, now + minDelayMs);
  assert.equal(resB2.targetTs, now + minDelayMs);
});

test('Lookahead exhaustion returns targetTs = -1 when all lookahead windows are full', async () => {
  const senderExhaust = `sender_exhaust_${Date.now()}`;
  const now = 1700007200000;
  const minDelayMs = 1000;
  const hourlyLimit = 2;
  const maxLookahead = 1; // only current window + 1 lookahead window = max 4 emails

  const r1 = await executeReserveSlot(senderExhaust, now, minDelayMs, hourlyLimit, maxLookahead);
  const r2 = await executeReserveSlot(senderExhaust, now, minDelayMs, hourlyLimit, maxLookahead);
  const r3 = await executeReserveSlot(senderExhaust, now, minDelayMs, hourlyLimit, maxLookahead);
  const r4 = await executeReserveSlot(senderExhaust, now, minDelayMs, hourlyLimit, maxLookahead);
  const r5 = await executeReserveSlot(senderExhaust, now, minDelayMs, hourlyLimit, maxLookahead);

  assert.ok(r1.targetTs > 0);
  assert.ok(r2.targetTs > 0);
  assert.ok(r3.targetTs > 0);
  assert.ok(r4.targetTs > 0);
  assert.equal(r5.targetTs, -1);
  assert.equal(r5.limitHit, true);

  await redisClient.quit();
});
