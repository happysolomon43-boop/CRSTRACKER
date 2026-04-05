// ═══════════════════════════════════════════════════════════════
//  CRS TRACKER — BACKEND v3.2 — ADAPTATION
//  Railway env vars:
//    FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
//    TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
//    APP_SECRET  ← master key (x-crs-secret header)
//
//  v3.1: PUT /api/key — change access key; custom key hash in Firestore
//  v3.2: Multi-tracker support — each session carries a trackerId
//        POST /api/tracker/create — new independent tracker + session
//        GET  /api/tracker/info  — current tracker label
//        All state ops route through req.trackerId dynamically
//        Scheduler iterates all active trackers
//        verifySession throws on Firestore errors (returns 503, not 401)
// ═══════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const admin   = require('firebase-admin');
const cron    = require('node-cron');
const crypto  = require('crypto');

const privateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined;

admin.initializeApp({ credential: admin.credential.cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey }) });
const db = admin.firestore();

const USER_ID        = 'crs_main'; // default / fallback tracker
const COLLECTION     = 'crs_users';
const SESSIONS_COL   = 'crs_sessions';
const CONFIG_COL     = 'crs_config';   // stores custom key hash
const CONFIG_ID      = 'main';
const MAX_HISTORY    = 150;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const ROLLING_WINDOW = 20;

function getHardStop(state) {
  return Math.max(2000, Math.round((state?.initialBankroll || 0) * 0.10));
}

function calcVolatilityPenalty(oddsLog) {
  const sample = (oddsLog || []).slice(0, 10);
  if (sample.length < 5) return 0;
  const mean     = sample.reduce((a, v) => a + v, 0) / sample.length;
  const variance = sample.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / sample.length;
  const stdDev   = Math.sqrt(variance);
  const normal   = mean * 0.15;
  if (stdDev > normal * 1.5) return 0.15;
  if (stdDev > normal * 1.2) return 0.08;
  return 0;
}

function dynamicViabilityPct(odds, history) {
  const base    = Math.min(Math.max(0.20 + odds * 0.05, 0.25), 0.45);
  const settled = (history || []).filter(h => h.type === 'win' || h.type === 'loss' || h.type === 'bust');
  if (settled.length < 10) return base;
  const bustRate = (history || []).filter(h => h.type === 'bust').length / settled.length;
  if (bustRate > 0.35) return parseFloat((base * 0.82).toFixed(3));
  if (bustRate > 0.20) return parseFloat((base * 0.90).toFixed(3));
  return base;
}
const DEFAULT_AVG    = 1.70;
const MAX_ROUNDS     = 3;

const BONUS_TABLE = [
  {legs:2,pct:3},{legs:3,pct:5},{legs:4,pct:8},{legs:5,pct:12},
  {legs:10,pct:35},{legs:15,pct:65},{legs:20,pct:110},{legs:30,pct:220},
  {legs:40,pct:400},{legs:50,pct:1000},
];

function getSportybetBonus(q) {
  if (q < 2) return 0; if (q >= 50) return 1000;
  for (let i = 0; i < BONUS_TABLE.length - 1; i++) {
    const lo = BONUS_TABLE[i], hi = BONUS_TABLE[i+1];
    if (q === lo.legs) return lo.pct; if (q === hi.legs) return hi.pct;
    if (q > lo.legs && q < hi.legs) return parseFloat((lo.pct + (q-lo.legs)/(hi.legs-lo.legs)*(hi.pct-lo.pct)).toFixed(1));
  }
  return 0;
}

function customRound(val) {
  const f = Math.floor(val*10)/10;
  return Math.round((val-f)*100) <= 6 ? parseFloat(f.toFixed(1)) : parseFloat((f+0.1).toFixed(1));
}

function calcOdds(legs) {
  const arr = legs.map(Number);
  const raw = arr.reduce((a,o) => a*o, 1);
  const q   = arr.filter(o => o >= 1.20).length;
  const bp  = getSportybetBonus(q);
  const eff = raw * (1 + bp/100);
  return { raw: parseFloat(raw.toFixed(3)), bonusPct: bp, effective: parseFloat(eff.toFixed(3)), rounded: customRound(eff), qualifying: q };
}

// ── ADAPTATION ENGINE ────────────────────────────────────────

function getRollingAverage(oddsLog) {
  if (!oddsLog || !oddsLog.length) return DEFAULT_AVG;
  const sl = oddsLog.slice(0, ROLLING_WINDOW);
  return parseFloat((sl.reduce((a,v) => a+v, 0) / sl.length).toFixed(3));
}

function getOddsTrend(oddsLog) {
  if (!oddsLog || oddsLog.length < 10) return 'insufficient';
  const r = oddsLog.slice(0,10).reduce((a,v)=>a+v,0)/10;
  const p = oddsLog.length >= 20 ? oddsLog.slice(10,20).reduce((a,v)=>a+v,0)/10 : r;
  const d = r - p;
  if (d > 0.08) return 'up'; if (d < -0.08) return 'down'; return 'stable';
}

function determineRoundMode(todayOdds, rollingAvg, round) {
  const ratio = todayOdds / rollingAvg;
  if (round === 1) {
    if (ratio >= 1.5)  return { mode:'profit',   label:'PROFIT+',  pct:0.080 };
    if (ratio >= 1.2)  return { mode:'profit',   label:'PROFIT+',  pct:0.065 };
    if (ratio >= 0.85) return { mode:'profit',   label:'PROFIT',   pct:0.050 };
    if (ratio >= 0.65) return { mode:'profit',   label:'CAUTIOUS', pct:0.035 };
    return                    { mode:'profit',   label:'CAUTIOUS', pct:0.025 };
  }
  if (ratio >= 0.85) return { mode:'profit',   label:'PROFIT',   pct:null };
  if (ratio >= 0.65) return { mode:'recovery', label:'RECOVERY', pct:null };
  return                    { mode:'survival', label:'SURVIVAL', pct:null };
}

function calcProfitTarget(bankroll, pct, history) {
  const base = Math.round(bankroll * pct);
  const rw   = (history||[]).filter(h => h.type==='win' && !h.isRecovery).slice(0,10);
  if (rw.length < 3) return base;
  const avg  = rw.reduce((a,h) => a+(h.profitTarget||0), 0) / rw.length;
  return Math.min(base, Math.round(avg * 2.5));
}

