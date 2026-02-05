/**
 * Cavas Voice Demo (2 modes + Hindi/English auto-switch for hospital)
 * FIXES:
 *  - Prevent Twilio hangups with try/catch + safe TwiML fallbacks
 *  - Avoid loops by not forcing generic prompts in hospital mode
 *  - actionOnEmptyResult + timeout to avoid dead-gathers
 *  - Stop OpenAI "polish" during name/phone/time collection
 *  - Persist transcripts to disk so /transcript works even after restart (demo-safe)
 *
 * LIVE UI (Option A):
 *  - GET  /ui/:callSid        -> Live transcript web page
 *  - GET  /live/:callSid      -> SSE stream for live transcript
 *
 * Endpoints:
 *  - POST /welcome?mode=hospital|education
 *  - POST /handle-input
 *  - POST /handle-followup
 *  - GET  /calls
 *  - GET  /transcript/:callSid
 *  - GET  /call-summary/:callSid
 *  - GET  /ui/:callSid
 *  - GET  /live/:callSid
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
    try {
      res.write(payload);
    } catch {}
  }
}

function rememberCall(callSid, patch = {}) {
  if (!callSid) return;
  const prev = callMetaStore.get(callSid) || { ts: new Date().toISOString() };
  const next = { ...prev, ...patch };
  callMetaStore.set(callSid, next);

  // keep also in persisted meta (so /calls works after restart)
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

  // persist
  persisted[callSid] = persisted[callSid] || { meta: {}, transcript: [] };
  persisted[callSid].transcript = arr;
  savePersisted(persisted);

  // live stream to UI
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

  // initial transcript
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
    .top{display:flex; gap:12px; flex-wrap:wrap; align-items:center; justify-content:space-between;}
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
    <div class="top">
      <div class="card" style="flex:1;">
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
    </div>

    <div class="card" id="log"></div>
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
    window.scrollTo(0, document.body.scrollHeight);
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

// Demo dataset
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

function detectDept(text) {
  const t = normalize(text);
  const aliases = [
    { k: ["cardio", "cardiology", "cardiologist", "heart", "heart doctor", "dil", "dil ka", "dil ka doctor"], v: "Cardiology" },
    { k: ["ortho", "orthopedic", "orthopedics", "bones", "bone", "haddi", "haddi ka", "joint"], v: "Orthopedics" },
    { k: ["ent", "ear", "nose", "throat", "kaan", "naak", "gala"], v: "ENT" },
    { k: ["neuro", "neurology", "brain", "dimaag"], v: "Neurology" },
    { k: ["onco", "oncology", "cancer"], v: "Oncology" },
    { k: ["derma", "dermatology", "skin", "twacha", "skin doctor"], v: "Dermatology" },
    { k: ["gastro", "gastroenterology", "stomach", "pet", "gas"], v: "Gastroenterology" },
  ];
  for (const a of aliases) if (a.k.some((kw) => t.includes(kw))) return a.v;
  const direct = DEPARTMENTS.find((d) => t.includes(normalize(d)));
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
  const t = normalize(text);
  return ["human","agent","representative","operator","real person","connect me","transfer","talk to someone","call center","agent se","representative se","human se"].some((k) => t.includes(k));
}
function looksLikeMedicalAdvice(text) {
  const t = normalize(text);
  const risky = ["fever","pain","chest pain","breath","bp","blood pressure","diagnose","diagnosis","treatment","medicine","tablet","dose","emergency","vomit","bleeding","pregnant","pregnancy","heart attack","stroke","bukhar","dard","saans","dabav","dawai","emergency"];
  return risky.some((k) => t.includes(k));
}
function pickSlots(d) {
  const slots = (d.nextSlots || []).slice(0, 3);
  return slots.length ? `Next available: ${slots.join(", ")}.` : "Next available slots will be shared by the booking team.";
}

// NEW: format options as "1. Dr A  2. Dr B  3. Dr C"
function doctorOptionsLine(docs) {
  const top = docs.slice(0, 3);
  return top.map((d, i) => `${i + 1}. ${d.name}`).join("  ");
}

// IMPORTANT: For demo reliability, polish ONLY non-sensitive lines.
async function hospitalPolish(callSid, raw) {
  const lower = String(raw || "").toLowerCase();
  const skip =
    lower.includes("full name") ||
    lower.includes("mobile") ||
    lower.includes("10-digit") ||
    lower.includes("prefer") ||
    lower.includes("confirmation") ||
    lower.includes("appointment request");

  if (!process.env.OPENAI_API_KEY || skip) return raw;

  const lang = getSttLang(callSid);
  const style = lang === "hi-IN"
    ? "Reply in friendly Hindi/Hinglish like a hospital front-desk. 1–2 short sentences. Do NOT refuse."
    : "Reply in friendly English like a hospital front-desk. 1–2 short sentences. Do NOT refuse.";

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            `You are a hospital appointment and routing voice assistant for ${HOSPITAL_NAME}. ` +
            "No medical advice. You ARE allowed to ask for patient name/phone for booking. Never refuse. " +
            style,
        },
        { role: "user", content: raw },
      ],
    });

    const out = completion.choices?.[0]?.message?.content?.trim();
    const refusalHints = ["i can't","i cant","cannot","personal details","privacy","not able"];
    if (!out || refusalHints.some((h) => out.toLowerCase().includes(h))) return raw;
    return out;
  } catch {
    return raw;
  }
}

async function getAIAnswerHospital(callSid, userText) {
  const session = getSession(callSid);
  const t = userText.trim();
  const norm = normalize(t);

  pushTranscript(callSid, "user", t);

  if (wantsHuman(t) || looksLikeMedicalAdvice(t)) {
    const say = await hospitalPolish(callSid, "Sure. I’m connecting you to a human representative now.");
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: true };
  }

  // State machine
  if (session.state === "COLLECT_NAME") {
    setSession(callSid, { state: "COLLECT_PHONE", data: { patientName: t } });
    const say = await hospitalPolish(callSid, "Thanks. Please tell me your 10-digit mobile number for confirmation.");
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  if (session.state === "COLLECT_PHONE") {
    const phone = extractPhone(t);
    if (!phone) {
      const say = await hospitalPolish(callSid, "Sorry, I didn’t catch the mobile number. Please say the 10-digit number again.");
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }
    setSession(callSid, { state: "COLLECT_TIME", data: { phone } });
    const say = await hospitalPolish(callSid, "Great. What day or time do you prefer? For example, tomorrow evening or Friday morning.");
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  if (session.state === "COLLECT_TIME") {
    const confirmationId = `APT-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
    const { patientName, phone, doctorName, dept } = session.data || {};
    setSession(callSid, { state: "CONFIRMED", data: { preferredTime: t, confirmationId } });

    const base =
      `Done. I’ve raised an appointment request for ${patientName || "the patient"} ` +
      `${doctorName ? `with ${doctorName}` : dept ? `in ${dept}` : ""}. ` +
      `Preferred time: ${t}. Confirmation ID is ${confirmationId}. ` +
      `You will receive confirmation on ${phone || "your number"}.`;

    const say = await hospitalPolish(callSid, base);
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  const dept = detectDept(t);
  const hasDr = norm.includes("dr ") || norm.includes("dr.") || norm.includes("doctor ");

  if (hasDr) {
    let q = t;
    const idx = norm.indexOf("dr");
    const idx2 = norm.indexOf("doctor");
    if (idx2 >= 0) q = t.slice(idx2 + "doctor".length).trim();
    else if (idx >= 0) q = t.slice(idx + 2).trim();

    const matches = findDoctorByName(q);

    if (matches.length === 1) {
      const d = matches[0];
      setSession(callSid, { state: "COLLECT_NAME", data: { doctorName: d.name, dept: d.dept } });
      const say = await hospitalPolish(callSid, `Sure. ${d.name} is in ${d.dept}. ${pickSlots(d)} To book, please tell me the patient’s full name.`);
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    const say = await hospitalPolish(callSid, "I couldn’t find that doctor. Please say the department, for example cardiology, orthopedics or ENT.");
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  // If we already asked options earlier, handle that FIRST (numbers or name)
  if (session.state === "ASK_BOOK_OR_LIST_MORE") {
    const deptInSession = session.data?.dept;
    const docs = deptInSession ? listDoctorsByDept(deptInSession, "Gurgaon") : [];

    // If user says a number (1/2/3)
    const n = parseInt(String(t).trim(), 10);
    if (!Number.isNaN(n) && n >= 1 && n <= Math.min(3, docs.length)) {
      const d = docs[n - 1];
      setSession(callSid, { state: "COLLECT_NAME", data: { doctorName: d.name, dept: d.dept } });
      const say = await hospitalPolish(callSid, `Sure. ${d.name}. ${pickSlots(d)} To book, please tell me the patient’s full name.`);
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    // Otherwise match by name
    const matches = findDoctorByName(t);
    if (matches.length === 1) {
      const d = matches[0];
      setSession(callSid, { state: "COLLECT_NAME", data: { doctorName: d.name, dept: d.dept } });
      const say = await hospitalPolish(callSid, `Sure. ${d.name}. ${pickSlots(d)} To book, please tell me the patient’s full name.`);
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    const say = await hospitalPolish(
      callSid,
      "Please say the doctor name or the option number (1, 2, or 3). You can also say ‘agent’ to connect to a human representative."
    );
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  if (dept) {
    const docs = listDoctorsByDept(dept, "Gurgaon");
    if (!docs.length) {
      const say = await hospitalPolish(callSid, `I don’t have doctors listed for ${dept} right now. Would you like to connect to an agent?`);
      pushTranscript(callSid, "assistant", say);
      return { say, transfer: false };
    }

    setSession(callSid, { state: "ASK_BOOK_OR_LIST_MORE", data: { dept } });

    const lang = getSttLang(callSid);
    const options = doctorOptionsLine(docs);

    const rawPrompt =
      lang === "hi-IN"
        ? `${dept} ke liye hamare paas ye doctors hain: ${options}. Aap kisko book karna chahenge? Aap number bol sakte hain—jaise 1, 2, ya 3.`
        : `For ${dept}, we have these doctors: ${options}. Which one would you like to book? You can say the number—like 1, 2, or 3.`;

    const say = await hospitalPolish(callSid, rawPrompt);
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: false };
  }

  const say = await hospitalPolish(
    callSid,
    `I can help with appointments at ${HOSPITAL_NAME}. Say a department like cardiology, or say Dr followed by the doctor’s name, or say agent.`
  );
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
// Twilio routes (with strong error handling)
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
        ? `Hello! You’ve reached ${HOSPITAL_NAME} appointment assistance by Cavas AI. You can speak in Hindi or English. How can I help?`
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
        ? "Sorry, aapki awaaz clear nahi aayi. Dobara boliye."
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
        twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Transfer is not configured right now. Please try again later.")}`);
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
      const shortPrompt = sttLang === "hi-IN" ? "Aur kuch?" : "Anything else?";
      gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(shortPrompt)}`);
    }

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("/handle-input error callSid=", callSid, e);
    const sttLang = getSttLang(callSid);
    twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Sorry, I faced a technical issue. Please try again.")}`);
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
      const msg = sttLang === "hi-IN" ? "Sorry, dobara boliye." : "Sorry, please say that again.";
      gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(msg)}`);
      return res.type("text/xml").send(twiml.toString());
    }

    const endWords = ["no", "bye", "thanks", "thank you", "that is all", "nahi", "nahin", "bas", "theek hai", "ok bye"];
    if (endWords.some((w) => speechLower.includes(w))) {
      const bye = sttLang === "hi-IN" ? "Dhanyavaad. Alvida." : "Thank you for calling. Goodbye.";
      twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(bye)}`);
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    const result = await getAIAnswer(callSid, raw);
    twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(result.say)}`);

    if (result.transfer) {
      if (!AGENT_NUMBER) {
        twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Transfer is not configured right now. Please try again later.")}`);
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
      const shortPrompt = sttLang === "hi-IN" ? "Aur kuch?" : "Anything else?";
      gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(shortPrompt)}`);
    }

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("/handle-followup error callSid=", callSid, e);
    const sttLang = getSttLang(callSid);
    twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Sorry, technical issue. Please try again.")}`);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

// =========================================================
// Transcript endpoints
// =========================================================
app.get("/calls", (req, res) => {
  const sids = [...new Set([...recentCalls, ...Object.keys(persisted)])].slice(0, 20);
  const out = sids.map((sid) => ({
    callSid: sid,
    ...(persisted?.[sid]?.meta || callMetaStore.get(sid) || {}),
    transcriptCount: (persisted?.[sid]?.transcript || getTranscript(sid) || []).length,
  }));
  res.json({ count: out.length, calls: out });
});

app.get("/transcript/:callSid", (req, res) => {
  const { callSid } = req.params;
  const transcript = getTranscript(callSid);
  if (!transcript.length) return res.status(404).json({ error: "No transcript found", callSid });
  res.json({
    callSid,
    ...(persisted?.[callSid]?.meta || callMetaStore.get(callSid) || {}),
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
    summary: completion.choices?.[0]?.message?.content,
    transcript,
  });
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port, `MODE=${MODE}`));
