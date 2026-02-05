/**
 * Cavas Voice Demo (2 modes + Hindi/English auto-switch for hospital + better loop handling)
 * + Transcript endpoints:
 *   - GET /calls                -> list recent calls (CallSid, mode, lang, time)
 *   - GET /transcript/:callSid  -> transcript only
 *   - GET /call-summary/:callSid-> summary + transcript
 */

import express from "express";
import twilio from "twilio";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));

const MODE = (process.env.MODE || "education").toLowerCase(); // "education" | "hospital"
const HOSPITAL_NAME = process.env.HOSPITAL_NAME || "Medanta";
const AGENT_NUMBER = process.env.HOSPITAL_AGENT_NUMBER || ""; // e.g. +919999999999
const BASE_URL = process.env.BASE_URL || "https://cavas-voice-demo.onrender.com";

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Memory Stores ----------
const convoStore = new Map();      // CallSid -> last 10 messages (education only)
const transcriptStore = new Map(); // CallSid -> full transcript
const sessionStore = new Map();    // CallSid -> { mode, state, lang, data }
const callMetaStore = new Map();   // CallSid -> { ts, mode, lang, from, to }
const recentCalls = [];            // array of CallSid (most recent first), max 20

function rememberCall(callSid, patch = {}) {
  if (!callSid) return;
  const prev = callMetaStore.get(callSid) || { ts: new Date().toISOString() };
  const next = { ...prev, ...patch };
  callMetaStore.set(callSid, next);

  // maintain recent list
  const idx = recentCalls.indexOf(callSid);
  if (idx >= 0) recentCalls.splice(idx, 1);
  recentCalls.unshift(callSid);
  while (recentCalls.length > 20) recentCalls.pop();
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
function pushTranscript(callSid, role, content) {
  if (!callSid) return;
  const arr = transcriptStore.get(callSid) || [];
  arr.push({ ts: new Date().toISOString(), role, content });
  transcriptStore.set(callSid, arr);
}
function getTranscript(callSid) {
  return transcriptStore.get(callSid) || [];
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

  // keep meta updated too
  rememberCall(callSid, { mode: next.mode, lang: next.lang });

  return next;
}

// =========================================================
// Language helpers
// =========================================================
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

// =========================================================
// ElevenLabs TTS (language-aware)
// =========================================================
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
  } catch {
    res.status(500).send("TTS failed");
  }
});

// ---------- Health ----------
app.get("/", (_, res) => res.send(`Cavas Voice Demo is running ✅ (MODE=${MODE})`));

// =========================================================
// Education mode
// =========================================================
async function getAIAnswerEducation(callSid, userText) {
  const history = getHistory(callSid);

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "You are Cavas AI admissions assistant. Answer clearly in 1–3 sentences. Maintain conversation context.",
      },
      ...history,
      { role: "user", content: userText },
    ],
  });

  const answer =
    completion.choices?.[0]?.message?.content?.trim() ||
    "Sorry, I could not answer that.";

  pushHistory(callSid, "user", userText);
  pushHistory(callSid, "assistant", answer);

  pushTranscript(callSid, "user", userText);
  pushTranscript(callSid, "assistant", answer);

  return { say: answer, end: false };
}

// =========================================================
// Hospital mode dataset + helpers
// =========================================================
const DOCTORS = [
  { id: "D001", name: "Dr Arjun Mehta", dept: "Cardiology", location: "Gurgaon", languages: ["English", "Hindi"], nextSlots: ["Tomorrow 5 PM", "Day after tomorrow 11 AM", "Friday 4 PM"] },
  { id: "D002", name: "Dr Neha Sharma", dept: "Cardiology", location: "Gurgaon", languages: ["English", "Hindi"], nextSlots: ["Tomorrow 12 PM", "Thursday 6 PM"] },
  { id: "D003", name: "Dr Rohan Kapoor", dept: "Orthopedics", location: "Gurgaon", languages: ["English", "Hindi"], nextSlots: ["Tomorrow 3 PM", "Saturday 10 AM"] },
  { id: "D004", name: "Dr Simran Kaur", dept: "ENT", location: "Gurgaon", languages: ["English", "Hindi", "Punjabi"], nextSlots: ["Tomorrow 1 PM", "Friday 2 PM"] },
];