function pf(odds)            { return Math.max(odds-1, 0.05); }
function profitStake(L,T,o)  { return Math.round((L+T)/pf(o)); }
function recoveryStake(L,o)  { return L<=0 ? 0 : Math.round(L/pf(o)); }
function survivalStake(L,o)  { return L<=0 ? 0 : Math.round((L*0.80)/pf(o)); }
function survivalShortfall(L,o) { return Math.max(0, L - Math.round(survivalStake(L,o)*pf(o))); }
function isViable(stake, state, odds) {
  return state.bankroll > getHardStop(state) && stake <= state.bankroll * dynamicViabilityPct(odds, state.history);
}

function computeStake(state, todayOdds) {
  const avg        = getRollingAverage(state.oddsLog);
  const modeInfo   = determineRoundMode(todayOdds, avg, state.round);
  const volPenalty = state.round === 1 ? calcVolatilityPenalty(state.oddsLog) : 0;
  let stake, profitTarget, shortfall = 0;
  if (state.round === 1) {
    profitTarget = calcProfitTarget(state.bankroll, modeInfo.pct, state.history);
    stake        = Math.round(profitStake(0, profitTarget, todayOdds) * (1 - volPenalty));
  } else {
    profitTarget = state.profitTarget;
    if (modeInfo.mode === 'profit')        stake = profitStake(state.lossesAccumulated, profitTarget, todayOdds);
    else if (modeInfo.mode === 'recovery') stake = recoveryStake(state.lossesAccumulated, todayOdds);
    else { stake = survivalStake(state.lossesAccumulated, todayOdds); shortfall = survivalShortfall(state.lossesAccumulated, todayOdds); }
  }
  const vPct = dynamicViabilityPct(todayOdds, state.history);
  return { stake, profitTarget, shortfall, mode: modeInfo.mode, label: modeInfo.label, pct: modeInfo.pct,
    viable: isViable(stake, state, todayOdds), threshold: Math.round(vPct * 100),
    oddsRatio: parseFloat((todayOdds / avg).toFixed(3)), rollingAvg: avg,
    volPenalty: Math.round(volPenalty * 100) };
}

function calcRecommendedBankroll(bankroll, oddsLog, history) {
  const avg = getRollingAverage(oddsLog);
  const T   = Math.round(bankroll*0.05);
  const r1  = profitStake(0, T, avg);
  const r2  = profitStake(r1, T, avg);
  const r3  = profitStake(r1+r2, T, avg);
  return Math.round((r1+r2+r3)/0.65);
}

function calcAgentScore(history, oddsLog) {
  const bets = (history||[]).filter(h => h.type==='win'||h.type==='loss');
  if (bets.length < 5) return null;
  const wr = bets.filter(h => h.type==='win').length / bets.length;
  const s  = 50 + (wr-0.55)*200 + (getRollingAverage(oddsLog)-1.5)*20;
  return Math.min(100, Math.max(0, Math.round(s)));
}

function calcProjection(state, oddsLog) {
  const bets = (state.history||[]).filter(h => h.type==='win'||h.type==='loss');
  if (bets.length < 5) return null;
  const wr  = bets.filter(h => h.type==='win').length / bets.length;
  const avg = getRollingAverage(oddsLog);
  const T   = Math.round(state.bankroll*0.05);
  const r1  = profitStake(0, T, avg); const r2 = profitStake(r1, T, avg); const r3 = profitStake(r1+r2, T, avg);
  const bust = Math.pow(1-wr, MAX_ROUNDS);
  const net  = T*(1-bust) - (r1+r2+r3)*bust;
  const weekly = Math.round(net*6);
  return { weekly, monthly: Math.round(weekly*4.33), yearly: Math.round(weekly*52), winRate: parseFloat((wr*100).toFixed(1)), avgOdds: avg };
}

// ── CLOUD SESSIONS ───────────────────────────────────────────
function genToken() { return crypto.randomBytes(32).toString('hex'); }
async function createSession(trackerId) {
  const token = genToken();
  await db.collection(SESSIONS_COL).doc(token).set({ trackerId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+SESSION_TTL_MS).toISOString() });
  return token;
}
async function verifySession(token) {
  if (!token) return { ok: false, error: null };
  const doc = await db.collection(SESSIONS_COL).doc(token).get(); // allow to throw on Firestore error
  if (!doc.exists) return { ok: false, error: null };
  if (Date.now() > new Date(doc.data().expiresAt).getTime()) {
    doc.ref.delete().catch(() => {}); return { ok: false, error: null };
  }
  return { ok: true, trackerId: doc.data().trackerId || USER_ID };
}
async function deleteSession(token) { if (token) try { await db.collection(SESSIONS_COL).doc(token).delete(); } catch (_) {} }
async function cleanExpiredSessions() {
  try {
    const snap = await db.collection(SESSIONS_COL).where('expiresAt','<',new Date().toISOString()).limit(50).get();
    const batch = db.batch(); snap.forEach(d => batch.delete(d.ref)); if (!snap.empty) await batch.commit();
  } catch (e) { console.error('[SessionClean]', e.message); }
}

// ── STATE ────────────────────────────────────────────────────
function defaultState(bankroll) {
  return { initialBankroll:bankroll, bankroll, peakBankroll:bankroll, round:1, cycleNumber:1, cycleStartBankroll:bankroll,
    profitTarget:0, cyclePct:0.05, lossesAccumulated:0, currentStake:0, stakeLocked:false,
    phase:'profit', cycleLabel:null, roundOdds:[], oddsLog:[],
    totalCycles:0, successfulCycles:0, recoveryWins:0, busts:0, gateBusts:0,
    streak:0, lastStreakDate:null, pauseMode:false, pauseStartDate:null, lastPauseReminder:null,
    lastOpportunityAlert:null, lastDriftAlert:null, lastBankrollAlert:null,
    todaySchedule:null, history:[] };
}

function todayWAT()     { return new Date(Date.now()+3600000).toISOString().slice(0,10); }
function yesterdayWAT() { return new Date(Date.now()+3600000-86400000).toISOString().slice(0,10); }
function watDateLabel() { return new Date(Date.now()+3600000).toLocaleDateString('en-GB',{day:'numeric',month:'short'}); }
function daysBetween(d1,d2) { return Math.floor((new Date(d2)-new Date(d1))/86400000); }

function updateStreak(s) {
  const today = todayWAT(); if (s.lastStreakDate === today) return;
  s.streak = s.lastStreakDate === yesterdayWAT() ? (s.streak||0)+1 : 1; s.lastStreakDate = today;
}

function resetCycle(s) {
  s.cycleNumber++; s.round=1; s.lossesAccumulated=0; s.cycleStartBankroll=s.bankroll;
  s.profitTarget=0; s.cyclePct=0.05; s.phase='profit'; s.cycleLabel=null;
  s.roundOdds=[]; s.currentStake=0; s.stakeLocked=false; s.todaySchedule=null;
}

