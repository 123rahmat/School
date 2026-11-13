import assert from 'node:assert/strict';
import { addDays, addMonths } from '../src/date.ts';

assert.equal(addDays('2026-01-31', 1), '2026-02-01');
assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
assert.equal(addMonths('2026-01-30', 1), '2026-02-28');
assert.equal(addMonths('2026-04-30', 1), '2026-05-30');
assert.equal(addMonths('2026-02-28', 12), '2027-02-28');
assert.equal(addMonths('2028-02-29', 12), '2029-02-28');
assert.equal(addMonths('2026-10-31', 4), '2027-02-28');
assert.throws(() => addMonths('not-a-date', 1), RangeError);
assert.throws(() => addMonths('2026-01-01', 1.5), RangeError);

console.log('Calendar date tests passed.');
