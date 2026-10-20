import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAndDedupeLeads } from './scheduler.js';
import {
  getHourWindowIndex,
  getWindowStartTime,
  getNextWindowStartTime,
  calculateScheduleEstimate,
  ONE_HOUR_MS,
} from '../lib/time.js';

test('Lead sanitization and deduplication', () => {
  const raw = [
    '  John.Doe@Example.COM ',
    'alice@acme.org',
    'invalid-email-address',
    'john.doe@example.com', // duplicate
    'bob@reachinbox.ai',
    '   ',
    'not_an_email@',
  ];

  const result = sanitizeAndDedupeLeads(raw);

  assert.equal(result.accepted.length, 3);
  assert.deepEqual(result.accepted, [
    'john.doe@example.com',
    'alice@acme.org',
    'bob@reachinbox.ai',
  ]);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0], 'john.doe@example.com');
  assert.equal(result.invalid.length, 2);
  assert.ok(result.invalid.includes('invalid-email-address'));
  assert.ok(result.invalid.includes('not_an_email@'));
});

test('Time window calculations', () => {
  const fixedTime = 1700000000000; // specific timestamp ms
  const windowIndex = getHourWindowIndex(fixedTime);
  const windowStart = getWindowStartTime(windowIndex);
  const nextWindowStart = getNextWindowStartTime(fixedTime);

  assert.equal(windowStart, windowIndex * ONE_HOUR_MS);
  assert.equal(nextWindowStart, (windowIndex + 1) * ONE_HOUR_MS);
  assert.equal(nextWindowStart - windowStart, ONE_HOUR_MS);
  assert.ok(fixedTime >= windowStart && fixedTime < nextWindowStart);
});

test('Schedule estimation calculations', () => {
  // 100 leads, 2s delay, 45 emails/hr limit per sender, 3 active senders
  const estimate = calculateScheduleEstimate(100, 2, 45, 3);

  assert.equal(estimate.activeSenders, 3);
  assert.equal(estimate.effectiveDelaySec, 2);
  assert.equal(estimate.effectiveHourlyLimit, 45);
  // Cluster capacity = 3 * 45 = 135 emails/hr
  // 100 leads fits within 1 window (135 capacity)
  assert.equal(estimate.totalWindows, 1);
  assert.equal(estimate.overflowsHourlyLimit, false);

  // 300 leads exceeds 135 capacity -> 3 windows
  const largeEstimate = calculateScheduleEstimate(300, 2, 45, 3);
  assert.equal(largeEstimate.totalWindows, 3);
  assert.equal(largeEstimate.overflowsHourlyLimit, true);
});

test('Worker metrics bottleneck diagnostics', async () => {
  const { diagnoseWorkerMetrics } = await import('../lib/time.js');

  const healthy = diagnoseWorkerMetrics(140, 0, 5);
  assert.equal(healthy.systemStatus, 'HEALTHY');
  assert.equal(healthy.isBottleneck, false);

  const degraded = diagnoseWorkerMetrics(280, 0.5, 5);
  assert.equal(degraded.systemStatus, 'DEGRADED');
  assert.equal(degraded.isBottleneck, false);

  const bottleneckHighLatency = diagnoseWorkerMetrics(420, 0, 5);
  assert.equal(bottleneckHighLatency.systemStatus, 'BOTTLENECK');
  assert.equal(bottleneckHighLatency.isBottleneck, true);

  const bottleneckHighFailures = diagnoseWorkerMetrics(150, 8.5, 5);
  assert.equal(bottleneckHighFailures.systemStatus, 'BOTTLENECK');
  assert.equal(bottleneckHighFailures.isBottleneck, true);
});

test('Batch retry filtering and payload validation', async () => {
  const { filterRetryableEmailIds, validateBatchRetryPayload } = await import('./scheduler.js');

  const emails = [
    { id: '1', status: 'SENT' },
    { id: '2', status: 'FAILED' },
    { id: '3', status: 'SCHEDULED' },
    { id: '4', status: 'FAILED' },
    { id: '5', status: 'CANCELLED' },
  ];

  const retryable = filterRetryableEmailIds(emails);
  assert.deepEqual(retryable, ['2', '4', '5']);

  const valid = validateBatchRetryPayload(['id_1', 'id_2', 'id_1']);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.cleanIds, ['id_1', 'id_2']);

  const invalidEmpty = validateBatchRetryPayload([]);
  assert.equal(invalidEmpty.valid, false);

  const invalidNull = validateBatchRetryPayload(null);
  assert.equal(invalidNull.valid, false);
});