function applyTicket(state, ticketOdds) {
  const s    = JSON.parse(JSON.stringify(state));
  const info = computeStake(s, ticketOdds);
  s.currentStake = info.stake; s.stakeLocked = true;
  s.phase = info.mode; s.cycleLabel = info.label;
  if (s.round === 1) { s.profitTarget = info.profitTarget; s.cyclePct = info.pct||0.05; }
  s.roundOdds = [...(s.roundOdds||[]), ticketOdds];
  return { newState:s, stakeInfo:info };
}

function applyWin(state) {
  const s          = JSON.parse(JSON.stringify(state));
  const isRecovery = s.phase==='recovery'||s.phase==='survival';
  const usedOdds   = s.roundOdds[s.roundOdds.length-1]||DEFAULT_AVG;
  const netReturn  = Math.round(s.currentStake * pf(usedOdds));
  const gain       = isRecovery ? Math.min(netReturn, s.lossesAccumulated) : s.profitTarget;
  s.bankroll += gain; s.successfulCycles++; s.totalCycles++;
  s.peakBankroll   = Math.max(s.peakBankroll || s.initialBankroll, s.bankroll);
  if (isRecovery) s.recoveryWins = (s.recoveryWins||0)+1;
  updateStreak(s);
  s.oddsLog = [usedOdds, ...(s.oddsLog||[])].slice(0,150);
  const histEntry = { type:'win', isRecovery, date:watDateLabel(), cycle:s.cycleNumber, round:s.round,
    stake:s.currentStake, odds:usedOdds, phase:s.phase, label:s.cycleLabel,
    profitTarget:isRecovery?0:s.profitTarget, recovered:isRecovery?gain:0,
    bankrollAfter:s.bankroll, desc:`Cycle ${s.cycleNumber} — R${s.round} ${isRecovery?'RECOVERY WIN':'WIN'} @ ${usedOdds}` };
  s.history = [histEntry, ...(s.history||[])].slice(0,MAX_HISTORY);
  const winLockSuggested    = !isRecovery && s.bankroll >= Math.round(s.initialBankroll * 1.30);
  const suggestedWithdrawal = winLockSuggested ? Math.round((s.bankroll - s.initialBankroll) * 0.50) : 0;
  const event = { kind:'win', winType:isRecovery?'recovery':'profit', round:s.round, cycleNumber:s.cycleNumber,
    profit:isRecovery?0:s.profitTarget, recovered:isRecovery?gain:0, bankroll:s.bankroll, odds:usedOdds, label:s.cycleLabel,
    winLockSuggested, suggestedWithdrawal };
  resetCycle(s);
  return { newState:s, event };
}

function applyLoss(state) {
  const s        = JSON.parse(JSON.stringify(state));
  const usedOdds = s.roundOdds[s.roundOdds.length-1]||DEFAULT_AVG;
  s.bankroll -= s.currentStake; s.lossesAccumulated += s.currentStake;
  s.peakBankroll = s.peakBankroll || s.initialBankroll;
  const lossLockTriggered = !s.pauseMode && s.bankroll < Math.round(s.peakBankroll * 0.60);
  if (lossLockTriggered) {
    s.pauseMode = true;
    s.pauseStartDate = s.pauseStartDate || todayWAT();
    s.lastPauseReminder = null;
  }
  updateStreak(s);
  s.oddsLog = [usedOdds, ...(s.oddsLog||[])].slice(0,150);
  s.history = [{ type:'loss', date:watDateLabel(), cycle:s.cycleNumber, round:s.round, stake:s.currentStake,
    odds:usedOdds, phase:s.phase, label:s.cycleLabel, bankrollAfter:s.bankroll,
    desc:`Cycle ${s.cycleNumber} — R${s.round} LOSS @ ${usedOdds}` }, ...(s.history||[])].slice(0,MAX_HISTORY);
  if (s.round >= MAX_ROUNDS) {
    s.busts++; s.totalCycles++;
    const event = { kind:'bust', bustType:'natural', round:s.round, lostTotal:s.lossesAccumulated, bankroll:s.bankroll, lossLockTriggered };
    resetCycle(s); return { newState:s, event };
  }
  s.round++; s.phase='awaiting'; s.cycleLabel=null; s.currentStake=0; s.stakeLocked=false;
  return { newState:s, event:{ kind:'loss', round:s.round, lossesAccumulated:s.lossesAccumulated, bankroll:s.bankroll, lossLockTriggered } };
}

// ── FIRESTORE ────────────────────────────────────────────────
async function getState(trackerId) { const d = await db.collection(COLLECTION).doc(trackerId).get(); if (!d.exists) return null; const data = d.data(); return (data.bankroll != null) ? data : null; }
async function saveState(s, trackerId) {
  const data = { ...s, history:(s.history||[]).slice(0,MAX_HISTORY), oddsLog:(s.oddsLog||[]).slice(0,150), lastCheckinDate:todayWAT(), updatedAt:new Date().toISOString(), version:'3.2' };
  await db.collection(COLLECTION).doc(trackerId).set(data, {merge:true}); return data;
}
async function recordNoGame(state, trackerId) {
  const s = JSON.parse(JSON.stringify(state)); const today = todayWAT();
  const streak = (s.lastStreakDate===yesterdayWAT()||s.lastStreakDate===today) ? (s.streak||0)+1 : 1;
  s.history = [{ type:'no_game', date:watDateLabel(), cycle:s.cycleNumber, round:s.round, desc:'No game today', bankrollAfter:s.bankroll }, ...(s.history||[])].slice(0,MAX_HISTORY);
  s.streak=streak; s.lastStreakDate=today; s.todaySchedule=null; return saveState(s, trackerId);
}

// ── TELEGRAM ─────────────────────────────────────────────────
async function sendTelegram(text, chatId=null) {
  const token=process.env.TELEGRAM_BOT_TOKEN, target=chatId||process.env.TELEGRAM_CHAT_ID;
  if (!token||!target) return false;
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:target,text,parse_mode:'HTML'})});
    const data = await res.json();
    if (!data.ok) { console.error('[Telegram]',data.description); return false; } return true;
  } catch (e) { console.error('[Telegram]',e.message); return false; }
}

