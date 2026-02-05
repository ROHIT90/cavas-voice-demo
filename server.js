/**
 * Cavas Voice Demo (2 modes + Hindi/English auto-switch for hospital)
 * MODE=education  -> admissions assistant (LLM)
 * MODE=hospital   -> appointment + department + human handoff (safe, tool/data driven) + auto Hindi/English
 *
 * Env needed:
 *  - BASE_URL=https://cavas-voice-demo.onrender.com
 *  - MODE=hospital | education
 *  - OPENAI_API_KEY=...
 *  - OPENAI_MODEL=gpt-4o-mini (optional)
 *  - ELEVEN_API_KEY=...
 *  - ELEVEN_VOICE_ID=... (fallback voice)
 *  - ELEVEN_VOICE_ID_EN=... (optional)
 *  - ELEVEN_VOICE_ID_HI=... (optional)
 *  - HOSPITAL_AGENT_NUMBER=+91XXXXXXXXXX
 *  - HOSPITAL_NAME=Medanta (optional)
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
const convoStore = new Map();      // CallSid -> last 10 messages
const transcriptStore = new Map(); // CallSid -> full transcript
const sessionStore = new Map();    // CallSid -> { mode, state, lang, data }

function getHistory(callSid) {
  return convoStore.get(callSid) || [];
}
function pushHistory(callSid, role, content) {
  if (!callSid) return;
  const arr = convoStore.get(callSid) || [];
  arr.push({ role, content });
  while (arr.length > 10) arr.shift(); // last 5 exchanges
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
  return next;
}

// =========================================================
// Language helpers (Hindi/English auto-switch for hospital)
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

  // Default: keep current session language
  return null;
}
function getSttLang(callSid) {
  const s = getSession(callSid);
  if ((s.mode || MODE) === "hospital") return s.lang || "en-IN"; // good for India + Hinglish
  return "en-US";
}

// =========================================================
// ElevenLabs TTS (language-aware, optional separate voices)
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
// 1) EDUCATION MODE (your existing behavior)
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
// 2) HOSPITAL MODE (safe scheduling + routing)
// =========================================================

// ---- Demo dataset (replace with HIS/CRM API later) ----
const DOCTORS = [
  {
    id: "D001",
    name: "Dr Arjun Mehta",
    dept: "Cardiology",
    location: "Gurgaon",
    languages: ["English", "Hindi"],
    nextSlots: ["Tomorrow 5 PM", "Day after tomorrow 11 AM", "Friday 4 PM"],
  },
  {
    id: "D002",
    name: "Dr Neha Sharma",
    dept: "Cardiology",
    location: "Gurgaon",
    languages: ["English", "Hindi"],
    nextSlots: ["Tomorrow 12 PM", "Thursday 6 PM"],
  },
  {
    id: "D003",
    name: "Dr Rohan Kapoor",
    dept: "Orthopedics",
    location: "Gurgaon",
    languages: ["English", "Hindi"],
    nextSlots: ["Tomorrow 3 PM", "Saturday 10 AM"],
  },
  {
    id: "D004",
    name: "Dr Simran Kaur",
    dept: "ENT",
    location: "Gurgaon",
    languages: ["English", "Hindi", "Punjabi"],
    nextSlots: ["Tomorrow 1 PM", "Friday 2 PM"],
  },
];

const DEPARTMENTS = [
  "Cardiology",
  "Orthopedics",
  "ENT",
  "Neurology",
  "Oncology",
  "Dermatology",
  "Gastroenterology",
];

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
  return DOCTORS.filter(
    (x) =>
      normalize(x.dept) === d && normalize(x.location) === normalize(location)
  );
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
  for (const a of aliases) {
    if (a.k.some((kw) => t.includes(kw))) return a.v;
  }
  const direct = DEPARTMENTS.find((d) => t.includes(normalize(d)));
  return direct || null;
}

function wantsHuman(text) {
  const t = normalize(text);
  return [
    "human",
    "agent",
    "representative",
    "operator",
    "real person",
    "connect me",
    "transfer",
    "talk to someone",
    "call center",
    "agent se",
    "representative se",
    "human se",
  ].some((k) => t.includes(k));
}

function looksLikeMedicalAdvice(text) {
  const t = normalize(text);
  const risky = [
    "fever", "pain", "chest pain", "breath", "bp", "blood pressure",
    "diagnose", "diagnosis", "treatment", "medicine", "tablet", "dose",
    "emergency", "vomit", "bleeding", "pregnant", "pregnancy",
    "heart attack", "stroke",
    // common Hindi/Hinglish cues:
    "bukhar", "dard", "saans", "dabav", "blood", "dawai", "medicine", "emergency"
  ];
  return risky.some((k) => t.includes(k));
}

function summarizeTopDoctors(doctors) {
  const top = doctors.slice(0, 3);
  return top.map((d, i) => `${i + 1}. ${d.name} (${d.dept})`).join(". ");
}

function pickSlots(d) {
  const slots = (d.nextSlots || []).slice(0, 3);
  if (!slots.length) return "I can request the next available slot from the booking team.";
  return `Next available: ${slots.join(", ")}.`;
}

async function hospitalLLMPolish(callSid, rawReply) {
  if (!process.env.OPENAI_API_KEY) return rawReply;

  const lang = getSttLang(callSid);
  const style =
    lang === "hi-IN"
      ? "Reply in friendly, natural Hindi or Hinglish (Devanagari preferred), like a hospital front-desk. Keep it 1–2 short sentences."
      : "Reply in friendly, natural English, like a hospital front-desk. Keep it 1–2 short sentences.";

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          `You are a hospital appointment and routing voice assistant for ${HOSPITAL_NAME}. ` +
          "You MUST NOT provide medical advice. Only appointments, departments, doctor options, and transferring to a human agent. " +
          style,
      },
      { role: "user", content: rawReply },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || rawReply;
}

async function getAIAnswerHospital(callSid, userText) {
  const session = getSession(callSid);
  const t = userText.trim();
  const norm = normalize(t);

  // transcript
  pushTranscript(callSid, "user", t);

  // immediate handoff (human request OR medical)
  if (wantsHuman(t) || looksLikeMedicalAdvice(t)) {
    const reason = wantsHuman(t) ? "User requested human agent" : "Medical advice detected";
    const say = await hospitalLLMPolish(
      callSid,
      `Sure. I’m connecting you to a human representative now. (${reason})`
    );
    pushTranscript(callSid, "assistant", say);
    return { say, transfer: true, end: true };
  }

  // state machine
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
    const preferredTime = t;

    setSession(callSid, { state: "CONFIRMED", data: { preferredTime, confirmationId } });

    const baseConfirm =
      `Done. I’ve raised an appointment request for ${patientName || "the patient"} ` +
      `${doctorName ? `with ${doctorName}` : dept ? `in ${dept}` : ""}. ` +
      `Preferred time: ${preferredTime}. Confirmation ID is ${confirmationId}. ` +
      `You will receive confirmation on ${phone || "your number"}.`;

    const say = await hospitalLLMPolish(callSid, baseConfirm);
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  // doctor name flow
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
      setSession(callSid, {
        state: "COLLECT_NAME",
        data: { doctorId: d.id, doctorName: d.name, dept: d.dept, location: d.location },
      });

      const base =
        `Sure. ${d.name} is in ${d.dept} at ${d.location}. ${pickSlots(d)} ` +
        "To book, please tell me the patient’s full name.";
      const say = await hospitalLLMPolish(callSid, base);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }

    if (matches.length > 1) {
      setSession(callSid, { state: "ASK_DOCTOR_CHOICE", data: { doctorCandidates: matches.map((x) => x.id) } });
      const base =
        `I found multiple matches. ${summarizeTopDoctors(matches)}. ` +
        "Please say the full doctor name you want to book with.";
      const say = await hospitalLLMPolish(callSid, base);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }

    setSession(callSid, { state: "ASK_DEPARTMENT", data: {} });
    const say = await hospitalLLMPolish(
      callSid,
      "I couldn’t find that doctor name. Which department do you need—like cardiology, orthopedics, or ENT?"
    );
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  if (session.state === "ASK_DOCTOR_CHOICE") {
    const matches = findDoctorByName(t);
    if (matches.length === 1) {
      const d = matches[0];
      setSession(callSid, {
        state: "COLLECT_NAME",
        data: { doctorId: d.id, doctorName: d.name, dept: d.dept, location: d.location },
      });
      const base =
        `Great. ${d.name} in ${d.dept}. ${pickSlots(d)} ` +
        "To book, please tell me the patient’s full name.";
      const say = await hospitalLLMPolish(callSid, base);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }
    const say = await hospitalLLMPolish(callSid, "Sorry, I still didn’t match the doctor. Please say the full doctor name again, or say the department.");
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  // department flow
  if (dept) {
    const docs = listDoctorsByDept(dept, "Gurgaon");
    if (!docs.length) {
      const say = await hospitalLLMPolish(callSid, `I don’t have doctors listed for ${dept} at the moment. Would you like me to connect you to an agent?`);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }

    setSession(callSid, { state: "ASK_BOOK_OR_LIST_MORE", data: { dept } });

    const top = docs.slice(0, 3);
    const base =
      `${dept} has these doctors: ${top.map((d) => d.name).join(", ")}. ` +
      "Would you like to book with one of them? If yes, say the doctor’s name.";
    const say = await hospitalLLMPolish(callSid, base);
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

    const base =
      `${dpt} doctors include ${docs.slice(0, 3).map((d) => d.name).join(", ")}. ` +
      "Say the doctor’s name to book, or say ‘agent’ to connect to a representative.";
    const say = await hospitalLLMPolish(callSid, base);
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  if (session.state === "ASK_BOOK_OR_LIST_MORE") {
    const matches = findDoctorByName(t);
    if (matches.length === 1) {
      const d = matches[0];
      setSession(callSid, {
        state: "COLLECT_NAME",
        data: { doctorId: d.id, doctorName: d.name, dept: d.dept, location: d.location },
      });
      const base =
        `Sure. ${d.name}. ${pickSlots(d)} ` +
        "To book, please tell me the patient’s full name.";
      const say = await hospitalLLMPolish(callSid, base);
      pushTranscript(callSid, "assistant", say);
      return { say, end: false };
    }
    const say = await hospitalLLMPolish(callSid, "Please say the full doctor name to book, or say ‘agent’ to connect to a human representative.");
    pushTranscript(callSid, "assistant", say);
    return { say, end: false };
  }

  // fallback
  const fallback =
    `I can help with appointments and departments at ${HOSPITAL_NAME}. ` +
    "Say a department like cardiology, say ‘Dr’ followed by the doctor’s name, or say ‘agent’ to connect to a human.";
  const say = await hospitalLLMPolish(callSid, fallback);
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
// Twilio Routes
// =========================================================

// ---------- Welcome ----------
app.post("/welcome", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid;

  const modeFromQuery = (req.query.mode || "").toString().toLowerCase();
  const mode =
    modeFromQuery === "hospital" || modeFromQuery === "education"
      ? modeFromQuery
      : MODE;

  // set per-call defaults
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

  // auto-switch lang for hospital based on user speech
  const pref = detectLangPreference(speech);
  if (pref) setSession(callSid, { lang: pref });

  const sttLang = getSttLang(callSid);

  const result = await getAIAnswer(callSid, speech);
  twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(result.say)}`);

  if (result.transfer) {
    if (!AGENT_NUMBER) {
      twiml.play(
        `${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(
          "I cannot transfer right now because the agent number is not configured. Please try again later."
        )}`
      );
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

  gather.play(
    `${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(
      "Would you like to ask another question? You can ask now or say no."
    )}`
  );

  res.type("text/xml").send(twiml.toString());
});

// ---------- Follow-up ----------
app.post("/handle-followup", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const raw = (req.body.SpeechResult || "").trim();
  const speech = raw.toLowerCase();

  if (!speech || ["no", "bye", "thanks", "thank you", "that is all"].some((w) => speech.includes(w))) {
    const sttLang = getSttLang(callSid);
    twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Thank you for calling. Goodbye.")}`);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // auto-switch lang for hospital
  const pref = detectLangPreference(raw);
  if (pref) setSession(callSid, { lang: pref });

  const sttLang = getSttLang(callSid);

  const result = await getAIAnswer(callSid, raw);
  twiml.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(result.say)}`);

  if (result.transfer) {
    if (!AGENT_NUMBER) {
      twiml.play(
        `${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent(
          "I cannot transfer right now because the agent number is not configured. Please try again later."
        )}`
      );
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

  gather.play(`${BASE_URL}/tts?lang=${encodeURIComponent(sttLang)}&text=${encodeURIComponent("Anything else you would like to know?")}`);

  res.type("text/xml").send(twiml.toString());
});

// ---------- Call Summary ----------
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
    mode: (getSession(callSid)?.mode || MODE),
    lang: (getSession(callSid)?.lang || null),
    summary: completion.choices?.[0]?.message?.content,
    transcript,
  });
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port, `MODE=${MODE}`));
