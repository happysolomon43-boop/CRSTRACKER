// ═══════════════════════════════════════════════════════════════
//  CRS TRACKER — BACKEND  (index.js)
//  Deploy on Railway. Set these env vars in Railway's Variables tab:
//
//    FIREBASE_PROJECT_ID      from your service account JSON
//    FIREBASE_CLIENT_EMAIL    from your service account JSON
//    FIREBASE_PRIVATE_KEY     from your service account JSON
//    TELEGRAM_BOT_TOKEN       from @BotFather on Telegram
//    TELEGRAM_CHAT_ID         your personal Telegram chat ID
// ═══════════════════════════════════════════════════════════════

const express   = require('express');
const admin     = require('firebase-admin');
const cron      = require('node-cron');

// ───────────────────────────────────────────
//  FIREBASE INIT
// ───────────────────────────────────────────

// Railway stores the private key as an env var. The key sometimes
// comes with literal \n instead of real newlines — this fixes that.
const privateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : undefined;

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
});

const db = admin.firestore();

// ───────────────────────────────────────────
//  CONSTANTS
// ───────────────────────────────────────────

// Single user app — fixed ID, no login needed.
const USER_ID    = 'crs_main';
const COLLECTION = 'crs_users';
const MAX_HISTORY = 100;

// ───────────────────────────────────────────
//  CRS MATH ENGINE
// ───────────────────────────────────────────

function profitTarget(bankroll) {
  return Math.round(bankroll * 0.05);
}

function calcStake(lossesAccumulated, pt) {
  return Math.round((lossesAccumulated + pt) / 0.7);
}

function defaultState(bankroll) {
  const pt = profitTarget(bankroll);
  return {
    initialBankroll:    bankroll,
    bankroll,
    round:              1,
    cycleNumber:        1,
    cycleStartBankroll: bankroll,
    profitTarget:       pt,
    lossesAccumulated:  0,
    currentStake:       calcStake(0, pt),
    totalCycles:        0,
    successfulCycles:   0,
    busts:              0,
    history:            [],
  };
}

function applyWin(state) {
  const s = JSON.parse(JSON.stringify(state));
  const dateLabel = watDateLabel();

  s.bankroll += s.profitTarget;
  s.successfulCycles++;
  s.totalCycles++;

  s.history.unshift({
    type:          'win',
    date:          dateLabel,
    cycle:         s.cycleNumber,
    round:         s.round,
    stake:         s.currentStake,
    profitTarget:  s.profitTarget,
    bankrollAfter: s.bankroll,
    desc:          `Cycle ${s.cycleNumber} — Round ${s.round} WIN`,
  });

  const event = { kind: 'win', round: s.round, cycleNumber: s.cycleNumber, profit: s.profitTarget, bankroll: s.bankroll };
  resetCycle(s);
  return { newState: s, event };
}

function applyLoss(state) {
  const s = JSON.parse(JSON.stringify(state));
  const dateLabel = watDateLabel();

  s.bankroll -= s.currentStake;
  s.lossesAccumulated += s.currentStake;

  s.history.unshift({
    type:          'loss',
    date:          dateLabel,
    cycle:         s.cycleNumber,
    round:         s.round,
    stake:         s.currentStake,
    bankrollAfter: s.bankroll,
    desc:          `Cycle ${s.cycleNumber} — Round ${s.round} LOSS`,
  });

  if (s.round === 3) {
    s.busts++;
    s.totalCycles++;
    const event = {
      kind:           'bust',
      lostTotal:      s.lossesAccumulated,
      bankroll:       s.bankroll,
      newProfitTarget: profitTarget(s.bankroll),
      newStake:       calcStake(0, profitTarget(s.bankroll)),
    };
    resetCycle(s);
    return { newState: s, event };
  } else {
    s.round++;
    s.currentStake = calcStake(s.lossesAccumulated, s.profitTarget);
    const event = { kind: 'loss', round: s.round, newStake: s.currentStake, lossesAccumulated: s.lossesAccumulated, bankroll: s.bankroll };
    return { newState: s, event };
  }
}

function resetCycle(s) {
  s.cycleNumber++;
  s.round               = 1;
  s.lossesAccumulated   = 0;
  s.cycleStartBankroll  = s.bankroll;
  s.profitTarget        = profitTarget(s.bankroll);
  s.currentStake        = calcStake(0, s.profitTarget);
}

// ───────────────────────────────────────────
//  FIRESTORE HELPERS
// ───────────────────────────────────────────

function todayWAT() {
  // WAT = UTC+1
  return new Date(Date.now() + 3600000).toISOString().slice(0, 10);
}