function buildDailyMsg(state, slot) {
  const hasPending = state.todaySchedule?.date<todayWAT()&&!state.todaySchedule?.resultEntered;
  if (hasPending) return `⚠️ <b>CRS — Pending Result</b>\n\nA scheduled game has no result logged.\n\nOpen the app → enter result first.`;
  const bk      = `₦${state.bankroll.toLocaleString()}`;
  const onRound = state.round>1 ? `\n\n⚠️ <b>Round ${state.round} active.</b> ₦${(state.lossesAccumulated||0).toLocaleString()} to recover.` : '';
  const waiting = !state.stakeLocked&&state.round>1 ? `\n📝 Enter today's ticket for your Round ${state.round} stake.` : '';
  const sk      = state.stakeLocked&&state.currentStake>0 ? `\n💳 Stake: <b>₦${state.currentStake.toLocaleString()}</b> · ${(state.cycleLabel||'').toUpperCase()}` : '';
  const msgs = {
    morning1:`🌅 <b>CRS Morning Brief</b>\n\nBankroll: <b>${bk}</b>${onRound}${waiting}${sk}\n\nWait for the agent's tip, then enter it. 💰`,
    morning2:`☕ <b>CRS — Reminder</b>\n\nNo check-in yet.${onRound}${waiting}${sk}`,
    midday:  `☀️ <b>CRS Midday</b>\n\nNo activity logged.${onRound}${sk}\n\nLog Win, Loss, or No Game.`,
    evening1:`🌆 <b>CRS Evening</b>\n\nNo result today.${onRound}${sk}\n\nLog before games end. 🎯`,
    evening2:`🚨 <b>CRS Final Call</b>\n\nLast chance to log today.${sk} ✅`,
  };
  return msgs[slot]||'';
}

async function fireOpportunityAlert(state, info, trackerId) {
  if (info.oddsRatio<1.30||state.lastOpportunityAlert===todayWAT()) return;
  const pct=Math.round((info.oddsRatio-1)*100), tier=info.oddsRatio>=1.5?'EXCEPTIONAL':'ABOVE AVERAGE';
  const todayOdds = parseFloat((info.rollingAvg * info.oddsRatio).toFixed(2));
  await sendTelegram(`🔥 <b>CRS — Opportunity Alert</b>\n\nToday's odds: <b>${todayOdds}</b> · Baseline: <b>${info.rollingAvg}</b>\n<b>${pct}% above</b> average — <b>${tier}</b>\n\nTargeting <b>${Math.round((info.pct||0.05)*100)}%</b> profit.\nStake is smaller than usual. Trust it. 💰`);
  await db.collection(COLLECTION).doc(trackerId).update({lastOpportunityAlert:todayWAT()});
}

async function fireRecoveryEntryAlert(state, info, round) {
  const sf = info.mode==='survival'&&info.shortfall>0 ? `\n⚠️ Survival: ₦${info.shortfall.toLocaleString()} may remain unrecovered.` : '';
  const goal = info.mode==='recovery' ? '🎯 Recover losses only. No profit.' : '🛡️ Partial recovery. Protect bankroll.';
  await sendTelegram(`🟡 <b>CRS — ${info.mode.toUpperCase()} MODE — Round ${round}</b>\n\nOdds below rolling average (${info.rollingAvg}).\n\n${goal}${sf}\n\nTo recover: <b>₦${(state.lossesAccumulated||0).toLocaleString()}</b>\nStake: <b>₦${info.stake.toLocaleString()}</b>`);
}

async function fireRecoveryWinAlert(bankroll, event) {
  await sendTelegram(`🟢 <b>CRS — Recovery Complete</b>\n\nCycle #${event.cycleNumber} recovered.\n<b>₦${(event.recovered||0).toLocaleString()}</b> returned.\nNo profit booked — nothing lost.\n\nBankroll: <b>₦${bankroll.toLocaleString()}</b>\nClean slate. Fresh cycle. 💰`);
}

async function fireLossEncouragement(state, event) {
  const isBust  = event.kind === 'bust';
  const round   = event.round || state.round;
  const bk      = `₦${state.bankroll.toLocaleString()}`;

  const bustMessages = [
    `💪 <b>CRS — Shake It Off</b>\n\nThat cycle didn't go your way — it happens to everyone. Bankroll: <b>${bk}</b>.\n\nThe system adjusts. Fresh cycle, fresh start. Stay locked in. 🔒`,
    `🧱 <b>CRS — Stay Solid</b>\n\nOne bust doesn't define the session. You've come back before. Bankroll: <b>${bk}</b>.\n\nReset. Breathe. Come back stronger. 💰`,
    `⚡ <b>CRS — Keep Going</b>\n\nLosses are part of the game — what matters is discipline after them. Bankroll: <b>${bk}</b>.\n\nDon't chase. Trust the process. 🎯`,
  ];

  const lossMessages = [
    `😤 <b>CRS — Round ${round} Loss</b>\n\nThat one stings. But you're still in it — ${event.round > 2 ? 'cycle resets, system adapts' : `Round ${event.round} is next`}. Bankroll: <b>${bk}</b>.\n\nStay focused. 💪`,
    `🎯 <b>CRS — Not Over Yet</b>\n\nOne loss doesn't decide your day. Bankroll: <b>${bk}</b>.\n\nThe system has recovery built in for exactly this. Trust it. 🔒`,
    `🧠 <b>CRS — Discipline Wins</b>\n\nEvery good run has bad days in it. What separates winners is staying composed. Bankroll: <b>${bk}</b>.\n\nLog it, move on. 💰`,
  ];

  const pool = isBust ? bustMessages : lossMessages;
  const msg  = pool[Math.floor(Math.random() * pool.length)];
  await sendTelegram(msg);
}

async function checkDriftAlert(state, trackerId) {
  const ol = state.oddsLog||[];
  if (ol.length<15||getOddsTrend(ol)!=='down') return;
  const l10=ol.slice(0,10).reduce((a,v)=>a+v,0)/10, p10=ol.length>=20?ol.slice(10,20).reduce((a,v)=>a+v,0)/10:l10;
  const drop=((p10-l10)/p10)*100;
  if (drop<15||state.lastDriftAlert&&daysBetween(state.lastDriftAlert,todayWAT())<7) return;
  await sendTelegram(`📉 <b>CRS — Agent Drift</b>\n\nRolling avg falling.\nLast 10: <b>${l10.toFixed(2)}</b> · Prev 10: <b>${p10.toFixed(2)}</b>\nDrop: <b>${drop.toFixed(1)}%</b>\n\nStakes will adapt. Monitor the agent.`);
  await db.collection(COLLECTION).doc(trackerId).update({lastDriftAlert:todayWAT()});
}