const DEPARTMENTS = ["Cardiology", "Orthopedics", "ENT", "Neurology", "Oncology", "Dermatology", "Gastroenterology"];

function extractPhone(text) {
  const t = String(text || "");
  const m = t.match(/(\+?\d[\d\s-]{9,}\d)/) || t.match(/(\d{10})/);
  return m ? m[1].replace(/\s|-/g, "") : null;
}

function findDoctorByName(query) {
  const q = normalize(query).replace(/^dr\.?\s*/i, "");
  if (!q) return [];
  return DOCTORS.filter((d) => normalize(d.name).includes(q)).slice(0, 5);
}

function listDoctorsByDept(dept, location = "Gurgaon") {
  const d = normalize(dept);
  return DOCTORS.filter((x) => normalize(x.dept) === d && normalize(x.location) === normalize(location));
}

function detectDept(text) {
  const t = normalize(text);
  const aliases = [
    { k: ["cardio", "cardiology", "heart"], v: "Cardiology" },
    { k: ["ortho", "orthopedic", "orthopedics", "bones", "bone"], v: "Orthopedics" },
    { k: ["ent", "ear", "nose", "throat"], v: "ENT" },
    { k: ["neuro", "neurology", "brain"], v: "Neurology" },
    { k: ["onco", "oncology", "cancer"], v: "Oncology" },
    { k: ["derma", "dermatology", "skin"], v: "Dermatology" },
    { k: ["gastro", "gastroenterology", "stomach"], v: "Gastroenterology" },
  ];
  for (const a of aliases) if (a.k.some((kw) => t.includes(kw))) return a.v;
  const direct = DEPARTMENTS.find((d) => t.includes(normalize(d)));
  return direct || null;
}

function wantsHuman(text) {
  const t = normalize(text);
  return ["human", "agent", "representative", "operator", "real person", "connect me", "transfer", "talk to someone", "call center", "agent se", "representative se", "human se"].some((k) => t.includes(k));
}

function looksLikeMedicalAdvice(text) {
  const t = normalize(text);
  const risky = [
    "fever","pain","chest pain","breath","bp","blood pressure","diagnose","diagnosis","treatment","medicine","tablet","dose",
    "emergency","vomit","bleeding","pregnant","pregnancy","heart attack","stroke",
    "bukhar","dard","saans","dabav","blood","dawai","emergency"
  ];
  return risky.some((k) => t.includes(k));
}

function summarizeTopDoctors(doctors) {
  return doctors.slice(0, 3).map((d, i) => `${i + 1}. ${d.name} (${d.dept})`).join(". ");
}
function pickSlots(d) {
  const slots = (d.nextSlots || []).slice(0, 3);
  return slots.length ? `Next available: ${slots.join(", ")}.` : "I can request the next available slot from the booking team.";
}

async function hospitalLLMPolish(callSid, rawReply) {
    // If no OpenAI key, or message is sensitive (name/phone/time collection), skip polish
  const lower = String(rawReply || "").toLowerCase();
  const skipPolish =
    lower.includes("full name") ||
    lower.includes("mobile number") ||
    lower.includes("10-digit") ||
    lower.includes("preferred") ||
    lower.includes("confirmation id") ||
    lower.includes("appointment request");

  if (!process.env.OPENAI_API_KEY || skipPolish) return rawReply;

  const lang = getSttLang(callSid);
  const style =
    lang === "hi-IN"
      ? "Reply in friendly, natural Hindi or Hinglish (Devanagari preferred), like a hospital front-desk. Keep it 1–2 short sentences."
      : "Reply in friendly, natural English, like a hospital front-desk. Keep it 1–2 short sentences.";

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            `You are a hospital appointment and routing voice assistant for ${HOSPITAL_NAME}. ` +
            "You MUST NOT provide medical advice. " +
            "You ARE allowed to ask for basic booking details like patient name and phone number for appointment confirmation. " +
            "Do NOT refuse; do NOT mention policies. " +
            style,
        },
        { role: "user", content: rawReply },
      ],
    });

    const out = completion.choices?.[0]?.message?.content?.trim();

    // If model returns a refusal-like response, fallback to rawReply
    const refusalHints = [
      "i can’t", "i can't",
      "cannot help with personal",
      "personal details",
      "privacy",
      "i’m not able to",
      "cannot assist with",
    ];
    if (!out || refusalHints.some((h) => out.toLowerCase().includes(h))) return rawReply;

    return out;
  } catch {
    return rawReply;
  }
}

