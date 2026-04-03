// ═══════════════════════════════════════════════════════════════
//  CRS TRACKER — BACKEND v2.0
//  Railway env vars:
//    FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
//    TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
// ═══════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const admin   = require('firebase-admin');
const cron    = require('node-cron');

// ── Firebase init
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

// ── Constants
const USER_ID     = 'crs_main';
const COLLECTION  = 'crs_users';
const MAX_HISTORY = 100;

// ── SportyBet bonus table
const BONUS_TABLE = [
  { legs: 2,  pct: 3   },
  { legs: 3,  pct: 5   },
  { legs: 4,  pct: 8   },
  { legs: 5,  pct: 12  },
  { legs: 10, pct: 35  },
  { legs: 15, pct: 65  },
  { legs: 20, pct: 110 },
  { legs: 30, pct: 220 },
  { legs: 40, pct: 400 },
  { legs: 50, pct: 1000 },
];

function getSportybetBonus(qualifyingLegs) {
  if (qualifyingLegs < 2) return 0;
  if (qualifyingLegs >= 50) return 1000;
  for (let i = 0; i < BONUS_TABLE.length - 1; i++) {
    const lo = BONUS_TABLE[i], hi = BONUS_TABLE[i + 1];
    if (qualifyingLegs === lo.legs) return lo.pct;
    if (qualifyingLegs === hi.legs) return hi.pct;
    if (qualifyingLegs > lo.legs && qualifyingLegs < hi.legs) {
      const ratio = (qualifyingLegs - lo.legs) / (hi.legs - lo.legs);
      return parseFloat((lo.pct + ratio * (hi.pct - lo.pct)).toFixed(1));
    }
  }
  return 0;
}

// Custom rounding: second decimal 0-6 = floor to 1dp, 7-9 = ceil to 1dp
function customRound(val) {
  const floored        = Math.floor(val * 10) / 10;
  const secondDecimal  = Math.round((val - floored) * 100);
  if (secondDecimal <= 6) return parseFloat(floored.toFixed(1));
  return parseFloat((floored + 0.1).toFixed(1));
}

function calcOdds(legs) {
  const arr       = legs.map(Number);
  const raw       = arr.reduce((a, o) => a * o, 1);
  const qualifying = arr.filter(o => o >= 1.20).length;
  const bonusPct  = getSportybetBonus(qualifying);
  const effective = raw * (1 + bonusPct / 100);
  const rounded   = customRound(effective);
  return { raw: parseFloat(raw.toFixed(3)), bonusPct, effective: parseFloat(effective.toFixed(3)), rounded, qualifying };
}

// ── CRS math engine
function profitTarget(b)      { return Math.round(b * 0.05); }
function calcStake(losses, pt) { return Math.round((losses + pt) / 0.7); }

function defaultState(bankroll) {
  const pt = profitTarget(bankroll);
  return {
    initialBankroll: bankroll, bankroll,
    round: 1, cycleNumber: 1, cycleStartBankroll: bankroll,
    profitTarget: pt, lossesAccumulated: 0, currentStake: calcStake(0, pt),
    totalCycles: 0, successfulCycles: 0, busts: 0,
    streak: 0, lastStreakDate: null,
    pauseMode: false, pauseStartDate: null, lastPauseReminder: null,
    todaySchedule: null, history: [],
  };
}

function updateStreak(s) {
  const today = todayWAT();
  if (s.lastStreakDate === today) return;
  s.streak = (s.lastStreakDate === yesterdayWAT()) ? (s.streak || 0) + 1 : 1;
  s.lastStreakDate = today;
}

function applyWin(state) {
  const s = JSON.parse(JSON.stringify(state));
  s.bankroll += s.profitTarget;
  s.successfulCycles++;
  s.totalCycles++;
  updateStreak(s);
  s.history.unshift({ type: 'win', date: watDateLabel(), cycle: s.cycleNumber, round: s.round, stake: s.currentStake, profitTarget: s.profitTarget, bankrollAfter: s.bankroll, desc: `Cycle ${s.cycleNumber} — Round ${s.round} WIN` });
  const event = { kind: 'win', round: s.round, cycleNumber: s.cycleNumber, profit: s.profitTarget, bankroll: s.bankroll };
  resetCycle(s);
  return { newState: s, event };
}