async function checkBankrollAlert(state, trackerId) {
  const rec=calcRecommendedBankroll(state.bankroll,state.oddsLog,state.history), diff=state.bankroll-rec;
  if (Math.abs(diff/rec)*100<20||state.lastBankrollAlert&&daysBetween(state.lastBankrollAlert,todayWAT())<30) return;
  const msg = diff>0
    ? `💡 <b>CRS — Bankroll Optimisation</b>\n\nRecommended: <b>₦${rec.toLocaleString()}</b>\nCurrent: <b>₦${state.bankroll.toLocaleString()}</b>\nCould safely withdraw <b>₦${diff.toLocaleString()}</b>. 💰`
    : `⚠️ <b>CRS — Below Optimal</b>\n\nRecommended: <b>₦${rec.toLocaleString()}</b>\nCurrent: <b>₦${state.bankroll.toLocaleString()}</b>\nConsider adding <b>₦${Math.abs(diff).toLocaleString()}</b>.`;
  await sendTelegram(msg);
  await db.collection(COLLECTION).doc(trackerId).update({lastBankrollAlert:todayWAT()});
}

// ── SCHEDULERS ───────────────────────────────────────────────
async function getAllActiveTrackers() {
  try {
    const snap = await db.collection(COLLECTION).where('bankroll', '>', 0).get();
    return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
  } catch { return []; }
}

async function runNotification(slot) {
  try {
    const trackers = await getAllActiveTrackers();
    if (!trackers.length) { if(slot==='morning1') await sendTelegram(`🆕 <b>CRS</b>\n\nNo tracker initialised. Open the app. 💰`); return; }
    const multi = trackers.length > 1;
    for (const s of trackers) {
      try {
        if (s.pauseMode||s.lastCheckinDate===todayWAT()) continue;
        const prefix = multi ? `[${s._label||s._id}] ` : '';
        const msg = buildDailyMsg(s, slot); if (msg) await sendTelegram(prefix + msg);
      } catch(e) { console.error('[Scheduler]', slot, s._id, e.message); }
    }
  } catch(e) { console.error('[Scheduler]',slot,e.message); }
}

async function runGameEndChecker() {
  const trackers = await getAllActiveTrackers();
  for (const s of trackers) { try { if (!s?.todaySchedule) continue; const _tid = s._id;
    const sch = s.todaySchedule;
    if (sch.date !== todayWAT() || sch.resultEntered) continue;

    const now     = new Date(Date.now() + 3600000); // WAT
    const games   = sch.games;
    const total   = games.length;
    const sent    = sch.gameNotificationsSent || 0; // how many per-game msgs sent so far
    const updates = {};

    // Sort games by startTime to determine order (should already be ordered)
    // Find next unnotified finished game
    for (let i = sent; i < total; i++) {
      const g = games[i];
      if (!g.endTime) continue;
      const [eH, eM] = g.endTime.split(':').map(Number);
      const end = new Date(now); end.setHours(eH, eM, 0, 0);
      if (now < end) break; // this game hasn't ended yet — stop checking

      const remaining = total - i - 1;
      let msg;

      if (remaining === 0) {
        // ALL games done — only now ask to log result
        const sk = s.stakeLocked && s.currentStake > 0
          ? `\n💳 Stake: <b>₦${s.currentStake.toLocaleString()}</b>`
          : '';
        msg = `✅ <b>CRS — All Games Done!</b>\n\nThat's the full ticket wrapped up. Head in and log your final result now.${sk} 🎯`;
      } else if (remaining === 1) {
        // Second-to-last game done
        msg = `⚽ <b>CRS — Game ${i + 1} Done</b>\n\nHope that one landed! One more to go — best of luck on the last game. 🎯`;
      } else {
        // Mid-ticket game done
        msg = `⚽ <b>CRS — Game ${i + 1} Done</b>\n\nHope you got that one! ${remaining} game${remaining > 1 ? 's' : ''} remaining — keep it going. 💪`;
      }

      await sendTelegram(msg);
      updates['todaySchedule.gameNotificationsSent'] = i + 1;

      // Only notify one game per 15-min cycle to avoid flooding
      break;
    }

    if (Object.keys(updates).length) {
      await db.collection(COLLECTION).doc(_tid).update(updates);
    }

    // Final result reminders (only after all games done, result not yet entered)
    if (sent >= total && !sch.resultEntered) {
      const lastGame   = games[total - 1];
      const [lH, lM]   = lastGame.endTime.split(':').map(Number);
      const lastEnd    = new Date(now); lastEnd.setHours(lH, lM, 0, 0);
      const minsPast   = (now - lastEnd) / 60000;
      if (minsPast < 0 || minsPast > 180) continue;
      const reminders  = sch.notificationsSent || 0;
      if (reminders >= 2) continue;
      const delays     = [30, 75]; // 30min and 75min after all done
      if (minsPast < delays[reminders]) continue;
      const sk         = s.stakeLocked && s.currentStake > 0 ? `\n💳 Stake: <b>₦${s.currentStake.toLocaleString()}</b>` : '';
      const reminderMsgs = [
        `⏰ <b>CRS — Still waiting</b>\n\nGames ended a while ago — don't forget to log your result.${sk}`,
        `🚨 <b>CRS — Final Reminder</b>\n\nLog your result before midnight.${sk}`
      ];
      await sendTelegram(reminderMsgs[reminders]);
      await db.collection(COLLECTION).doc(_tid).update({'todaySchedule.notificationsSent': reminders + 1});
    }
  } catch(e) { console.error('[GameEndChecker]', s._id, e.message); } }
}

async function runMidnightChecker() {
  const trackers = await getAllActiveTrackers();
  for (const s of trackers) { try {
    if (!s||s.pauseMode) continue;
    if (s.lastCheckinDate===yesterdayWAT()||s.lastCheckinDate===todayWAT()) continue;
    if (s.todaySchedule?.date<todayWAT()&&!s.todaySchedule?.resultEntered) {
      await db.collection(COLLECTION).doc(s._id).update({'todaySchedule.missed':true,streak:0,updatedAt:new Date().toISOString()});
      await sendTelegram(`📅 <b>CRS — Missed Day</b>\n\nGame never logged. Enter result before continuing. Streak reset.`);
    }
  } catch(e) { console.error('[MidnightChecker]',s._id,e.message); } }
}

async function runNoSessionReminder() {
  try { const t=await getAllActiveTrackers(); if (!t.length) await sendTelegram(`🆕 <b>CRS</b>\n\nNo tracker active. Open the app to start. 💰`); }
  catch(e) { console.error('[NoSessionReminder]',e.message); }
}

