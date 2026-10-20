// The brake after the platform says 412.
//
// A cooldown that lives only in memory dies with the process, and a restart walks
// straight back into the ban. These assertions are about surviving a restart and
// about not staying shut forever after one bad answer.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite } from './helpers.mjs';
import { createCooldown } from '../lib/cooldown.js';

const t = suite('cooldown');
const dir = mkdtempSync(join(tmpdir(), 'social-cooldown-'));

// --- the open window ---------------------------------------------------------
{
  const file = join(dir, 'cold.json');
  const brake = createCooldown({ path: file, cooldownMs: 60_000 });
  t.check(!brake.active(), 'a missing file is an open window');
  t.check(brake.until() === 0, 'with no deadline');
}

// --- tripping it -------------------------------------------------------------
{
  const file = join(dir, 'trip.json');
  let clock = 1_000_000;
  const brake = createCooldown({ path: file, cooldownMs: 60_000, now: () => clock });
  const until = brake.trip('HTTP 412');
  t.check(until === 1_060_000, `the deadline is now plus the window (got ${until})`);
  t.check(brake.active(), 'and the window is shut');
  clock += 30_000;
  t.check(brake.active(), 'still shut halfway through');
  clock += 30_000;
  t.check(!brake.active(), 'and open again at the deadline');
}

// --- surviving a restart -----------------------------------------------------
{
  const file = join(dir, 'restart.json');
  let clock = 2_000_000;
  const first = createCooldown({ path: file, cooldownMs: 60_000, now: () => clock });
  first.trip('HTTP 412');

  const second = createCooldown({ path: file, cooldownMs: 60_000, now: () => clock });
  t.check(second.active(), 'a new process still sees the closed window');
  t.check(second.until() === 2_060_000, 'with the stored deadline');

  clock = 2_061_000;
  const third = createCooldown({ path: file, cooldownMs: 60_000, now: () => clock });
  t.check(!third.active(), 'and an expired deadline is not restored as active');
}

// --- clearing ----------------------------------------------------------------
{
  const file = join(dir, 'clear.json');
  const brake = createCooldown({ path: file, cooldownMs: 60_000 });
  brake.trip('HTTP 412');
  brake.clear();
  t.check(!brake.active(), 'clear opens the window immediately');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  t.check(raw.until === 0, 'and the file says so');
}

// --- a corrupt file ----------------------------------------------------------
{
  const file = join(dir, 'corrupt.json');
  writeFileSync(file, '{"until": "soon"', 'utf8');
  const brake = createCooldown({ path: file, cooldownMs: 60_000 });
  t.check(!brake.active(), 'a corrupt file is a cold start, not a permanent ban');
}

{
  // A deadline in the past must not silence searches after a clock change.
  const file = join(dir, 'past.json');
  writeFileSync(file, JSON.stringify({ version: 1, until: 1000 }), 'utf8');
  const brake = createCooldown({ path: file, cooldownMs: 60_000 });
  t.check(!brake.active(), 'a stale deadline is ignored');
}

// --- no path -----------------------------------------------------------------
{
  const brake = createCooldown({ path: '', cooldownMs: 60_000 });
  brake.trip('HTTP 412');
  t.check(brake.active(), 'a pathless cooldown still works in memory');
  brake.clear();
  t.check(!brake.active(), 'and still clears');
}

rmSync(dir, { recursive: true, force: true });
t.done();