/**
 * Cavas Voice Demo (2 modes + Hindi/English auto-switch for hospital)
 * FIXES in this version:
 *  ✅ Prevent "stuck at name/phone" by globally extracting name/phone from ANY utterance
 *  ✅ Proper NEW booking flow: ask department/doctor first (unless already collected)
 *  ✅ If user gives name+phone in one line, we capture it and move ahead
 *  ✅ Hindi mode = fully Hindi (Devanagari) but doctor names remain English (Dr Neha Sharma)
 *  ✅ Confirmation uses ONE preferred time (no conflicting time)
 *  ✅ OpenAI polish disabled by default to avoid repetitive / wrong prompts
 */

import express from "express";
import twilio from "twilio";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.urlencoded({ extended: false }));

const MODE = (process.env.MODE || "education").toLowerCase();
const HOSPITAL_NAME = process.env.HOSPITAL_NAME || "Medanta";
const AGENT_NUMBER = process.env.HOSPITAL_AGENT_NUMBER || "";
const BASE_URL = process.env.BASE_URL || "https://cavas-voice-demo.onrender.com";

// ✅ default OFF so it cannot mess the flow
const ENABLE_POLISH = String(process.env.ENABLE_POLISH || "").toLowerCase() === "true";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------------------
// Persistence (simple JSON file)
// ------------------------------
const PERSIST_PATH = path.join(process.cwd(), "transcripts.json");