function applyLoss(state) {
  const s = JSON.parse(JSON.stringify(state));
  s.bankroll -= s.currentStake;
  s.lossesAccumulated += s.currentStake;
  updateStreak(s);
  s.history.unshift({ type: 'loss', date: watDateLabel(), cycle: s.cycleNumber, round: s.round, stake: s.currentStake, bankrollAfter: s.bankroll, desc: `Cycle ${s.cycleNumber} — Round ${s.round} LOSS` });
  if (s.round === 3) {
    s.busts++; s.totalCycles++;
    const event = { kind: 'bust', lostTotal: s.lossesAccumulated, bankroll: s.bankroll, newProfitTarget: profitTarget(s.bankroll), newStake: calcStake(0, profitTarget(s.bankroll)) };
    resetCycle(s);
    return { newState: s, event };
  }
  s.round++;
  s.currentStake = calcStake(s.lossesAccumulated, s.profitTarget);
  return { newState: s, event: { kind: 'loss', round: s.round, newStake: s.currentStake, lossesAccumulated: s.lossesAccumulated, bankroll: s.bankroll } };
}

function resetCycle(s) {
  s.cycleNumber++; s.round = 1; s.lossesAccumulated = 0;
  s.cycleStartBankroll = s.bankroll;
  s.profitTarget = profitTarget(s.bankroll);
  s.currentStake = calcStake(0, s.profitTarget);
}

// ── Date helpers (WAT = UTC+1)
function todayWAT()     { return new Date(Date.now() + 3600000).toISOString().slice(0, 10); }
function yesterdayWAT() { return new Date(Date.now() + 3600000 - 86400000).toISOString().slice(0, 10); }
function watDateLabel() { return new Date(Date.now() + 3600000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
function daysBetween(d1, d2) { return Math.floor((new Date(d2) - new Date(d1)) / 86400000); }

// ── Firestore helpers
async function getState() {
  const doc = await db.collection(COLLECTION).doc(USER_ID).get();
  return doc.exists ? doc.data() : null;
}

async function saveState(state) {
  const data = { ...state, history: (state.history || []).slice(0, MAX_HISTORY), lastCheckinDate: todayWAT(), updatedAt: new Date().toISOString() };
  await db.collection(COLLECTION).doc(USER_ID).set(data);
  return data;
}

async function recordNoGame() {
  const docRef = db.collection(COLLECTION).doc(USER_ID);
  const doc    = await docRef.get();
  if (!doc.exists) throw new Error('State not found. Init first.');
  const state = doc.data();
  const today  = todayWAT();
  const streak = (state.lastStreakDate === yesterdayWAT() || state.lastStreakDate === today) ? (state.streak || 0) + 1 : 1;
  const entry  = { type: 'no_game', date: watDateLabel(), cycle: state.cycleNumber || 1, round: state.round || 1, desc: 'No game today', bankrollAfter: state.bankroll };
  const history = [entry, ...(state.history || [])].slice(0, MAX_HISTORY);
  await docRef.update({ history, lastCheckinDate: today, streak, lastStreakDate: today, todaySchedule: null, updatedAt: new Date().toISOString() });
  return { ...state, history, lastCheckinDate: today, streak, lastStreakDate: today };
}

// ── Telegram
async function sendTelegram(text, chatId = null) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const target = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !target) { console.warn('[Telegram] Env vars not set.'); return false; }
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: target, text, parse_mode: 'HTML' }) });
    const data = await res.json();
    if (!data.ok) { console.error('[Telegram]', data.description); return false; }
    return true;
  } catch (e) { console.error('[Telegram]', e.message); return false; }
}