function watDateLabel() {
  return new Date(Date.now() + 3600000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

async function getState() {
  const doc = await db.collection(COLLECTION).doc(USER_ID).get();
  return doc.exists ? doc.data() : null;
}

async function saveState(state) {
  const data = {
    ...state,
    history:         (state.history || []).slice(0, MAX_HISTORY),
    lastCheckinDate: todayWAT(),
    updatedAt:       new Date().toISOString(),
  };
  await db.collection(COLLECTION).doc(USER_ID).set(data);
  return data;
}

async function recordNoGame() {
  const docRef = db.collection(COLLECTION).doc(USER_ID);
  const doc    = await docRef.get();
  if (!doc.exists) throw new Error('State not found. Init first.');

  const state = doc.data();
  const entry = {
    type:          'no_game',
    date:          watDateLabel(),
    cycle:         state.cycleNumber || 1,
    round:         state.round || 1,
    desc:          'No game today',
    bankrollAfter: state.bankroll,
  };

  const history = [entry, ...(state.history || [])].slice(0, MAX_HISTORY);
  const today   = todayWAT();

  await docRef.update({ history, lastCheckinDate: today, updatedAt: new Date().toISOString() });
  return { ...state, history, lastCheckinDate: today };
}

// ───────────────────────────────────────────
//  TELEGRAM
// ───────────────────────────────────────────

async function sendTelegram(text, chatId = null) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const target = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !target) { console.warn('[Telegram] Env vars not set.'); return false; }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: target, text, parse_mode: 'HTML' }),
  });

  const data = await res.json();
  if (!data.ok) { console.error('[Telegram] Error:', data.description); return false; }
  console.log(`[Telegram] Sent at ${new Date().toISOString()}`);
  return true;
}

function buildMessage(slot, checkedIn) {
  if (checkedIn) return null; // already logged today — stay quiet

  const messages = {
    morning1: `🌅 <b>CRS Morning Check-in</b>\n\nYou haven't logged today's result yet.\n\nOpen the tracker → record your bet result, or hit <b>No Game Today</b> if you're sitting this one out.\n\nStay disciplined. 💰`,
    morning2: `☕ <b>CRS Reminder</b>\n\nStill no check-in for today.\n\nLog your result or mark <b>No Game Today</b> before the day runs away from you. 📊`,
    midday:   `☀️ <b>CRS Midday Alert</b>\n\nHalfway through the day — still no activity logged.\n\nTake 10 seconds. Open the tracker. Done. ✅`,
    evening1: `🌆 <b>CRS Evening Check-in</b>\n\nNo log recorded today yet.\n\nIf you played, enter the result. If not, hit <b>No Game Today</b>.\n\nDon't let the day close untracked. 🔗`,
    evening2: `🚨 <b>CRS Final Call</b>\n\nLast chance before midnight.\n\nBet result or <b>No Game Today</b> — either counts.\n\nDon't go to sleep with an open day. ✅`,
  };

  return messages[slot] || null;
}

async function runNotification(slot) {
  let checkedIn = false;
  try {
    const state = await getState();
    checkedIn = state && state.lastCheckinDate === todayWAT();
  } catch (e) {
    console.error('[Scheduler] Failed to read state:', e.message);
  }

  const msg = buildMessage(slot, checkedIn);
  if (!msg) { console.log(`[Scheduler] ${slot} — already checked in, skipped.`); return; }
  await sendTelegram(msg);
}

// ───────────────────────────────────────────
//  SCHEDULER  (all times WAT = UTC+1)
// ───────────────────────────────────────────

function startScheduler() {
  // 08:00 WAT = 07:00 UTC
  cron.schedule('0 7 * * *',  () => runNotification('morning1'), { timezone: 'UTC' });
  // 10:00 WAT = 09:00 UTC
  cron.schedule('0 9 * * *',  () => runNotification('morning2'), { timezone: 'UTC' });
  // 13:00 WAT = 12:00 UTC
  cron.schedule('0 12 * * *', () => runNotification('midday'),   { timezone: 'UTC' });
  // 19:00 WAT = 18:00 UTC
  cron.schedule('0 18 * * *', () => runNotification('evening1'), { timezone: 'UTC' });
  // 22:00 WAT = 21:00 UTC
  cron.schedule('0 21 * * *', () => runNotification('evening2'), { timezone: 'UTC' });

  console.log('[Scheduler] 5 daily notification jobs active (WAT: 8am, 10am, 1pm, 7pm, 10pm)');
}

