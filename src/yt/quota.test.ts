/**
 * Tests for `QuotaCounter` / `QuotaExceededError`.
 *
 * Covers: consume within budget, the exact budget boundary, overshooting the
 * budget (and that the counter is left unchanged), and a custom constructor
 * budget.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaCounter, QuotaExceededError } from './quota.ts';

describe('QuotaCounter', () => {
  it('starts at zero with the default budget of 9500', () => {
    const counter = new QuotaCounter();
    assert.equal(counter.total, 0);
    assert.equal(counter.budget, 9500);
  });

  it('accumulates consumes within budget', () => {
    const counter = new QuotaCounter(100);
    counter.consume(40);
    counter.consume(50);
    assert.equal(counter.total, 90);
  });

  it('consumes exactly to the budget boundary', () => {
    const counter = new QuotaCounter(100);
    counter.consume(100);
    assert.equal(counter.total, 100);
    // Zero-width consume at the boundary is still allowed.
    counter.consume(0);
    assert.equal(counter.total, 100);
  });

  it('throws when a consume crosses the budget and does not increment', () => {
    const counter = new QuotaCounter(100);
    counter.consume(80);
    assert.throws(() => counter.consume(21), QuotaExceededError);
    assert.equal(counter.total, 80);
  });

  it('sets name on QuotaExceededError', () => {
    const counter = new QuotaCounter(10);
    let caught: unknown;
    try {
      counter.consume(11);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof QuotaExceededError);
    assert.equal(caught.name, 'QuotaExceededError');
  });

  it('honours a custom budget', () => {
    const counter = new QuotaCounter(3);
    counter.consume(3);
    assert.equal(counter.total, 3);
    assert.throws(() => counter.consume(1), QuotaExceededError);
  });

  it('throws immediately when a single consume exceeds the default budget', () => {
    const counter = new QuotaCounter();
    assert.throws(() => counter.consume(9501), QuotaExceededError);
    assert.equal(counter.total, 0);
  });
});