// ── Scheduled: daily reminders
async function runNotification(slot) {
  try {
    const state = await getState();
    if (!state) { if (slot === 'morning1') await sendTelegram(`🆕 <b>CRS Tracker</b>\n\nNo session found yet. Open the app and enter your bankroll to begin. 💰`); return; }
    if (state.pauseMode) return;
    if (state.lastCheckinDate === todayWAT()) return;
    const hasPending = state.todaySchedule && state.todaySchedule.date === yesterdayWAT() && !state.todaySchedule.resultEntered;
    const msgs = {
      morning1: hasPending ? `⚠️ <b>CRS — Pending Result</b>\n\nYou scheduled games yesterday but never logged the result.\n\nOpen the app → enter yesterday's result first.` : `🌅 <b>CRS Morning Check-in</b>\n\nNo result logged yet today.\n\nOpen the tracker → Win, Loss, or No Game Today.\n\nStay disciplined. 💰`,
      morning2: `☕ <b>CRS Reminder</b>\n\nStill no check-in. Log your result or mark No Game Today. 📊`,
      midday:   `☀️ <b>CRS Midday Alert</b>\n\nHalfway through the day — still no activity. Open the tracker. ✅`,
      evening1: `🌆 <b>CRS Evening Check-in</b>\n\nNo log yet. Win, Loss, or No Game Today. 🔗`,
      evening2: `🚨 <b>CRS Final Call</b>\n\nLast chance. Log your result before midnight. ✅`,
    };
    if (msgs[slot]) await sendTelegram(msgs[slot]);
  } catch (e) { console.error('[Scheduler]', slot, e.message); }
}

// ── Scheduled: game end checker (every 15 min)
async function runGameEndChecker() {
  try {
    const state = await getState();
    if (!state || !state.todaySchedule) return;
    const sch = state.todaySchedule;
    if (sch.date !== todayWAT() || sch.resultEntered || (sch.notificationsSent || 0) >= 3) return;
    const lastGame = sch.games[sch.games.length - 1];
    if (!lastGame || !lastGame.endTime) return;
    const nowWAT = new Date(Date.now() + 3600000);
    const [eH, eM] = lastGame.endTime.split(':').map(Number);
    const endDt = new Date(nowWAT); endDt.setHours(eH, eM, 0, 0);
    if (nowWAT < endDt) return;
    const minsSinceEnd = (nowWAT - endDt) / 60000;
    if (minsSinceEnd > 180) return;
    const sent = sch.notificationsSent || 0;
    if (minsSinceEnd < [0, 30, 60][sent]) return;
    const msgs = [
      `⚽ <b>CRS — Games Finished!</b>\n\nAll scheduled games are done.\n\nOpen the tracker and enter your result. 🎯`,
      `⏰ <b>CRS — Result Pending</b>\n\nGames ended a while ago. Log WIN or LOSS. 📊`,
      `🚨 <b>CRS — Final Result Reminder</b>\n\nLast nudge. Log your result before the day closes. ✅`,
    ];
    await sendTelegram(msgs[sent]);
    await db.collection(COLLECTION).doc(USER_ID).update({ 'todaySchedule.notificationsSent': sent + 1 });
  } catch (e) { console.error('[GameEndChecker]', e.message); }
}

// ── Scheduled: midnight checker
async function runMidnightChecker() {
  try {
    const state = await getState();
    if (!state || state.pauseMode) return;
    const yesterday = yesterdayWAT();
    if (state.lastCheckinDate === yesterday || state.lastCheckinDate === todayWAT()) return;
    if (state.todaySchedule && state.todaySchedule.date === yesterday && !state.todaySchedule.resultEntered) {
      await db.collection(COLLECTION).doc(USER_ID).update({ 'todaySchedule.missed': true, streak: 0, updatedAt: new Date().toISOString() });
      await sendTelegram(`📅 <b>CRS — Missed Day</b>\n\nYesterday's scheduled games were never logged.\n\nOpen the app and enter the result before continuing today.`);
    }
  } catch (e) { console.error('[MidnightChecker]', e.message); }
}