async function runPauseNotification() {
  const trackers = await getAllActiveTrackers();
  for (const s of trackers) { try {
    if (!s?.pauseMode||!s?.pauseStartDate) continue;
    const days=daysBetween(s.pauseStartDate,todayWAT()), today=todayWAT();
    const [interval,tier]=days<28?[7,'weekly']:days<90?[14,'biweekly']:days<270?[30,'monthly']:[121,'quarterly'];
    if (s.lastPauseReminder&&daysBetween(s.lastPauseReminder,today)<interval) continue;
    const msgs={weekly:`⏸️ <b>CRS Paused</b>\n\nToggle off when ready. 💰`,biweekly:`⏸️ <b>CRS Here</b>\n\nReady when you are. 📊`,monthly:`⏸️ <b>CRS Monthly</b>\n\nSystem ready. Open to resume. 🎯`,quarterly:`⏸️ <b>CRS Running</b>\n\nHere when needed. 💡`};
    await sendTelegram(msgs[tier]);
    await db.collection(COLLECTION).doc(s._id).update({lastPauseReminder:today});
  } catch(e) { console.error('[PauseNotification]',s._id,e.message); } }
}

async function runWeeklySummary() {
  const trackers = await getAllActiveTrackers();
  for (const s of trackers) { try {
    if (s.pauseMode) continue;
    const ol=s.oddsLog||[], avg=getRollingAverage(ol), trend=getOddsTrend(ol);
    const te=trend==='up'?'📈':trend==='down'?'📉':'➡️';
    const wr=s.totalCycles>0?((s.successfulCycles/s.totalCycles)*100).toFixed(1):'—';
    const net=s.bankroll-s.initialBankroll, sign=net>=0?'+':'−';
    const proj=calcProjection(s,ol), pl=proj?`\nMonthly: <b>~₦${proj.monthly.toLocaleString()}</b>`:'';
    const lbl=s._label?`[${s._label}] `:'';
    await sendTelegram(`📊 <b>${lbl}CRS Weekly</b>\n\nBankroll: <b>₦${s.bankroll.toLocaleString()}</b>\nNet: <b>${sign}₦${Math.abs(net).toLocaleString()}</b>\nStreak: ${s.streak||0} 🔥\n\nCycles: ${s.totalCycles} | Wins: ${s.successfulCycles} | Busts: ${s.busts}\nRecovery wins: ${s.recoveryWins||0}\nWin rate: <b>${wr}%</b>\n\nAvg odds: <b>${avg}</b> ${te}${pl}\n\nStay disciplined. 💰`);
    await checkDriftAlert(s, s._id); await checkBankrollAlert(s, s._id);
  } catch(e) { console.error('[WeeklySummary]', s._id, e.message); } }
}

// ── EXPRESS ──────────────────────────────────────────────────
const app=express(), PORT=process.env.PORT||3000;
app.use(express.json());
app.use((req,res,next) => {
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Methods','GET,POST,DELETE,PUT');
  res.header('Access-Control-Allow-Headers','Content-Type,x-crs-secret,x-crs-session');
  if (req.method==='OPTIONS') return res.sendStatus(200); next();
});

app.get('/health',(_,res) => res.json({ok:true,version:'3.2'}));

app.post('/telegramWebhook', async (req,res) => {
  res.status(200).send('OK');
  try {
    const msg=req.body.message||req.body.edited_message; if (!msg) return;
    const chatId=msg.chat?.id, text=(msg.text||'').trim(); if (!chatId) return;
    if (text.startsWith('/start')) {
      await sendTelegram(`👋 <b>CRS v3.0 — ADAPTATION</b>\n\nCommands:\n/status — live stake\n/stats — performance\n/intel — agent intelligence\n/pause — toggle notifications`,chatId);
    } else if (text==='/status') {
      const s=await getState(USER_ID); if (!s){await sendTelegram('⚠️ No session.',chatId);return;}
      const diff=s.bankroll-s.initialBankroll;
      const sk=s.stakeLocked&&s.currentStake>0?`\n💳 Stake: <b>₦${s.currentStake.toLocaleString()}</b> · ${(s.cycleLabel||'—').toUpperCase()}`:`\n📝 <i>Awaiting ticket for Round ${s.round}</i>`;
      await sendTelegram(`📊 <b>CRS Status</b>\n\nBankroll: <b>₦${s.bankroll.toLocaleString()}</b>\nP&amp;L: ${diff>=0?'+':'−'}₦${Math.abs(diff).toLocaleString()}\nR${s.round}/${MAX_ROUNDS} · Cycle #${s.cycleNumber}${sk}\nStreak: ${s.streak||0} 🔥`,chatId);
    } else if (text==='/stats') {
      const s=await getState(USER_ID); if (!s){await sendTelegram('⚠️ No session.',chatId);return;}
      const net=s.bankroll-s.initialBankroll, wr=s.totalCycles>0?((s.successfulCycles/s.totalCycles)*100).toFixed(1):'—';
      const proj=calcProjection(s,s.oddsLog||[]), pl=proj?`\nMonthly: ~₦${proj.monthly.toLocaleString()}`:'';
      await sendTelegram(`📈 <b>CRS Stats</b>\n\n₦${s.initialBankroll.toLocaleString()} → ₦${s.bankroll.toLocaleString()}\nNet: ${net>=0?'+':'−'}₦${Math.abs(net).toLocaleString()}\nStreak: ${s.streak||0} 🔥\n\nCycles: ${s.totalCycles} | Wins: ${s.successfulCycles} | Busts: ${s.busts}\nRecovery: ${s.recoveryWins||0} | Rate: ${wr}%\nAvg odds: ${getRollingAverage(s.oddsLog||[])}${pl}`,chatId);
    } else if (text==='/intel') {
      const s=await getState(USER_ID); if (!s){await sendTelegram('⚠️ No session.',chatId);return;}
      const ol=s.oddsLog||[], avg=getRollingAverage(ol), tr=getOddsTrend(ol);
      const sc=calcAgentScore(s.history,ol), rec=calcRecommendedBankroll(s.bankroll,ol,s.history);
      const te=tr==='up'?'📈 Rising':tr==='down'?'📉 Falling':tr==='stable'?'➡️ Stable':'⏳ Not enough data';
      await sendTelegram(`🧠 <b>CRS Intel</b>\n\nAvg odds: <b>${avg}</b>\nTrend: <b>${te}</b>\nAgent score: <b>${sc!==null?sc+'/100':'—'}</b>\nBets logged: ${ol.length}\n\nRec. bankroll: <b>₦${rec.toLocaleString()}</b>\nCurrent: <b>₦${s.bankroll.toLocaleString()}</b>`,chatId);
    } else if (text==='/pause') {
      const s=await getState(USER_ID); if (!s){await sendTelegram('⚠️ No session.',chatId);return;}
      const np=!s.pauseMode;
      await db.collection(COLLECTION).doc(USER_ID).update({pauseMode:np,pauseStartDate:np?(s.pauseStartDate||todayWAT()):null,lastPauseReminder:np?null:s.lastPauseReminder,updatedAt:new Date().toISOString()});
      await sendTelegram(np?`⏸️ <b>Paused.</b>`:`▶️ <b>Resumed.</b> 💰`,chatId);
    }
  } catch(e) { console.error('[webhook]',e.message); }
});