function loadPersisted() {
  try {
    if (!fs.existsSync(PERSIST_PATH)) return {};
    const raw = fs.readFileSync(PERSIST_PATH, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function savePersisted(obj) {
  try {
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("Persist write failed:", e?.message);
  }
}
const persisted = loadPersisted(); // { [callSid]: { meta, transcript } }

// ------------------------------
// In-memory stores (fast)
// ------------------------------
const convoStore = new Map();       // education history
const transcriptStore = new Map();  // callSid -> transcript[]
const sessionStore = new Map();     // callSid -> { mode, state, lang, data }
const callMetaStore = new Map();    // callSid -> { ts, mode, lang, from, to }
const recentCalls = [];             // most recent first, max 20

// ------------------------------
// LIVE SSE listeners (Option A)
// callSid -> Set(res)
// ------------------------------
const liveListeners = new Map();

function pushLive(callSid, event) {
  const set = liveListeners.get(callSid);
  if (!set) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch {}
  }
}

function rememberCall(callSid, patch = {}) {
  if (!callSid) return;
  const prev = callMetaStore.get(callSid) || { ts: new Date().toISOString() };
  const next = { ...prev, ...patch };
  callMetaStore.set(callSid, next);

  persisted[callSid] = persisted[callSid] || { meta: {}, transcript: [] };
  persisted[callSid].meta = { ...(persisted[callSid].meta || {}), ...next };
  savePersisted(persisted);

  const idx = recentCalls.indexOf(callSid);
  if (idx >= 0) recentCalls.splice(idx, 1);
  recentCalls.unshift(callSid);
  while (recentCalls.length > 20) recentCalls.pop();
}

function pushTranscript(callSid, role, content) {
  if (!callSid) return;

  const item = { ts: new Date().toISOString(), role, content };

  const arr = transcriptStore.get(callSid) || [];
  arr.push(item);
  transcriptStore.set(callSid, arr);

  persisted[callSid] = persisted[callSid] || { meta: {}, transcript: [] };
  persisted[callSid].transcript = arr;
  savePersisted(persisted);

  pushLive(callSid, { type: "transcript", callSid, item });
}

function getTranscript(callSid) {
  const mem = transcriptStore.get(callSid);
  if (mem?.length) return mem;
  const disk = persisted?.[callSid]?.transcript;
  return disk || [];
}

function getHistory(callSid) {
  return convoStore.get(callSid) || [];
}
function pushHistory(callSid, role, content) {
  if (!callSid) return;
  const arr = convoStore.get(callSid) || [];
  arr.push({ role, content });
  while (arr.length > 10) arr.shift();
  convoStore.set(callSid, arr);
}

function getSession(callSid) {
  const s = sessionStore.get(callSid);
  if (s) return s;
  const fresh = { mode: MODE, state: "NEW", lang: null, data: {} };
  sessionStore.set(callSid, fresh);
  return fresh;
}
function setSession(callSid, patch) {
  const s = getSession(callSid);
  const next = {
    ...s,
    ...patch,
    data: { ...(s.data || {}), ...(patch.data || {}) },
  };
  sessionStore.set(callSid, next);
  rememberCall(callSid, { mode: next.mode, lang: next.lang });
  return next;
}

// ------------------------------
// Language helpers
// ------------------------------
function normalize(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function containsDevanagari(text) {
  return /[\u0900-\u097F]/.test(String(text || ""));
}
function detectLangPreference(text) {
  const t = normalize(text);
  if (containsDevanagari(text)) return "hi-IN";
  if (t.includes("hindi") || t.includes("हिंदी") || t.includes("हिन्दी")) return "hi-IN";
  if (t.includes("english") || t.includes("अंग्रेजी")) return "en-IN";
  return null;
}
function getSttLang(callSid) {
  const s = getSession(callSid);
  if ((s.mode || MODE) === "hospital") return s.lang || "en-IN";
  return "en-US";
}
function isHi(callSid) {
  return getSttLang(callSid) === "hi-IN";
}
function t(callSid, en, hi) {
  return isHi(callSid) ? hi : en;
}

// ------------------------------
// ElevenLabs TTS
// ------------------------------
function getVoiceIdForLang(lang) {
  const fallback = process.env.ELEVEN_VOICE_ID;
  if (lang === "hi-IN") return process.env.ELEVEN_VOICE_ID_HI || fallback;
  return process.env.ELEVEN_VOICE_ID_EN || fallback;
}
async function elevenTTS(text, lang = "en-IN") {
  const voiceId = getVoiceIdForLang(lang);
  const r = await axios({
    method: "POST",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    headers: {
      "xi-api-key": process.env.ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    data: {
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    responseType: "arraybuffer",
  });
  return Buffer.from(r.data);
}

app.get("/tts", async (req, res) => {
  try {
    const text = String(req.query.text || "");
    const lang = String(req.query.lang || "en-IN");
    const audio = await elevenTTS(text, lang);
    res.set("Content-Type", "audio/mpeg");
    res.set("Cache-Control", "no-store");
    res.send(audio);
  } catch (e) {
    console.error("/tts failed:", e?.message);
    res.status(500).send("TTS failed");
  }
});

app.get("/", (_, res) => res.send(`Cavas Voice Demo is running ✅ (MODE=${MODE})`));

// =========================================================
// LIVE UI + SSE (Option A)
// =========================================================
app.get("/live/:callSid", (req, res) => {
  const { callSid } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const set = liveListeners.get(callSid) || new Set();
  set.add(res);
  liveListeners.set(callSid, set);

  const existing = getTranscript(callSid);
  res.write(`data: ${JSON.stringify({ type: "init", callSid, transcript: existing })}\n\n`);

  req.on("close", () => {
    const s = liveListeners.get(callSid);
    if (s) {
      s.delete(res);
      if (s.size === 0) liveListeners.delete(callSid);
    }
  });
});

app.get("/ui/:callSid", (req, res) => {
  const { callSid } = req.params;
  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Live Transcript - ${callSid}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; padding:16px; background:#fafafa;}
    #wrap{max-width:980px; margin:0 auto;}
    .card{background:#fff; border:1px solid #eee; border-radius:14px; padding:14px; box-shadow:0 1px 6px rgba(0,0,0,.05);}
    .meta{display:flex; gap:10px; flex-wrap:wrap; font-size:14px; color:#333;}
    .pill{background:#f1f5f9; padding:6px 10px; border-radius:999px;}
    .links a{margin-right:10px; text-decoration:none; font-weight:600;}
    .row{padding:10px 12px; border-bottom:1px solid #f0f0f0;}
    .u{background:#f7fbff;}
    .a{background:#f7fff7;}
    .ts{color:#666; font-size:12px;}
    .role{font-weight:800; margin-right:8px;}
    #log{margin-top:12px; overflow:auto;}
    .status{font-size:13px; color:#666;}
  </style>
</head>
<body>
  <div id="wrap">
    <div class="card">
      <div style="font-size:18px; font-weight:800;">Live Transcript</div>
      <div class="meta" style="margin-top:6px;">
        <div class="pill"><b>CallSid:</b> ${callSid}</div>
        <div class="pill status" id="status">Connecting…</div>
      </div>
      <div class="links" style="margin-top:10px;">
        <a href="/transcript/${callSid}" target="_blank">Transcript JSON</a>
        <a href="/call-summary/${callSid}" target="_blank">Summary JSON</a>
        <a href="/calls" target="_blank">Calls</a>
      </div>
    </div>

    <div class="card" id="log" style="margin-top:12px;"></div>
  </div>

<script>
  const log = document.getElementById('log');
  const statusEl = document.getElementById('status');

  function esc(s){
    return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function addLine(item){
    const div = document.createElement('div');
    div.className = 'row ' + (item.role === 'user' ? 'u' : 'a');
    div.innerHTML =
      '<div class="ts">'+esc(item.ts)+'</div>' +
      '<div><span class="role">'+esc(item.role.toUpperCase())+':</span>' +
      '<span>'+ esc(item.content || '') +'</span></div>';
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  const es = new EventSource('/live/${callSid}');
  es.onopen = () => statusEl.textContent = "Live connected ✅";
  es.onerror = () => statusEl.textContent = "Disconnected (refresh page)";

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      log.innerHTML = '';
      (msg.transcript || []).forEach(addLine);
    }
    if (msg.type === 'transcript') addLine(msg.item);
  };
</script>
</body>
</html>
  `);
});

// =========================================================
// EDUCATION MODE
// =========================================================
async function getAIAnswerEducation(callSid, userText) {
  const history = getHistory(callSid);

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: "You are Cavas AI admissions assistant. Answer clearly in 1–3 sentences. Maintain conversation context." },
      ...history,
      { role: "user", content: userText },
    ],
  });

  const answer = completion.choices?.[0]?.message?.content?.trim() || "Sorry, I could not answer that.";

  pushHistory(callSid, "user", userText);
  pushHistory(callSid, "assistant", answer);

  pushTranscript(callSid, "user", userText);
  pushTranscript(callSid, "assistant", answer);

  return { say: answer, transfer: false };
}

// =========================================================
// HOSPITAL MODE
// =========================================================
const DOCTORS = [
  { id: "D001", name: "Dr Arjun Mehta", dept: "Cardiology", location: "Gurgaon", nextSlots: ["Tomorrow 5 PM", "Day after tomorrow 11 AM", "Friday 4 PM"] },
  { id: "D002", name: "Dr Neha Sharma", dept: "Cardiology", location: "Gurgaon", nextSlots: ["Tomorrow 12 PM", "Thursday 6 PM"] },
  { id: "D003", name: "Dr Rohan Kapoor", dept: "Orthopedics", location: "Gurgaon", nextSlots: ["Tomorrow 3 PM", "Saturday 10 AM"] },
  { id: "D004", name: "Dr Simran Kaur", dept: "ENT", location: "Gurgaon", nextSlots: ["Tomorrow 1 PM", "Friday 2 PM"] },
];

const DEPARTMENTS = ["Cardiology", "Orthopedics", "ENT", "Neurology", "Oncology", "Dermatology", "Gastroenterology"];

function extractPhone(text) {
  const t = String(text || "");
  const m = t.match(/(\+?\d[\d\s-]{9,}\d)/) || t.match(/(\d{10})/);
  return m ? m[1].replace(/\s|-/g, "") : null;
}

// ✅ NEW: extract patient name from “name Rohit … phone …” etc.
function extractName(text) {
  const raw = String(text || "").trim();

  // name is Rohit / name Rohit
  const m1 = raw.match(/\bname\s*(is)?\s*[:\-]?\s*([A-Za-z][A-Za-z .]{1,40})\b/i);
  if (m1?.[2]) return m1[2].trim();

  // patient name Rohit
  const m2 = raw.match(/\bpatient\s*name\s*(is)?\s*[:\-]?\s*([A-Za-z][A-Za-z .]{1,40})\b/i);
  if (m2?.[2]) return m2[2].trim();

  return null;
}

// ✅ NEW: global capture (so we never get stuck asking again)
function captureNamePhone(callSid, utterance) {
  const phone = extractPhone(utterance);
  const name = extractName(utterance);

  const s = getSession(callSid);
  const patch = {};
  if (phone && !s.data?.phone) patch.phone = phone;
  if (name && !s.data?.patientName) patch.patientName = name;

  if (Object.keys(patch).length) setSession(callSid, { data: patch });
}

function detectDept(text) {
  const tNorm = normalize(text);
  const aliases = [
    { k: ["cardio", "cardiology", "heart", "cardiologist"], v: "Cardiology" },
    { k: ["ortho", "orthopedic", "orthopedics", "bones", "bone"], v: "Orthopedics" },
    { k: ["ent", "ear", "nose", "throat"], v: "ENT" },
    { k: ["neuro", "neurology", "brain"], v: "Neurology" },
    { k: ["onco", "oncology", "cancer"], v: "Oncology" },
    { k: ["derma", "dermatology", "skin"], v: "Dermatology" },
    { k: ["gastro", "gastroenterology", "stomach"], v: "Gastroenterology" },
  ];
  for (const a of aliases) if (a.k.some((kw) => tNorm.includes(kw))) return a.v;
  const direct = DEPARTMENTS.find((d) => tNorm.includes(normalize(d)));
  return direct || null;
}

function listDoctorsByDept(dept, location = "Gurgaon") {
  return DOCTORS.filter((x) => normalize(x.dept) === normalize(dept) && normalize(x.location) === normalize(location));
}

function findDoctorByName(query) {
  const q = normalize(query).replace(/^dr\.?\s*/i, "");
  if (!q) return [];
  return DOCTORS.filter((d) => normalize(d.name).includes(q)).slice(0, 5);
}

function wantsHuman(text) {
  const tNorm = normalize(text);
  return ["human","agent","representative","operator","real person","connect me","transfer","talk to someone","call center","agent se","representative se","human se"].some((k) => tNorm.includes(k));
}

function looksLikeMedicalAdvice(text) {
  const tNorm = normalize(text);
  const risky = ["fever","pain","chest pain","breath","bp","blood pressure","diagnose","diagnosis","treatment","medicine","tablet","dose","emergency","vomit","bleeding","pregnant","pregnancy","heart attack","stroke","bukhar","dard","saans","dabav","dawai","emergency"];
  return risky.some((k) => tNorm.includes(k));
}

// ✅ NEW: detect booking intent so NEW state doesn’t wander
function looksLikeBookingIntent(text) {
  const tNorm = normalize(text);
  return [
    "appointment", "book", "booking", "schedule",
    "apartment", // users say this in STT
    "अपॉइंटमेंट", "बुक", "कल", "aaj", "kal", "parso",
    "milna", "doctor se", "consult"
  ].some((k) => tNorm.includes(normalize(k)));
}

function slotToHindi(slot) {
  let s = String(slot || "").trim();
  if (!s) return s;

  s = s
    .replace(/day after tomorrow/gi, "परसों")
    .replace(/\btomorrow\b/gi, "कल")
    .replace(/\btoday\b/gi, "आज")
    .replace(/\bthursday\b/gi, "गुरुवार")
    .replace(/\bfriday\b/gi, "शुक्रवार")
    .replace(/\bsaturday\b/gi, "शनिवार")
    .replace(/\bsunday\b/gi, "रविवार")
    .replace(/\bmonday\b/gi, "सोमवार")
    .replace(/\btuesday\b/gi, "मंगलवार")
    .replace(/\bwednesday\b/gi, "बुधवार");

  s = s.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|a\.m\.)\b/gi, (_, hh, mm) => {
    const m = mm ? `:${mm}` : "";
    return `सुबह ${hh}${m} बजे`;
  });

  s = s.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(pm|p\.m\.)\b/gi, (_, hh, mm) => {
    const h = Number(hh);
    const m = mm ? `:${mm}` : "";
    if (h === 12) return `दोपहर 12${m} बजे`;
    if (h >= 1 && h <= 4) return `दोपहर ${h}${m} बजे`;
    if (h >= 5 && h <= 7) return `शाम ${h}${m} बजे`;
    return `रात ${h}${m} बजे`;
  });

  return s;
}

function pickSlots(callSid, d) {
  const slots = (d.nextSlots || []).slice(0, 3);
  if (!slots.length) return isHi(callSid) ? "अगले उपलब्ध स्लॉट बुकिंग टीम साझा करेगी।" : "Next available slots will be shared by the booking team.";
  return isHi(callSid)
    ? `अगले उपलब्ध स्लॉट: ${slots.map(slotToHindi).join(", ")}।`
    : `Next available: ${slots.join(", ")}.`;
}

function extractPreferredTime(text) {
  const raw = String(text || "").trim();
  const tNorm = normalize(raw);

  const timeWords = ["morning", "evening", "afternoon", "night", "a.m.", "p.m.", "am", "pm", "subah", "shaam", "dopahar", "raat", "सुबह", "शाम", "दोपहर", "रात"];
  const dayWords = ["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "aaj", "kal", "parso", "आज", "कल", "परसों"];

  const hasDay = dayWords.some((d) => tNorm.includes(normalize(d)));
  const hasTimeWord = timeWords.some((w) => tNorm.includes(normalize(w)));
  const hasClock = /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\b/i.test(raw) || /\b\d{1,2}(:\d{2})\b/.test(raw);

  if (!(hasDay || hasTimeWord || hasClock)) return null;

  const m =
    raw.match(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|aaj|kal|parso|आज|कल|परसों)\b[^.]{0,40}/i) ||
    raw.match(/\b(morning|evening|afternoon|night|subah|shaam|dopahar|raat|सुबह|शाम|दोपहर|रात)\b/i);

  return (m?.[0] || raw).trim();
}

// ---------------------------------------------------------
// polish (optional)
// ---------------------------------------------------------
async function hospitalPolish(callSid, raw) {
  if (!ENABLE_POLISH) return raw;
  if (!process.env.OPENAI_API_KEY) return raw;

  // safety: do not polish critical collection prompts
  const lower = String(raw || "").toLowerCase();
  const skip =
    lower.includes("full name") ||
    lower.includes("mobile") ||
    lower.includes("10-digit") ||
    lower.includes("phone") ||
    lower.includes("patient") ||
    lower.includes("कृपया") ||
    lower.includes("मोबाइल") ||
    lower.includes("अंकों");

  if (skip) return raw;

  const style = isHi(callSid)
    ? "उत्तर केवल शुद्ध हिंदी (देवनागरी) में दें। डॉक्टर के नाम अंग्रेज़ी में ही रखें। 1–2 छोटे वाक्य।"
    : "Reply in friendly English like a hospital front-desk. 1–2 short sentences.";

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: `You are a hospital appointment and routing voice assistant for ${HOSPITAL_NAME}. No medical advice. ${style}` },
        { role: "user", content: raw },
      ],
    });
    const out = completion.choices?.[0]?.message?.content?.trim();
    return out || raw;
  } catch {
    return raw;
  }
}

async function buildConfirmation(callSid, preferredTimeOverride = null) {
  const session = getSession(callSid);
  const { patientName, phone, doctorName, dept } = session.data || {};
  const preferredTime = (preferredTimeOverride || session.data?.preferredTime || "").trim();

  const confirmationId = `APT-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
  setSession(callSid, { state: "CONFIRMED", data: { preferredTime, confirmationId } });

  const base = isHi(callSid)
    ? `ठीक है। आपकी अपॉइंटमेंट रिक्वेस्ट दर्ज हो गई है। ${patientName ? `मरीज़: ${patientName}. ` : ""}${doctorName ? `डॉक्टर: ${doctorName}. ` : dept ? `विभाग: ${dept}. ` : ""}${preferredTime ? `पसंदीदा समय: ${preferredTime}. ` : ""}कन्फर्मेशन आईडी: ${confirmationId}. ${phone ? `कन्फर्मेशन ${phone} पर भेजा जाएगा।` : "कन्फर्मेशन आपके नंबर पर भेजा जाएगा।"}`
    : `Done. I’ve raised an appointment request for ${patientName || "the patient"} ${doctorName ? `with ${doctorName}` : ""}${dept ? ` in ${dept}` : ""}. ${preferredTime ? `Preferred time: ${preferredTime}. ` : ""}Confirmation ID is ${confirmationId}. You will receive confirmation on ${phone || "your number"}.`;

  const say = await hospitalPolish(callSid, base);
  pushTranscript(callSid, "assistant", say);
  return { say, transfer: false };
}

async function getAIAnswerHospital(callSid, userText) {
  const session = getSession(callSid);
  const tRaw = userText.trim();
  const norm = normalize(tRaw);

  pushTranscript(callSid, "user", tRaw);

  // ✅ lock Hindi if user uses Devanagari or says Hindi
  const pref = detectLangPreference(tRaw);
  if (pref) setSession(callSid, { lang: pref });

  // ✅ IMPORTANT: capture name/phone from ANY utterance (prevents loop)
  captureNamePhone(callSid, tRaw);

  if (wantsHuman(tRaw) || looksLikeMedicalAdvice(tRaw)) {
    const say = await hospitalPolish(callSid, t(callSid, "Sure. I’m connecting you to a human representative now.", "ज़रूर। मैं आपको अभी एक मानव प्रतिनिधि से जोड़ रहा/रही हूँ।"));
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: true };
  }

  // -----------------------
  // NEW booking flow
  // -----------------------
  if (session.state === "NEW") {
    const dept = detectDept(tRaw);
    const hasDr = norm.includes("dr ") || norm.includes("dr.") || norm.includes("doctor ");
    const time = extractPreferredTime(tRaw);

    // if user already said time, store it (but don’t confirm without doctor/dept)
    if (time && !session.data?.preferredTime) setSession(callSid, { data: { preferredTime: time } });

    // If they mentioned a department/doctor, proceed as usual (below routing handles it)
    if (!dept && !hasDr) {
      // If they have booking intent, ask dept/doctor (NOT name/phone)
      if (looksLikeBookingIntent(tRaw)) {
        const msg = t(
          callSid,
          `Sure. Which department do you need? For example Cardiology, Orthopedics or ENT. Or say “Dr” and the doctor’s name.`,
          `ज़रूर। आपको किस विभाग में अपॉइंटमेंट चाहिए? जैसे कार्डियोलॉजी, ऑर्थोपेडिक्स या ईएनटी। या “Dr” बोलकर डॉक्टर का नाम बताइए।`
        );
        const say = await hospitalPolish(callSid, msg);
        pushTranscript(callSid, "assistant", say);
        return { say, transfer: false };
      }

      // Not booking intent: gently route back
      const msg = t(
        callSid,
        `I can help with appointments at ${HOSPITAL_NAME}. Please say the department (like Cardiology) or the doctor’s name.`,
        `मैं ${HOSPITAL_NAME} में अपॉइंटमेंट में मदद कर सकता/सकती हूँ। कृपया विभाग (जैसे कार्डियोलॉजी) या डॉक्टर का नाम बताइए।`
      );
      const say = await hospitalPolish(callSid, msg);
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }
    // else continue to routing section below
  }

  // -----------------------
  // State machine (collection)
  // -----------------------
  if (session.state === "COLLECT_NAME") {
    // if they said phone+name already, don’t re-ask
    const s2 = getSession(callSid);
    if (s2.data?.patientName && s2.data?.phone) {
      // if time present too -> confirm
      const time = s2.data?.preferredTime || extractPreferredTime(tRaw) || "";
      if (time) return buildConfirmation(callSid, time);

      setSession(callSid, { state: "COLLECT_TIME" });
      const say = await hospitalPolish(callSid, t(callSid, "Great. What day or time do you prefer?", "बहुत बढ़िया। आप किस दिन या किस समय आना चाहेंगे?"));
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    if (!getSession(callSid).data?.patientName) {
      const say = await hospitalPolish(callSid, t(callSid, "Please tell me the patient’s full name.", "कृपया मरीज़ का पूरा नाम बताइए।"));
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    setSession(callSid, { state: "COLLECT_PHONE" });
    const say = await hospitalPolish(callSid, t(callSid, "Thanks. Please tell me your 10-digit mobile number for confirmation.", "धन्यवाद। कन्फर्मेशन के लिए अपना 10 अंकों का मोबाइल नंबर बताइए।"));
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  if (session.state === "COLLECT_PHONE") {
    if (!getSession(callSid).data?.phone) {
      const say = await hospitalPolish(callSid, t(callSid, "Sorry, I didn’t catch the number. Please say the 10-digit mobile number again.", "माफ़ कीजिए, नंबर साफ़ नहीं मिला। कृपया 10 अंकों का मोबाइल नंबर दोबारा बताइए।"));
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    const alreadyTime = (getSession(callSid).data?.preferredTime || "").trim();
    if (alreadyTime) return buildConfirmation(callSid, alreadyTime);

    setSession(callSid, { state: "COLLECT_TIME" });
    const say = await hospitalPolish(callSid, t(callSid, "Great. What day or time do you prefer? For example, tomorrow evening or Friday morning.", "बहुत बढ़िया। आप किस दिन या किस समय आना चाहेंगे? जैसे कल शाम या शुक्रवार सुबह।"));
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  if (session.state === "COLLECT_TIME") {
    const time = extractPreferredTime(tRaw) || tRaw;
    setSession(callSid, { data: { preferredTime: time } });
    return buildConfirmation(callSid, time);
  }

  // -----------------------
  // Routing logic
  // -----------------------
  const dept = detectDept(tRaw);
  const hasDr = norm.includes("dr ") || norm.includes("dr.") || norm.includes("doctor ");

  if (hasDr) {
    let q = tRaw;
    const idx = norm.indexOf("dr");
    const idx2 = norm.indexOf("doctor");
    if (idx2 >= 0) q = tRaw.slice(idx2 + "doctor".length).trim();
    else if (idx >= 0) q = tRaw.slice(idx + 2).trim();

    const matches = findDoctorByName(q);

    if (matches.length === 1) {
      const d = matches[0];
      setSession(callSid, { state: "COLLECT_NAME", data: { doctorName: d.name, dept: d.dept } });

      const msg = isHi(callSid)
        ? `ठीक है। ${d.name} ${d.dept} विभाग में हैं। ${pickSlots(callSid, d)} बुक करने के लिए कृपया मरीज़ का पूरा नाम बताइए।`
        : `Sure. ${d.name} is in ${d.dept}. ${pickSlots(callSid, d)} To book, please tell me the patient’s full name.`;

      const say = await hospitalPolish(callSid, msg);
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    const say = await hospitalPolish(callSid, t(callSid, "I couldn’t find that doctor. Please say the department.", "माफ़ कीजिए, वह डॉक्टर नहीं मिला। कृपया विभाग बताइए।"));
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  if (dept) {
    const docs = listDoctorsByDept(dept, "Gurgaon");
    if (!docs.length) {
      const say = await hospitalPolish(callSid, t(callSid, `I don’t have doctors listed for ${dept}. Would you like to connect to an agent?`, `इस समय ${dept} के डॉक्टरों की सूची उपलब्ध नहीं है। क्या आप एजेंट से बात करना चाहेंगे?`));
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    setSession(callSid, { state: "ASK_BOOK_OR_LIST_MORE", data: { dept } });
    const names = docs.slice(0, 3).map((d, i) => `${d.name} (${i + 1})`).join(", ");

    const msg = isHi(callSid)
      ? `${dept} के डॉक्टर हैं: ${names}। आप किससे अपॉइंटमेंट लेना चाहेंगे? आप डॉक्टर का नाम या 1/2 बोल सकते हैं।`
      : `${dept} doctors include ${names}. Which one would you like to book? You can say the doctor’s name or 1/2.`;

    const say = await hospitalPolish(callSid, msg);
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  if (session.state === "ASK_BOOK_OR_LIST_MORE") {
    const num = parseInt(norm, 10);
    if (!Number.isNaN(num)) {
      const deptSaved = session.data?.dept;
      const docs = deptSaved ? listDoctorsByDept(deptSaved, "Gurgaon") : [];
      const d = docs[num - 1];
      if (d) {
        setSession(callSid, { state: "COLLECT_NAME", data: { doctorName: d.name, dept: d.dept } });
        const msg = isHi(callSid)
          ? `ठीक है। ${d.name}। ${pickSlots(callSid, d)} बुक करने के लिए कृपया मरीज़ का पूरा नाम बताइए।`
          : `Sure. ${d.name}. ${pickSlots(callSid, d)} To book, please tell me the patient’s full name.`;
        const say = await hospitalPolish(callSid, msg);
        pushTranscript(callSid, "assistant", say);
        return { say, transfer: false };
      }
    }

    const matches = findDoctorByName(tRaw);
    if (matches.length === 1) {
      const d = matches[0];
      setSession(callSid, { state: "COLLECT_NAME", data: { doctorName: d.name, dept: d.dept } });
      const msg = isHi(callSid)
        ? `ठीक है। ${d.name}। ${pickSlots(callSid, d)} बुक करने के लिए कृपया मरीज़ का पूरा नाम बताइए।`
        : `Sure. ${d.name}. ${pickSlots(callSid, d)} To book, please tell me the patient’s full name.`;
      const say = await hospitalPolish(callSid, msg);
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    const say = await hospitalPolish(callSid, t(callSid, "Please say the full doctor name (or 1/2), or say agent.", "कृपया डॉक्टर का पूरा नाम (या 1/2) बताइए, या ‘एजेंट’ बोलिए।"));
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  const say = await hospitalPolish(callSid, t(callSid, `I can help with appointments at ${HOSPITAL_NAME}. Say a department like cardiology, or say Dr followed by the doctor’s name, or say agent.`, `मैं ${HOSPITAL_NAME} में अपॉइंटमेंट में मदद कर सकता/सकती हूँ। विभाग बोलिए जैसे कार्डियोलॉजी, या “Dr” के साथ डॉक्टर का नाम, या “एजेंट”।`));
  pushTranscript(callSid, "assistant", say);
  return { say, transfer: false };
}

async function getAIAnswer(callSid, userText) {
  const session = getSession(callSid);
  return (session.mode || MODE) === "hospital"
    ? getAIAnswerHospital(callSid, userText)
    : getAIAnswerEducation(callSid, userText);
}

// =========================================================
// Twilio routes
// =========================================================
function gatherBlock(twiml, callSid, actionPath) {
  const sttLang = getSttLang(callSid);
  return twiml.gather({
    input: "speech",
    bargeIn: true,
    language: sttLang,
    speechTimeout: "auto",
    timeout: 6,
    actionOnEmptyResult: true,
    action: `${BASE_URL}${actionPath}`,
    method: "POST",
  });
}

app.post("/welcome", (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const from = req.body.From || null;
    const to = req.body.To || null;

    const modeFromQuery = (req.query.mode || "").toString().toLowerCase();
    const mode = modeFromQuery === "hospital" || modeFromQuery === "education" ? modeFromQuery : MODE;

    rememberCall(callSid, { ts: new Date().toISOString(), from, to, mode });

    setSession(callSid, { mode, state: "NEW", lang: mode === "hospital" ? "en-IN" : null, data: {} });

    const greeting =
      mode === "hospital"
        ? `नमस्ते! आपने ${HOSPITAL_NAME} अपॉइंटमेंट सहायता (Cavas AI) पर कॉल किया है। आप हिंदी या अंग्रेज़ी में बोल सकते हैं। आपकी कैसे मदद करूँ? Hello! You’ve reached ${HOSPITAL_NAME} appointment assistance by Cavas AI. You can speak in Hindi or English. How can I help?`
        : "Hello! Welcome to Cavas AI admissions assistant. How can I help you today?";

    const sttLang = getSttLang(callSid);
    const gather = gatherBlock(twiml, callSid, "/handle-input");
    gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(greeting)}`);

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("/welcome error:", e);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. Please try again.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

app.post("/handle-input", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;

  try {
    const speech = (req.body.SpeechResult || "").trim();

    if (!speech) {
      const sttLang = getSttLang(callSid);
      const gather = gatherBlock(twiml, callSid, "/handle-followup");
      const msg = sttLang === "hi-IN"
        ? "माफ़ कीजिए, आवाज़ साफ़ नहीं आई। कृपया दोबारा बोलिए।"
        : "Sorry, I didn’t catch that. Please say it again.";
      gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(msg)}`);
      return res.type("text/xml").send(twiml.toString());
    }

    const pref = detectLangPreference(speech);
    if (pref) setSession(callSid, { lang: pref });

    const result = await getAIAnswer(callSid, speech);
    const sttLang = getSttLang(callSid);

    twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(result.say)}`);

    if (result.transfer) {
      if (!AGENT_NUMBER) {
        const msg = sttLang === "hi-IN"
          ? "फिलहाल ट्रांसफर की सुविधा उपलब्ध नहीं है। कृपया बाद में कोशिश करें।"
          : "Transfer is not configured right now. Please try again later.";
        twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(msg)}`);
        twiml.hangup();
        return res.type("text/xml").send(twiml.toString());
      }
      twiml.dial(AGENT_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    const mode = (getSession(callSid)?.mode || MODE);
    const gather = gatherBlock(twiml, callSid, "/handle-followup");

    if (mode === "education") {
      gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Would you like to ask another question? You can ask now or say no.")}`);
    } else {
      const shortPrompt = sttLang === "hi-IN" ? "क्या आपको और कुछ चाहिए?" : "Anything else?";
      gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(shortPrompt)}`);
    }

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("/handle-input error callSid=", callSid, e);
    const sttLang = getSttLang(callSid);
    const msg = sttLang === "hi-IN"
      ? "माफ़ कीजिए, तकनीकी समस्या आ गई। कृपया दोबारा कोशिश करें।"
      : "Sorry, I faced a technical issue. Please try again.";
    twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(msg)}`);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

app.post("/handle-followup", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;

  try {
    const raw = (req.body.SpeechResult || "").trim();
    const speechLower = raw.toLowerCase();

    const pref = detectLangPreference(raw);
    if (pref) setSession(callSid, { lang: pref });

    const sttLang = getSttLang(callSid);
    const mode = (getSession(callSid)?.mode || MODE);

    if (!raw) {
      const gather = gatherBlock(twiml, callSid, "/handle-followup");
      const msg = sttLang === "hi-IN" ? "माफ़ कीजिए, कृपया दोबारा बोलिए।" : "Sorry, please say that again.";
      gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(msg)}`);
      return res.type("text/xml").send(twiml.toString());
    }

    const endWords = ["no", "bye", "thanks", "thank you", "that is all", "nahi", "nahin", "bas", "theek hai", "ok bye"];
    if (endWords.some((w) => speechLower.includes(w))) {
      const bye = sttLang === "hi-IN" ? "धन्यवाद। अलविदा।" : "Thank you for calling. Goodbye.";
      twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(bye)}`);
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    const result = await getAIAnswer(callSid, raw);
    twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(result.say)}`);

    if (result.transfer) {
      if (!AGENT_NUMBER) {
        const msg = sttLang === "hi-IN"
          ? "फिलहाल ट्रांसफर की सुविधा उपलब्ध नहीं है। कृपया बाद में कोशिश करें।"
          : "Transfer is not configured right now. Please try again later.";
        twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(msg)}`);
        twiml.hangup();
        return res.type("text/xml").send(twiml.toString());
      }
      twiml.dial(AGENT_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    const gather = gatherBlock(twiml, callSid, "/handle-followup");
    if (mode === "education") {
      gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Anything else you would like to know?")}`);
    } else {
      const shortPrompt = sttLang === "hi-IN" ? "क्या आपको और कुछ चाहिए?" : "Anything else?";
      gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(shortPrompt)}`);
    }

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("/handle-followup error callSid=", callSid, e);
    const sttLang = getSttLang(callSid);
    const msg = sttLang === "hi-IN" ? "माफ़ कीजिए, तकनीकी समस्या है। कृपया दोबारा कोशिश करें।" : "Sorry, technical issue. Please try again.";
    twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(msg)}`);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

// =========================================================
// Transcript endpoints
// =========================================================
app.get("/calls", (req, res) => {
  const sids = [...new Set([...recentCalls, ...Object.keys(persisted)])].slice(0, 20);
  const out = sids.map((sid) => {
    const meta = (persisted?.[sid]?.meta || callMetaStore.get(sid) || {});
    return {
      callSid: sid,
      ...meta,
      transcriptCount: (persisted?.[sid]?.transcript || getTranscript(sid) || []).length,
      uiUrl: `${BASE_URL}/ui/${sid}`,
      transcriptUrl: `${BASE_URL}/transcript/${sid}`,
      summaryUrl: `${BASE_URL}/call-summary/${sid}`,
      liveUrl: `${BASE_URL}/live/${sid}`,
    };
  });
  res.json({ count: out.length, calls: out });
});

app.get("/transcript/:callSid", (req, res) => {
  const { callSid } = req.params;
  const transcript = getTranscript(callSid);
  if (!transcript.length) return res.status(404).json({ error: "No transcript found", callSid });
  res.json({
    callSid,
    ...(persisted?.[callSid]?.meta || callMetaStore.get(callSid) || {}),
    uiUrl: `${BASE_URL}/ui/${callSid}`,
    transcriptUrl: `${BASE_URL}/transcript/${callSid}`,
    summaryUrl: `${BASE_URL}/call-summary/${callSid}`,
    liveUrl: `${BASE_URL}/live/${callSid}`,
    transcript,
  });
});

app.get("/call-summary/:callSid", async (req, res) => {
  const { callSid } = req.params;
  const transcript = getTranscript(callSid);
  if (!transcript.length) return res.status(404).json({ error: "No transcript found", callSid });

  const text = transcript.map((x) => `${x.role.toUpperCase()}: ${x.content}`).join("\n");

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "Summarize this call in 5 bullet points with next steps." },
      { role: "user", content: text.slice(-6000) },
    ],
  });

  res.json({
    callSid,
    ...(persisted?.[callSid]?.meta || callMetaStore.get(callSid) || {}),
    uiUrl: `${BASE_URL}/ui/${callSid}`,
    transcriptUrl: `${BASE_URL}/transcript/${callSid}`,
    summaryUrl: `${BASE_URL}/call-summary/${callSid}`,
    liveUrl: `${BASE_URL}/live/${callSid}`,
    summary: completion.choices?.[0]?.message?.content,
    transcript,
  });
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port, `MODE=${MODE}`));