// ───────────────────────────────────────────
//  EXPRESS APP
// ───────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PUT');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Health check
app.get('/health', (_, res) => res.json({ ok: true }));

// ── Load state
app.get('/api/state', async (req, res) => {
  try {
    const state = await getState();
    if (!state) return res.status(404).json({ error: 'not_found' });
    res.json({ state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Init with bankroll
app.post('/api/init', async (req, res) => {
  try {
    const { bankroll } = req.body;
    if (!Number.isInteger(bankroll) || bankroll < 2001)
      return res.status(400).json({ error: 'Bankroll must be an integer above ₦2,000.' });

    const existing = await getState();
    if (existing) return res.status(409).json({ error: 'State already exists. Reset first.' });

    const state = await saveState(defaultState(bankroll));
    res.status(201).json({ state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Record win or loss
app.post('/api/result', async (req, res) => {
  try {
    const { outcome } = req.body;
    if (outcome !== 'win' && outcome !== 'loss')
      return res.status(400).json({ error: 'outcome must be "win" or "loss".' });

    const current = await getState();
    if (!current) return res.status(404).json({ error: 'not_found' });
    if (current.bankroll <= 2000)
      return res.status(422).json({ error: 'Bankroll at hard stop. Reload before betting.' });

    const { newState, event } = outcome === 'win' ? applyWin(current) : applyLoss(current);
    const saved = await saveState(newState);
    res.json({ state: saved, event });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── No game today
app.post('/api/no-game', async (req, res) => {
  try {
    const state = await recordNoGame();
    res.json({ state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Hard reset
app.delete('/api/state', async (req, res) => {
  try {
    await db.collection(COLLECTION).doc(USER_ID).delete();
    res.json({ message: 'Reset.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Clear history
app.delete('/api/history', async (req, res) => {
  try {
    await db.collection(COLLECTION).doc(USER_ID).update({ history: [], updatedAt: new Date().toISOString() });
    res.json({ message: 'History cleared.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Test Telegram notification (for the button in the app)
app.post('/api/test-notify', async (req, res) => {
  try {
    const ok = await sendTelegram(
      `🔔 <b>CRS Test Notification</b>\n\nTelegram notifications are working correctly.\n\nYou'll receive daily check-in reminders at:\n• 8:00 AM, 10:00 AM\n• 1:00 PM\n• 7:00 PM, 10:00 PM`
    );
    if (ok) res.json({ message: 'Test notification sent!' });
    else res.status(500).json({ error: 'Failed — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Railway.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ───────────────────────────────────────────
//  START
// ───────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`CRS backend running on port ${PORT}`);
  startScheduler();
});

// ── Telegram Webhook — /start, /status, /stats
app.post('/telegramWebhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const message = req.body.message || req.body.edited_message;
    if (!message) return;
    const chatId = message.chat && message.chat.id;
    const text   = (message.text || '').trim();
    if (!chatId) return;

    if (text.startsWith('/start')) {
      await sendTelegram(
        `👋 <b>CRS Tracker Bot</b>\n\nYou're connected.\n\nCommands:\n/status — current bankroll &amp; round\n/stats — full session stats`,
        chatId
      );
    } else if (text === '/status') {
      const state = await getState();
      if (!state) { await sendTelegram('⚠️ No session found. Open the app and set your bankroll first.', chatId); return; }
      const diff = state.bankroll - state.initialBankroll;
      const sign = diff >= 0 ? '+' : '−';
      await sendTelegram(
        `📊 <b>CRS Status</b>\n\nBankroll: <b>₦${state.bankroll.toLocaleString()}</b>\nP&amp;L: ${sign}₦${Math.abs(diff).toLocaleString()}\nRound: ${state.round} / 3\nCurrent stake: ₦${state.currentStake.toLocaleString()}\nCycle: #${state.cycleNumber}`,
        chatId
      );
    } else if (text === '/stats') {
      const state = await getState();
      if (!state) { await sendTelegram('⚠️ No session found.', chatId); return; }
      const wr = state.totalCycles > 0 ? ((state.successfulCycles / state.totalCycles) * 100).toFixed(1) : '—';
      await sendTelegram(
        `📈 <b>CRS Full Stats</b>\n\nInitial bankroll: ₦${state.initialBankroll.toLocaleString()}\nCurrent bankroll: ₦${state.bankroll.toLocaleString()}\nTotal cycles: ${state.totalCycles}\nSuccessful cycles: ${state.successfulCycles}\nBusts: ${state.busts}\nWin rate: ${wr}%`,
        chatId
      );
    }
  } catch (e) { console.error('[CRS] telegramWebhook error:', e.message); }
});
