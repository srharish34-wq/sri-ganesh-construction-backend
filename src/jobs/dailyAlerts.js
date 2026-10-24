import { runAllAlerts } from '../services/alert.service.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let timer = null;
let running = false;

// Milliseconds from now until the next HH:00 in Indian time
function msUntilNext(hourIST) {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  let target = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(), hourIST, 0, 0);
  if (target <= nowIst.getTime()) target += DAY_MS;
  return target - nowIst.getTime();
}

// Safe to call by hand. A second call while one is running is skipped.
export async function runAlertsNow() {
  if (running) return { skipped: true };
  running = true;
  try {
    const result = await runAllAlerts();
    console.log('🔔 Daily alerts finished:', JSON.stringify(result));
    return result;
  } catch (err) {
    console.error('⚠️ Daily alerts failed:', err.message);
    return { error: err.message };
  } finally {
    running = false;
  }
}

/*
  Starts the schedule. Repeats are harmless: every alert has a dedupe key, so
  running twice in a day (or on two servers) never sends the same alert twice.
  runOnStart checks shortly after the server boots, which helps on free hosting
  where the server may be asleep at 8 AM.
*/
export function startDailyAlerts({ hourIST = 8, runOnStart = false } = {}) {
  if (timer) return;

  const schedule = () => {
    timer = setTimeout(async () => {
      await runAlertsNow();
      schedule(); // recalculated each time, so it never drifts
    }, msUntilNext(hourIST));
    timer.unref(); // does not keep the process alive on shutdown
  };

  schedule();
  if (runOnStart) setTimeout(runAlertsNow, 10 * 1000).unref();
  console.log(`🔔 Daily alerts scheduled for ${String(hourIST).padStart(2, '0')}:00 IST`);
}

export function stopDailyAlerts() {
  if (timer) clearTimeout(timer);
  timer = null;
}