const APP_SECRET = process.env.APP_SECRET;

// ── Config (custom key override) ────────────────────────────
async function getConfig() {
  try { const d=await db.collection(CONFIG_COL).doc(CONFIG_ID).get(); return d.exists?d.data():null; } catch { return null; }
}
async function isValidKey(key) {
  if (!key) return false;
  const cfg = await getConfig();
  if (cfg?.customKeyHash) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    if (hash === cfg.customKeyHash) return true;
  }
  return APP_SECRET && key === APP_SECRET;
}

app.use('/api', async (req,res,next) => {
  const sess=req.headers['x-crs-session'];
  if (sess) {
    try {
      const result = await verifySession(sess);
      if (result.ok) { req.trackerId = result.trackerId; return next(); }
      return res.status(401).json({error:'Unauthorized'});
    } catch (e) {
      // Firestore error — don't wipe the client session, just fail the request
      console.error('[Auth] Firestore error:', e.message);
      return res.status(503).json({error:'Service temporarily unavailable. Please retry.'});
    }
  }
  if (!APP_SECRET) { console.warn('[AUTH] APP_SECRET not set.'); req.trackerId = USER_ID; return next(); }
  const key=req.headers['x-crs-secret'];
  if (!await isValidKey(key)) return res.status(401).json({error:'Unauthorized'});
  req.trackerId = USER_ID;
  next();
});