async function getAIAnswerHospital(callSid, userText) {
  const session = getSession(callSid);
  const t = userText.trim();
  const norm = normalize(t);

  pushTranscript(callSid, "user", t);

  if (wantsHuman(t) || looksLikeMedicalAdvice(t)) {
    const say = await hospitalLLMPolish(callSid, "Sure. I’m connecting you to a human representative now.");
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: true, end: true };
  }

  if (session.state === "COLLECT_NAME") {
    setSession(callSid, { state: "COLLECT_PHONE", data: { patientName: t } });
    const say = await hospitalLLMPolish(callSid, "Thanks. Please tell me your 10-digit mobile number for confirmation.");
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  if (session.state === "COLLECT_PHONE") {
    const phone = extractPhone(t);
    if (!phone) {
      const say = await hospitalLLMPolish(callSid, "Sorry, I didn’t catch the mobile number. Please say the 10-digit number again.");
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }
    setSession(callSid, { state: "COLLECT_TIME", data: { phone } });
    const say = await hospitalLLMPolish(callSid, "Great. What day or time do you prefer? For example, tomorrow evening or Friday morning.");
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  if (session.state === "COLLECT_TIME") {
    const confirmationId = `APT-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
    const { patientName, phone, doctorName, dept } = session.data || {};
    setSession(callSid, { state: "CONFIRMED", data: { preferredTime: t, confirmationId } });

    const baseConfirm =
      `Done. I’ve raised an appointment request for ${patientName || "the patient"} ` +
      `${doctorName ? `with ${doctorName}` : dept ? `in ${dept}` : ""}. ` +
      `Preferred time: ${t}. Confirmation ID is ${confirmationId}. ` +
      `You will receive confirmation on ${phone || "your number"}.`;

    const say = await hospitalLLMPolish(callSid, baseConfirm);
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
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
      setSession(callSid, { state: "COLLECT_NAME", data: { doctorId: d.id, doctorName: d.name, dept: d.dept, location: d.location } });
      const say = await hospitalLLMPolish(callSid, `Sure. ${d.name} is in ${d.dept} at ${d.location}. ${pickSlots(d)} To book, please tell me the patient’s full name.`);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }

    if (matches.length > 1) {
      setSession(callSid, { state: "ASK_DOCTOR_CHOICE", data: { doctorCandidates: matches.map((x) => x.id) } });
      const say = await hospitalLLMPolish(callSid, `I found multiple matches. ${summarizeTopDoctors(matches)}. Please say the full doctor name you want to book with.`);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }

    setSession(callSid, { state: "ASK_DEPARTMENT", data: {} });
    const say = await hospitalLLMPolish(callSid, "I couldn’t find that doctor name. Which department do you need—like cardiology, orthopedics, or ENT?");
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  if (session.state === "ASK_DOCTOR_CHOICE") {
    const matches = findDoctorByName(t);
    if (matches.length === 1) {
      const d = matches[0];
      setSession(callSid, { state: "COLLECT_NAME", data: { doctorId: d.id, doctorName: d.name, dept: d.dept, location: d.location } });
      const say = await hospitalLLMPolish(callSid, `Great. ${d.name} in ${d.dept}. ${pickSlots(d)} To book, please tell me the patient’s full name.`);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }
    const say = await hospitalLLMPolish(callSid, "Sorry, I still didn’t match the doctor. Please say the full doctor name again, or say the department.");
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  if (dept) {
    const docs = listDoctorsByDept(dept, "Gurgaon");
    if (!docs.length) {
      const say = await hospitalLLMPolish(callSid, `I don’t have doctors listed for ${dept} at the moment. Would you like me to connect you to an agent?`);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }
    setSession(callSid, { state: "ASK_BOOK_OR_LIST_MORE", data: { dept } });
    const say = await hospitalLLMPolish(callSid, `${dept} has these doctors: ${docs.slice(0, 3).map((d) => d.name).join(", ")}. Would you like to book with one of them? If yes, say the doctor’s name.`);
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  if (session.state === "ASK_DEPARTMENT") {
    const dpt = detectDept(t);
    if (!dpt) {
      const say = await hospitalLLMPolish(callSid, "Please tell me the department, for example cardiology, orthopedics, or ENT.");
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }
    const docs = listDoctorsByDept(dpt, "Gurgaon");
    setSession(callSid, { state: "ASK_BOOK_OR_LIST_MORE", data: { dept: dpt } });
    const say = await hospitalLLMPolish(callSid, `${dpt} doctors include ${docs.slice(0, 3).map((d) => d.name).join(", ")}. Say the doctor’s name to book, or say ‘agent’ to connect.`);
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  if (session.state === "ASK_BOOK_OR_LIST_MORE") {
    const matches = findDoctorByName(t);
    if (matches.length === 1) {
      const d = matches[0];
      setSession(callSid, { state: "COLLECT_NAME", data: { doctorId: d.id, doctorName: d.name, dept: d.dept, location: d.location } });
      const say = await hospitalLLMPolish(callSid, `Sure. ${d.name}. ${pickSlots(d)} To book, please tell me the patient’s full name.`);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }
    const say = await hospitalLLMPolish(callSid, "Please say the full doctor name to book, or say ‘agent’ to connect to a human representative.");
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  const say = await hospitalLLMPolish(
    callSid,
    `I can help with appointments and departments at ${HOSPITAL_NAME}. Say a department like cardiology, say ‘Dr’ followed by the doctor’s name, or say ‘agent’ to connect to a human.`
  );
  pushTranscript(callSid, "assistant", say);
  return { say, end: false };
}

// Unified brain switch
async function getAIAnswer(callSid, userText) {
  const session = getSession(callSid);
  if ((session.mode || MODE) === "hospital") return getAIAnswerHospital(callSid, userText);
  return getAIAnswerEducation(callSid, userText);
}

// =========================================================
// Twilio Routes (hospital doesn't force generic loop prompts)
// =========================================================

// ---------- Welcome ----------
app.post("/welcome", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid;
  const from = req.body.From || null;
  const to = req.body.To || null;

  const modeFromQuery = (req.query.mode || "").toString().toLowerCase();
  const mode =
    modeFromQuery === "hospital" || modeFromQuery === "education"
      ? modeFromQuery
      : MODE;

  // remember call meta
  rememberCall(callSid, { ts: new Date().toISOString(), from, to, mode });

  setSession(callSid, {
    mode,
    state: "NEW",
    lang: mode === "hospital" ? "en-IN" : null,
    data: {},
  });

  const greeting =
    mode === "hospital"
      ? `Hello! You’ve reached ${HOSPITAL_NAME} appointment assistance by Cavas AI. You can say a department, a doctor name, or say agent to connect to a representative. You can speak in Hindi or English. How can I help?`
      : "Hello! Welcome to Cavas AI admissions assistant. How can I help you today?";

  const sttLang = getSttLang(callSid);

  const gather = twiml.gather({
    input: "speech",
    bargeIn: true,
    language: sttLang,
    speechTimeout: "auto",
    action: `${BASE_URL}/handle-input`,
    method: "POST",
  });

  gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(greeting)}`);

  res.type("text/xml").send(twiml.toString());
});