test('Email template dynamic {{email}} interpolation', async () => {
  const { renderEmailTemplate, detectTemplateTags } = await import('../lib/template.js');

  const template = 'Hello {{email}}, welcome! Reach us back at {{ email }}.';
  const rendered = renderEmailTemplate(template, 'alex@company.org');
  assert.equal(rendered, 'Hello alex@company.org, welcome! Reach us back at alex@company.org.');

  const tags = detectTemplateTags(template);
  assert.equal(tags.hasEmailTag, true);
  assert.equal(tags.tagCount, 2);

  const noTags = detectTemplateTags('Plain subject line without tags');
  assert.equal(noTags.hasEmailTag, false);
  assert.equal(noTags.tagCount, 0);

  // Fallback when empty recipient is passed
  const fallbackRender = renderEmailTemplate('Hi {{email}}', '');
  assert.equal(fallbackRender, 'Hi lead@example.com');
});

test('Email template dynamic {{name}}, {{company}}, and {{jobTitle}} variables', async () => {
  const { renderEmailTemplate, detectTemplateTags, inferLeadVariables } = await import('../lib/template.js');

  // Test inference from email address
  const inferred = inferLeadVariables('sarah.jenkins@stripe.com');
  assert.equal(inferred.name, 'Sarah Jenkins');
  assert.equal(inferred.company, 'Stripe');
  assert.equal(inferred.jobTitle, 'Team Lead');

  // Test multi-tag interpolation with inferred variables
  const template = 'Hi {{name}}, hope all is well at {{company}}! As {{jobTitle}}, we thought you would appreciate our outreach to {{email}}.';
  const rendered = renderEmailTemplate(template, 'alex.smith@hubspot.com');
  assert.equal(
    rendered,
    'Hi Alex Smith, hope all is well at HubSpot! As Team Lead, we thought you would appreciate our outreach to alex.smith@hubspot.com.'
  );

  // Test explicit variables override
  const customRendered = renderEmailTemplate('Hey {{name}} ({{jobTitle}} at {{company}})', {
    email: 'custom@acme.inc',
    name: 'Alice Cooper',
    company: 'Acme Corp',
    jobTitle: 'Head of Engineering',
  });
  assert.equal(customRendered, 'Hey Alice Cooper (Head of Engineering at Acme Corp)');

  // Test tag detection
  const tagInfo = detectTemplateTags(template);
  assert.equal(tagInfo.hasTags, true);
  assert.equal(tagInfo.hasNameTag, true);
  assert.equal(tagInfo.hasCompanyTag, true);
  assert.equal(tagInfo.hasJobTitleTag, true);
  assert.equal(tagInfo.hasEmailTag, true);
  assert.equal(tagInfo.tagCount, 4);
});

test('24-hour delivery stability sparkline calculations', async () => {
  const { computeDeliveryStabilitySeries, build24hDeliveryBuckets } = await import('../lib/sparkline.js');

  const now = Date.now();
  const buckets = build24hDeliveryBuckets(now, [
    { status: 'SENT', sentAt: now - 10_000 },
    { status: 'SENT', sentAt: now - 20_000 },
    { status: 'SENT', sentAt: now - 30_000 },
    { status: 'FAILED', failedAt: now - 15_000 },
  ]);

  assert.equal(buckets.length, 24);
  const currentBucket = buckets[23];
  assert.equal(currentBucket.sent, 3);
  assert.equal(currentBucket.failed, 1);
  assert.equal(currentBucket.stabilityPct, 75.0);

  const series = computeDeliveryStabilitySeries(buckets, 116, 32);
  assert.equal(series.points.length, 24);
  assert.ok(series.polylinePoints.length > 10);
  assert.ok(series.areaPath.startsWith('M '));
  assert.equal(series.points[23].hasFailure, true);
  assert.ok(series.overallStabilityPct > 90 && series.overallStabilityPct <= 100);
});





