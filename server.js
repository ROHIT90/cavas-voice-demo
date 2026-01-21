import express from "express";
import twilio from "twilio";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));

const baseUrl = "https://cavas-voice-demo.onrender.com";

// ---------- OpenAI ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Memory Stores ----------
const convoStore = new Map();      // CallSid -> last 10 messages
const transcriptStore = new Map(); // CallSid -> full transcript

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

// ---------- ElevenLabs TTS ----------
async function elevenTTS(text) {
  const r = await axios({
    method: "POST",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}`,
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
    const audio = await elevenTTS(req.query.text);
    res.set("Content-Type", "audio/mpeg");
    res.set("Cache-Control", "no-store");
    res.send(audio);
  } catch {
    res.status(500).send("TTS failed");
  }
});

// ---------- Health ----------
app.get("/", (_, res) =>
  res.send("Cavas Voice Demo is running ✅")
);

// ---------- AI Answer ----------
async function getAIAnswer(callSid, userText) {
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
    completion.choices[0].message.content ||
    "Sorry, I could not answer that.";

  pushHistory(callSid, "user", userText);
  pushHistory(callSid, "assistant", answer);

  pushTranscript(callSid, "user", userText);
  pushTranscript(callSid, "assistant", answer);

  return answer;
}

// ---------- Welcome ----------
app.post("/welcome", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    bargeIn: true,
    language: "en-US",
    speechTimeout: "auto",
    action: `${baseUrl}/handle-input`,
    method: "POST",
  });

  gather.play(
    `${baseUrl}/tts?text=${encodeURIComponent(
      "Hello! Welcome to Cavas AI admissions assistant. How can I help you today?"
    )}`
  );

  res.type("text/xml").send(twiml.toString());
});

// ---------- First + Next ----------
app.post("/handle-input", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  if (!speech) {
    twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);
    return res.type("text/xml").send(twiml.toString());
  }

  const answer = await getAIAnswer(callSid, speech);
  twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(answer)}`);

  const gather = twiml.gather({
    input: "speech",
    bargeIn: true,
    language: "en-US",
    speechTimeout: "auto",
    action: `${baseUrl}/handle-followup`,
    method: "POST",
  });

  gather.play(
    `${baseUrl}/tts?text=${encodeURIComponent(
      "Would you like to ask another question? You can ask now or say no."
    )}`
  );

  res.type("text/xml").send(twiml.toString());
});

// ---------- Follow-up ----------
app.post("/handle-followup", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim().toLowerCase();

  if (!speech || ["no", "bye", "thanks", "thank you"].some(w => speech.includes(w))) {
    twiml.play(
      `${baseUrl}/tts?text=${encodeURIComponent(
        "Thank you for calling. Goodbye."
      )}`
    );
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  const answer = await getAIAnswer(callSid, speech);
  twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(answer)}`);

  const gather = twiml.gather({
    input: "speech",
    bargeIn: true,
    language: "en-US",
    speechTimeout: "auto",
    action: `${baseUrl}/handle-followup`,
    method: "POST",
  });

  gather.play(
    `${baseUrl}/tts?text=${encodeURIComponent(
      "Anything else you would like to know?"
    )}`
  );

  res.type("text/xml").send(twiml.toString());
});

// ---------- Call Summary ----------
app.get("/call-summary/:callSid", async (req, res) => {
  const { callSid } = req.params;
  const transcript = getTranscript(callSid);

  if (!transcript.length) {
    return res.status(404).json({ error: "No transcript found" });
  }

  const text = transcript
    .map(x => `${x.role.toUpperCase()}: ${x.content}`)
    .join("\n");

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Summarize this admissions call in 5 bullet points with next steps.",
      },
      { role: "user", content: text.slice(-6000) },
    ],
  });

  res.json({
    callSid,
    summary: completion.choices[0].message.content,
    transcript,
  });
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log("Listening on", port)
);