// ---------- First + Next ----------
app.post("/handle-input", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  if (!speech) {
    twiml.redirect({ method: "POST" }, `${BASE_URL}/welcome`);
    return res.type("text/xml").send(twiml.toString());
  }

  const pref = detectLangPreference(speech);
  if (pref) setSession(callSid, { lang: pref });

  const result = await getAIAnswer(callSid, speech);

  const sttLang = getSttLang(callSid);

  twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(result.say)}`);

  if (result.transfer) {
    if (!AGENT_NUMBER) {
      twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("I cannot transfer right now because the agent number is not configured. Please try again later.")}`);
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }
    twiml.dial(AGENT_NUMBER);
    return res.type("text/xml").send(twiml.toString());
  }

  const mode = (getSession(callSid)?.mode || MODE);

  const gather = twiml.gather({
    input: "speech",
    bargeIn: true,
    language: sttLang,
    speechTimeout: "auto",
    action: `${BASE_URL}/handle-followup`,
    method: "POST",
  });

  if (mode === "education") {
    gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Would you like to ask another question? You can ask now or say no.")}`);
  } else {
    const shortPrompt = sttLang === "hi-IN" ? "Aur kuch help chahiye? Aap bol sakte hain." : "Anything else? You can speak now.";
    gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(shortPrompt)}`);
  }

  return res.type("text/xml").send(twiml.toString());
});

// ---------- Follow-up ----------
app.post("/handle-followup", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const raw = (req.body.SpeechResult || "").trim();
  const speechLower = raw.toLowerCase();

  const pref = detectLangPreference(raw);
  if (pref) setSession(callSid, { lang: pref });

  const sttLang = getSttLang(callSid);
  const mode = (getSession(callSid)?.mode || MODE);

  const endWords = ["no", "bye", "thanks", "thank you", "that is all", "nahi", "nahin", "bas", "theek hai", "ok bye"];
  if (!speechLower || endWords.some((w) => speechLower.includes(w))) {
    const bye = sttLang === "hi-IN" ? "Dhanyavaad. Alvida." : "Thank you for calling. Goodbye.";
    twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(bye)}`);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  const result = await getAIAnswer(callSid, raw);

  twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(result.say)}`);

  if (result.transfer) {
    if (!AGENT_NUMBER) {
      twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("I cannot transfer right now because the agent number is not configured. Please try again later.")}`);
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }
    twiml.dial(AGENT_NUMBER);
    return res.type("text/xml").send(twiml.toString());
  }

  const gather = twiml.gather({
    input: "speech",
    bargeIn: true,
    language: sttLang,
    speechTimeout: "auto",
    action: `${BASE_URL}/handle-followup`,
    method: "POST",
  });

  if (mode === "education") {
    gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Anything else you would like to know?")}`);
  } else {
    const shortPrompt = sttLang === "hi-IN" ? "Aur kya jaankari chahiye? Aap bol sakte hain." : "Anything else? You can speak now.";
    gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(shortPrompt)}`);
  }

  return res.type("text/xml").send(twiml.toString());
});

// =========================================================
// Transcript endpoints
// =========================================================

// List recent calls (so you can quickly get CallSid)
app.get("/calls", (req, res) => {
  const out = recentCalls.map((sid) => ({
    callSid: sid,
    ...(callMetaStore.get(sid) || {}),
  }));
  res.json({ count: out.length, calls: out });
});

// Transcript only
app.get("/transcript/:callSid", (req, res) => {
  const { callSid } = req.params;
  const transcript = getTranscript(callSid);
  if (!transcript.length) return res.status(404).json({ error: "No transcript found" });
  res.json({
    callSid,
    ...(callMetaStore.get(callSid) || {}),
    transcript,
  });
});

// Summary + transcript
app.get("/call-summary/:callSid", async (req, res) => {
  const { callSid } = req.params;
  const transcript = getTranscript(callSid);
  if (!transcript.length) return res.status(404).json({ error: "No transcript found" });

  const text = transcript.map((x) => `${x.role.toUpperCase()}: ${x.content}`).join("\n");

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Summarize this call in 5 bullet points with next steps. If it’s a hospital call, include: intent, department/doctor, captured details, whether handoff happened, and pending action.",
      },
      { role: "user", content: text.slice(-6000) },
    ],
  });

  res.json({
    callSid,
    ...(callMetaStore.get(callSid) || {}),
    mode: (getSession(callSid)?.mode || MODE),
    lang: (getSession(callSid)?.lang || null),
    summary: completion.choices?.[0]?.message?.content,
    transcript,
  });
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port, `MODE=${MODE}`));