app.post('/api/session/create', async (req,res) => {
  const key=req.headers['x-crs-secret'];
  if (!await isValidKey(key)) return res.status(401).json({error:'Unauthorized'});
  try { const token=await createSession(USER_ID); res.json({token,expires:new Date(Date.now()+SESSION_TTL_MS).toISOString()}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ── Change key ───────────────────────────────────────────────
app.put('/api/key', async (req,res) => {
  try {
    const {newKey}=req.body;
    if (!newKey||typeof newKey!=='string'||newKey.length<6) return res.status(400).json({error:'Key must be at least 6 characters.'});
    const hash=crypto.createHash('sha256').update(newKey).digest('hex');
    await db.collection(CONFIG_COL).doc(CONFIG_ID).set({customKeyHash:hash,updatedAt:new Date().toISOString()},{merge:true});
    // Invalidate all existing sessions
    const snap=await db.collection(SESSIONS_COL).limit(200).get();
    if (!snap.empty) { const batch=db.batch(); snap.forEach(d=>batch.delete(d.ref)); await batch.commit(); }
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/session', async (req,res) => { await deleteSession(req.headers['x-crs-session']); res.json({ok:true}); });

// ── Create new independent tracker ────────────────────────────
app.post('/api/tracker/create', async (req,res) => {
  const key=req.headers['x-crs-secret'];
  if (!await isValidKey(key)) return res.status(401).json({error:'Unauthorized'});
  try {
    const {name}=req.body;
    if (!name||typeof name!=='string'||!name.trim()) return res.status(400).json({error:'Tracker name required.'});
    const trackerId='crs_'+crypto.randomBytes(8).toString('hex');
    await db.collection(COLLECTION).doc(trackerId).set({_label:name.trim(),_createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    const token=await createSession(trackerId);
    res.json({trackerId,token,name:name.trim(),expires:new Date(Date.now()+SESSION_TTL_MS).toISOString()});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Tracker info (label) ──────────────────────────────────────
app.get('/api/tracker/info', async (req,res) => {
  try {
    const d=await db.collection(COLLECTION).doc(req.trackerId).get();
    const label=d.exists?(d.data()._label||'Main'):'Main';
    res.json({trackerId:req.trackerId,label});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/state', async (req,res) => {
  try {
    const s=await getState(req.trackerId); if (!s) return res.status(404).json({error:'not_found'});
    const ol=s.oddsLog||[];
    res.json({state:s,intel:{rollingAvg:getRollingAverage(ol),trend:getOddsTrend(ol),agentScore:calcAgentScore(s.history,ol),recommendedBankroll:calcRecommendedBankroll(s.bankroll,ol,s.history),projection:calcProjection(s,ol),betsLogged:ol.length}});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/init', async (req,res) => {
  try {
    const {bankroll}=req.body;
    if (!Number.isInteger(bankroll)||bankroll<2001) return res.status(400).json({error:'Bankroll must be > ₦2,000.'});
    if (await getState(req.trackerId)) return res.status(409).json({error:'State exists. Reset first.'});
    res.status(201).json({state:await saveState(defaultState(bankroll),req.trackerId)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/ticket', async (req,res) => {
  try {
    const {odds}=req.body;
    if (!odds||typeof odds!=='number'||odds<1.01) return res.status(400).json({error:'odds must be >= 1.01'});
    const current=await getState(req.trackerId); if (!current) return res.status(404).json({error:'not_found'});
    if (current.bankroll<=getHardStop(current)) return res.status(422).json({error:'Bankroll at hard stop.'});
    if (current.stakeLocked) return res.status(409).json({error:'Stake locked. Log result first.'});
    if (current.todaySchedule?.date<todayWAT()&&!current.todaySchedule?.resultEntered) return res.status(423).json({error:'pending_result'});
    const {newState,stakeInfo}=applyTicket(current,odds);
    if (!stakeInfo.viable&&current.round>1) {
      newState.busts++; newState.gateBusts=(newState.gateBusts||0)+1; newState.totalCycles++;
      newState.history=[{type:'bust',date:watDateLabel(),cycle:current.cycleNumber,round:current.round,bustType:'gate',stake:stakeInfo.stake,odds,lostTotal:current.lossesAccumulated,bankrollAfter:current.bankroll,desc:`Cycle ${current.cycleNumber} — Gate Bust R${current.round}`},...(newState.history||[])].slice(0,MAX_HISTORY);
      resetCycle(newState); const saved=await saveState(newState,req.trackerId);
      return res.json({state:saved,event:{kind:'bust',bustType:'gate',lostTotal:current.lossesAccumulated,bankroll:current.bankroll,threshold:stakeInfo.threshold},stakeInfo});
    }
    const saved=await saveState(newState,req.trackerId);
    if (current.round===1&&stakeInfo.oddsRatio>=1.30) setImmediate(()=>fireOpportunityAlert(saved,stakeInfo,req.trackerId).catch(console.error));
    if (current.round>1&&(stakeInfo.mode==='recovery'||stakeInfo.mode==='survival')) setImmediate(()=>fireRecoveryEntryAlert(saved,stakeInfo,current.round).catch(console.error));
    res.json({state:saved,stakeInfo});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/result', async (req,res) => {
  try {
    const {outcome}=req.body;
    if (outcome!=='win'&&outcome!=='loss') return res.status(400).json({error:'outcome must be win or loss'});
    const current=await getState(req.trackerId); if (!current) return res.status(404).json({error:'not_found'});
    if (current.bankroll<=getHardStop(current)) return res.status(422).json({error:'Bankroll at hard stop.'});
    if (!current.stakeLocked) return res.status(422).json({error:'Enter ticket odds first.'});
    if (current.todaySchedule?.date<todayWAT()&&!current.todaySchedule?.resultEntered) return res.status(423).json({error:'pending_result'});
    const {newState,event}=outcome==='win'?applyWin(current):applyLoss(current);
    if (newState.todaySchedule?.date===todayWAT()) newState.todaySchedule.resultEntered=true;
    const saved=await saveState(newState,req.trackerId);
    if (event.kind==='win'&&event.winType==='recovery') setImmediate(()=>fireRecoveryWinAlert(saved.bankroll,event).catch(console.error));
    if (event.kind==='loss'||event.kind==='bust') setImmediate(()=>fireLossEncouragement(saved,event).catch(console.error));
    res.json({state:saved,event});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/no-game', async (req,res) => {
  try {
    const current=await getState(req.trackerId); if (!current) return res.status(404).json({error:'not_found'});
    if (current.todaySchedule?.date<todayWAT()&&!current.todaySchedule?.resultEntered) return res.status(423).json({error:'pending_result'});
    res.json({state:await recordNoGame(current,req.trackerId)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/state', async (req,res) => { try { const d=await db.collection(COLLECTION).doc(req.trackerId).get(); const {_label,_createdAt}=d.exists?d.data():{}; await db.collection(COLLECTION).doc(req.trackerId).set({...(_label?{_label}:{}),  ...(_createdAt?{_createdAt}:{}), updatedAt:new Date().toISOString()}); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); } });
app.delete('/api/history', async (req,res) => { try { await db.collection(COLLECTION).doc(req.trackerId).update({history:[],oddsLog:[],updatedAt:new Date().toISOString()}); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); } });

app.post('/api/pause', async (req,res) => {
  try {
    const {pause}=req.body; if (typeof pause!=='boolean') return res.status(400).json({error:'pause must be boolean'});
    const s=await getState(req.trackerId); if (!s) return res.status(404).json({error:'not_found'});
    await db.collection(COLLECTION).doc(req.trackerId).update({pauseMode:pause,pauseStartDate:pause?(s.pauseStartDate||todayWAT()):null,lastPauseReminder:pause?null:s.lastPauseReminder,updatedAt:new Date().toISOString()});
    await sendTelegram(pause?`⏸️ <b>CRS Paused.</b>`:`▶️ <b>CRS Resumed.</b> 💰`);
    res.json({pauseMode:pause});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/schedule', async (req,res) => {
  try {
    const {games}=req.body; if (!Array.isArray(games)||!games.length) return res.status(400).json({error:'games required'});
    const processed=games.map(g=>{const[h,m]=g.startTime.split(':').map(Number);const em=h*60+m+150;return{odds:parseFloat(g.odds),startTime:g.startTime,endTime:`${String(Math.floor(em/60)%24).padStart(2,'0')}:${String(em%60).padStart(2,'0')}`};});
    const schedule={date:todayWAT(),games:processed,oddsResult:calcOdds(processed.map(g=>g.odds)),resultEntered:false,notificationsSent:0,gameNotificationsSent:0};
    await db.collection(COLLECTION).doc(req.trackerId).update({todaySchedule:schedule,updatedAt:new Date().toISOString()});
    const n=processed.length;
    const glMsg = n===1
      ? `🍀 <b>CRS — Good Luck!</b>\n\nYour game is set. Stake your confidence and trust the system. Let's get it. 💰`
      : `🍀 <b>CRS — Good Luck!</b>\n\n${n} games locked in. Trust the process — hope every single one lands. Let's go. 💪`;
    setImmediate(()=>sendTelegram(glMsg).catch(console.error));
    res.json({schedule});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/schedule', async (req,res) => { try { await db.collection(COLLECTION).doc(req.trackerId).update({todaySchedule:null,updatedAt:new Date().toISOString()}); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); } });
app.post('/api/calc-odds', async (req,res) => { try { const {legs}=req.body; if (!Array.isArray(legs)||!legs.length) return res.status(400).json({error:'legs required'}); res.json(calcOdds(legs)); } catch(e) { res.status(500).json({error:e.message}); } });
app.get('/api/intel', async (req,res) => { try { const s=await getState(req.trackerId); if (!s) return res.status(404).json({error:'not_found'}); const ol=s.oddsLog||[]; res.json({rollingAvg:getRollingAverage(ol),trend:getOddsTrend(ol),agentScore:calcAgentScore(s.history,ol),recommendedBankroll:calcRecommendedBankroll(s.bankroll,ol,s.history),projection:calcProjection(s,ol),betsLogged:ol.length}); } catch(e) { res.status(500).json({error:e.message}); } });
app.post('/api/test-notify', async (req,res) => { try { const ok=await sendTelegram(`🔔 <b>CRS v3.0 Test</b>\n\nTelegram working.\n/status · /stats · /intel · /pause`); ok?res.json({ok:true}):res.status(500).json({error:'Failed'}); } catch(e) { res.status(500).json({error:e.message}); } });

function startScheduler() {
  cron.schedule('0 7 * * *',    ()=>runNotification('morning1'));
  cron.schedule('0 9 * * *',    ()=>runNotification('morning2'));
  cron.schedule('0 12 * * *',   ()=>runNotification('midday'));
  cron.schedule('0 18 * * *',   ()=>runNotification('evening1'));
  cron.schedule('0 21 * * *',   ()=>runNotification('evening2'));
  cron.schedule('*/15 * * * *', ()=>runGameEndChecker());
  cron.schedule('59 23 * * *',  ()=>runMidnightChecker());
  cron.schedule('0 8 */2 * *',  ()=>runNoSessionReminder());
  cron.schedule('0 9 * * *',    ()=>runPauseNotification());
  cron.schedule('0 7 * * 0',    ()=>runWeeklySummary());
  cron.schedule('0 3 * * 0',    ()=>cleanExpiredSessions());
  console.log('[CRS v3.0] Scheduler active');
}

app.listen(PORT, () => {
  console.log(`[CRS v3.0 ADAPTATION] Port ${PORT}`);
  APP_SECRET?console.log('[CRS v3.0] ✅ Auth + Sessions enabled.'):console.warn('[CRS v3.0] ⚠️  APP_SECRET not set.');
  startScheduler();
});