// ── Scheduled: no-session reminder (every 2 days)
async function runNoSessionReminder() {
  try {
    const state = await getState();
    if (state) return;
    await sendTelegram(`🆕 <b>CRS Tracker — Setup Reminder</b>\n\nNo session yet.\n\nOpen the app, enter your bankroll, and let the system track everything from there. 💰`);
  } catch (e) { console.error('[NoSessionReminder]', e.message); }
}

// ── Scheduled: pause wind-down
async function runPauseNotification() {
  try {
    const state = await getState();
    if (!state || !state.pauseMode || !state.pauseStartDate) return;
    const daysPaused = daysBetween(state.pauseStartDate, todayWAT());
    const today      = todayWAT();
    let intervalDays, tier;
    if      (daysPaused < 28)  { intervalDays = 7;   tier = 'weekly';    }
    else if (daysPaused < 90)  { intervalDays = 14;  tier = 'biweekly';  }
    else if (daysPaused < 270) { intervalDays = 30;  tier = 'monthly';   }
    else                       { intervalDays = 121; tier = 'quarterly'; }
    if (state.lastPauseReminder && daysBetween(state.lastPauseReminder, today) < intervalDays) return;
    const msgs = {
      weekly:    `⏸️ <b>CRS — Still Paused</b>\n\nTracker is on pause. Toggle it off in the app whenever you're ready. 💰`,
      biweekly:  `⏸️ <b>CRS — Still Here</b>\n\nYour tracker has been on pause for a while. Ready when you are. 📊`,
      monthly:   `⏸️ <b>CRS — Monthly Check-in</b>\n\nSystem is set up and ready. Open the app anytime to resume. 🎯`,
      quarterly: `⏸️ <b>CRS — Still Running</b>\n\nIt's been a while. Your system is here when you need it. 💡`,
    };
    await sendTelegram(msgs[tier]);
    await db.collection(COLLECTION).doc(USER_ID).update({ lastPauseReminder: today });
  } catch (e) { console.error('[PauseNotification]', e.message); }
}

// ── Scheduled: weekly summary (Sunday)
async function runWeeklySummary() {
  try {
    const state = await getState();
    if (!state || state.pauseMode) return;
    const wr   = state.totalCycles > 0 ? ((state.successfulCycles / state.totalCycles) * 100).toFixed(1) : '—';
    const net  = state.bankroll - state.initialBankroll;
    const sign = net >= 0 ? '+' : '−';
    await sendTelegram(`📊 <b>CRS Weekly Summary</b>\n\nBankroll: ₦${state.bankroll.toLocaleString()}\nNet P&amp;L: ${sign}₦${Math.abs(net).toLocaleString()}\nStreak: ${state.streak || 0} days 🔥\nCycles: ${state.totalCycles} | Wins: ${state.successfulCycles} | Busts: ${state.busts}\nWin rate: ${wr}%\n\nStay disciplined. 💰`);
  } catch (e) { console.error('[WeeklySummary]', e.message); }
}

// ── Express app
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

app.get('/health', (_, res) => res.json({ ok: true, version: '2.0' }));

app.get('/api/state', async (req, res) => {
  try { const s = await getState(); if (!s) return res.status(404).json({ error: 'not_found' }); res.json({ state: s }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/init', async (req, res) => {
  try {
    const { bankroll } = req.body;
    if (!Number.isInteger(bankroll) || bankroll < 2001) return res.status(400).json({ error: 'Bankroll must be an integer above ₦2,000.' });
    const existing = await getState();
    if (existing) return res.status(409).json({ error: 'State already exists. Reset first.' });
    res.status(201).json({ state: await saveState(defaultState(bankroll)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/result', async (req, res) => {
  try {
    const { outcome } = req.body;
    if (outcome !== 'win' && outcome !== 'loss') return res.status(400).json({ error: 'outcome must be "win" or "loss".' });
    const current = await getState();
    if (!current) return res.status(404).json({ error: 'not_found' });
    if (current.bankroll <= 2000) return res.status(422).json({ error: 'Bankroll at hard stop. Reload before betting.' });
    if (current.todaySchedule && current.todaySchedule.date === yesterdayWAT() && !current.todaySchedule.resultEntered)
      return res.status(423).json({ error: 'pending_result', message: "Enter yesterday's result first." });
    const { newState, event } = outcome === 'win' ? applyWin(current) : applyLoss(current);
    if (newState.todaySchedule && newState.todaySchedule.date === todayWAT()) newState.todaySchedule.resultEntered = true;
    res.json({ state: await saveState(newState), event });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/no-game', async (req, res) => {
  try {
    const current = await getState();
    if (!current) return res.status(404).json({ error: 'not_found' });
    if (current.todaySchedule && current.todaySchedule.date === yesterdayWAT() && !current.todaySchedule.resultEntered)
      return res.status(423).json({ error: 'pending_result', message: "Enter yesterday's result first." });
    res.json({ state: await recordNoGame() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/state', async (req, res) => {
  try { await db.collection(COLLECTION).doc(USER_ID).delete(); res.json({ message: 'Reset.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/history', async (req, res) => {
  try { await db.collection(COLLECTION).doc(USER_ID).update({ history: [], updatedAt: new Date().toISOString() }); res.json({ message: 'Cleared.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pause', async (req, res) => {
  try {
    const { pause } = req.body;
    if (typeof pause !== 'boolean') return res.status(400).json({ error: 'pause must be true or false.' });
    const state = await getState();
    if (!state) return res.status(404).json({ error: 'not_found' });
    const today = todayWAT();
    await db.collection(COLLECTION).doc(USER_ID).update({ pauseMode: pause, pauseStartDate: pause ? (state.pauseStartDate || today) : null, lastPauseReminder: pause ? null : state.lastPauseReminder, updatedAt: new Date().toISOString() });
    if (pause) await sendTelegram(`⏸️ <b>CRS — Paused</b>\n\nDaily reminders off. I'll check in occasionally. Resume anytime in the app.`);
    else       await sendTelegram(`▶️ <b>CRS — Resumed</b>\n\nDaily reminders back on. Stay disciplined. 💰`);
    res.json({ pauseMode: pause });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/schedule', async (req, res) => {
  try {
    const { games } = req.body;
    if (!Array.isArray(games) || games.length === 0) return res.status(400).json({ error: 'games must be a non-empty array.' });
    const processed = games.map(g => {
      const [h, m] = g.startTime.split(':').map(Number);
      const endMin = h * 60 + m + 150;
      const eH = Math.floor(endMin / 60) % 24, eM = endMin % 60;
      return { odds: parseFloat(g.odds), startTime: g.startTime, endTime: `${String(eH).padStart(2,'0')}:${String(eM).padStart(2,'0')}` };
    });
    const schedule = { date: todayWAT(), games: processed, oddsResult: calcOdds(processed.map(g => g.odds)), resultEntered: false, notificationsSent: 0 };
    await db.collection(COLLECTION).doc(USER_ID).update({ todaySchedule: schedule, updatedAt: new Date().toISOString() });
    res.json({ schedule });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/schedule', async (req, res) => {
  try { const s = await getState(); if (!s) return res.status(404).json({ error: 'not_found' }); res.json({ schedule: s.todaySchedule || null }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/schedule', async (req, res) => {
  try { await db.collection(COLLECTION).doc(USER_ID).update({ todaySchedule: null, updatedAt: new Date().toISOString() }); res.json({ message: 'Cleared.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/calc-odds', async (req, res) => {
  try {
    const { legs } = req.body;
    if (!Array.isArray(legs) || legs.length === 0) return res.status(400).json({ error: 'legs must be a non-empty array.' });
    res.json(calcOdds(legs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test-notify', async (req, res) => {
  try {
    const ok = await sendTelegram(`🔔 <b>CRS Test Notification</b>\n\nTelegram is working.\n\nDaily reminders: 8am, 10am, 1pm, 7pm, 10pm WAT`);
    if (ok) res.json({ message: 'Sent!' }); else res.status(500).json({ error: 'Failed.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Telegram Webhook
app.post('/telegramWebhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const message = req.body.message || req.body.edited_message;
    if (!message) return;
    const chatId = message.chat && message.chat.id;
    const text   = (message.text || '').trim();
    if (!chatId) return;

    if (text.startsWith('/start')) {
      await sendTelegram(`👋 <b>CRS Tracker Bot</b>\n\nConnected.\n\nCommands:\n/status — bankroll &amp; round\n/stats — full stats\n/pause — toggle pause`, chatId);
    } else if (text === '/status') {
      const state = await getState();
      if (!state) { await sendTelegram('⚠️ No session. Open the app first.', chatId); return; }
      const diff = state.bankroll - state.initialBankroll;
      await sendTelegram(`📊 <b>CRS Status</b>\n\nBankroll: <b>₦${state.bankroll.toLocaleString()}</b>\nP&amp;L: ${diff >= 0 ? '+' : '−'}₦${Math.abs(diff).toLocaleString()}\nRound: ${state.round}/3 | Cycle: #${state.cycleNumber}\nStake: ₦${state.currentStake.toLocaleString()}\nStreak: ${state.streak || 0} days 🔥\nPaused: ${state.pauseMode ? 'Yes ⏸️' : 'No ▶️'}`, chatId);
    } else if (text === '/stats') {
      const state = await getState();
      if (!state) { await sendTelegram('⚠️ No session.', chatId); return; }
      const net = state.bankroll - state.initialBankroll;
      const wr  = state.totalCycles > 0 ? ((state.successfulCycles / state.totalCycles) * 100).toFixed(1) : '—';
      await sendTelegram(`📈 <b>CRS Full Stats</b>\n\nInitial: ₦${state.initialBankroll.toLocaleString()}\nCurrent: ₦${state.bankroll.toLocaleString()}\nNet P&amp;L: ${net >= 0 ? '+' : '−'}₦${Math.abs(net).toLocaleString()}\nStreak: ${state.streak || 0} days 🔥\nCycles: ${state.totalCycles} | Wins: ${state.successfulCycles} | Busts: ${state.busts}\nWin rate: ${wr}%`, chatId);
    } else if (text === '/pause') {
      const state = await getState();
      if (!state) { await sendTelegram('⚠️ No session.', chatId); return; }
      const newPause = !state.pauseMode;
      const today    = todayWAT();
      await db.collection(COLLECTION).doc(USER_ID).update({ pauseMode: newPause, pauseStartDate: newPause ? (state.pauseStartDate || today) : null, lastPauseReminder: newPause ? null : state.lastPauseReminder, updatedAt: new Date().toISOString() });
      await sendTelegram(newPause ? `⏸️ <b>Paused</b>\n\nReminders off. Resume with /pause anytime.` : `▶️ <b>Resumed</b>\n\nReminders back on. 💰`, chatId);
    }
  } catch (e) { console.error('[CRS] webhook:', e.message); }
});

// ── Start
function startScheduler() {
  cron.schedule('0 7 * * *',    () => runNotification('morning1'));
  cron.schedule('0 9 * * *',    () => runNotification('morning2'));
  cron.schedule('0 12 * * *',   () => runNotification('midday'));
  cron.schedule('0 18 * * *',   () => runNotification('evening1'));
  cron.schedule('0 21 * * *',   () => runNotification('evening2'));
  cron.schedule('*/15 * * * *', () => runGameEndChecker());
  cron.schedule('0 23 * * *',   () => runMidnightChecker());
  cron.schedule('0 8 */2 * *',  () => runNoSessionReminder());
  cron.schedule('0 9 * * *',    () => runPauseNotification());
  cron.schedule('0 7 * * 0',    () => runWeeklySummary());
  console.log('[CRS v2] Scheduler active');
}

app.listen(PORT, () => {
  console.log(`[CRS v2] Running on port ${PORT}`);
  startScheduler();
});
