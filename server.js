import express from "express";
import twilio from "twilio";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));

const baseUrl = "https://cavas-voice-demo.onrender.com";

// ---- OpenAI client ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- In-memory stores ---
// Last 10 messages (5 exchanges) for context
const convoStore = new Map(); // CallSid -> [{role,content}, ...]

// Full transcript for summary
const transcriptStore = new Map(); // CallSid -> [{ts,role,content}, ...]

// Keep last 10 messages for context
function getCallHistory(callSid) {
  if (!callSid) return [];
  return convoStore.get(callSid) || [];
}

function pushToHistory(callSid, role, content) {
  if (!callSid) return;
  const arr = convoStore.get(callSid) || [];
  arr.push({ role, content });
  while (arr.length > 10) arr.shift();
  convoStore.set(callSid, arr);
}

// Full transcript for summary
function pushToTranscript(callSid, role, content) {
  if (!callSid) return;
  const arr = transcriptStore.get(callSid) || [];
  arr.push({ ts: new Date().toISOString(), role, content });
  transcriptStore.set(callSid, arr);
}

function getTranscript(callSid) {
  if (!callSid) return [];
  return transcriptStore.get(callSid) || [];
}

// Optional cleanup
setInterval(() => {
  const MAX_CALLS = 200;
  if (convoStore.size <= MAX_CALLS && transcriptStore.size <= MAX_CALLS) return;

  const trimMap = (m) => {
    const extra = m.size - MAX_CALLS;
    if (extra <= 0) return;
    const keys = m.keys();
    for (let i = 0; i < extra; i++) m.delete(keys.next().value);
  };

  trimMap(convoStore);
  trimMap(transcriptStore);
}, 60_000);

// ---- ElevenLabs TTS helper ----
async function elevenTTS(text) {
  if (!process.env.ELEVEN_API_KEY) throw new Error("Missing ELEVEN_API_KEY");
  if (!process.env.ELEVEN_VOICE_ID) throw new Error("Missing ELEVEN_VOICE_ID");

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
    timeout: 30000,
  });

  return Buffer.from(r.data);
}

// Serve audio for Twilio <Play>
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "").toString();
    if (!text) return res.status(400).send("Missing text");

    const audio = await elevenTTS(text);
    res.set("Content-Type", "audio/mpeg");
    res.set("Cache-Control", "no-store");
    res.send(audio);
  } catch (err) {
    console.error("TTS error:", err?.response?.status, err?.response?.data || err.message);
    res.status(500).send("TTS failed");
  }
});

// Health check
app.get("/", (req, res) => res.send("Cavas Voice Demo is running ✅"));

// ---- Call Summary endpoint ----
// Visit: /call-summary?callSid=CAxxxx
app.get("/call-summary", async (req, res) => {
  try {
    const callSid = (req.query.callSid || "").toString().trim();
    if (!callSid) return res.status(400).json({ error: "Missing callSid" });

    const transcript = getTranscript(callSid);
    if (!transcript.length) return res.status(404).json({ error: "No transcript found for this callSid" });

    // Optional: create a short AI summary
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const text = transcript
      .map((x) => `${x.role.toUpperCase()}: ${x.content}`)
      .join("\n");

    let summary = "";
    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "Summarize this admissions call in 5 bullet points. Include key intent, asked questions, and next step.",
          },
          { role: "user", content: text.slice(-6000) }, // safety cap
        ],
      });
      summary = completion.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
      summary = "(OpenAI summary unavailable)";
    }

    return res.json({
      callSid,
      messageCount: transcript.length,
      summary,
      transcript,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- OpenAI answer with memory (last 5 exchanges) ----
async function getAIAnswer(callSid, userSpeech) {
  if (!process.env.OPENAI_API_KEY) {
    return "OpenAI is not configured yet. Please add OPENAI_API_KEY in Render environment variables.";
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system =
    "You are Cavas AI admissions assistant. " +
    "Maintain context from the conversation. " +
    "Answer clearly in 1 to 3 sentences. " +
    "If unsure, ask one clarification question. " +
    "If user asks something unrelated, bring them back to admissions.";

  const history = getCallHistory(callSid);

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userSpeech },
    ],
  });

  const answer =
    completion.choices?.[0]?.message?.content?.trim() ||
    "Sorry, I couldn't generate an answer. Please repeat your question.";

  // Save into memory + full transcript
  pushToHistory(callSid, "user", userSpeech);
  pushToHistory(callSid, "assistant", answer);

  pushToTranscript(callSid, "user", userSpeech);
  pushToTranscript(callSid, "assistant", answer);

  return answer;
}

// ---- Twilio welcome ----
app.post("/welcome", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    language: "en-US",
    speechTimeout: "auto",
    action: `${baseUrl}/handle-input`,
    method: "POST",
  });

  const welcomeText =
    "Hello! Welcome to Cavas AI admissions assistant. Please ask your question about admissions, courses, eligibility, fees, or application.";

  gather.play(`${baseUrl}/tts?text=${encodeURIComponent(welcomeText)}`);

  // If user says nothing, give one more chance then hang up
  twiml.play(`${baseUrl}/tts?text=${encodeURIComponent("If you are still there, please ask your question now.")}`);
  twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);

  res.type("text/xml");
  res.send(twiml.toString());
});

// ---- Twilio handle speech -> OpenAI -> ElevenLabs -> gather follow-up ----
app.post("/handle-input", async (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    const callSid = req.body.CallSid || req.query.CallSid;
    const userSpeech = (req.body.SpeechResult || "").trim();

    if (!userSpeech) {
      const retryText = "Sorry, I didn't catch that. Please repeat your question.";
      const gather = twiml.gather({
        input: "speech",
        language: "en-US",
        speechTimeout: "auto",
        action: `${baseUrl}/handle-input`,
        method: "POST",
      });
      gather.play(`${baseUrl}/tts?text=${encodeURIComponent(retryText)}`);

      res.type("text/xml");
      return res.send(twiml.toString());
    }

    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent("Got it. One moment.")}`);

    const answer = await getAIAnswer(callSid, userSpeech);
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(answer)}`);

    const followUpText =
      "Would you like to ask another question? You can say your next question now, or say no to end the call.";

    const gather = twiml.gather({
      input: "speech",
      language: "en-US",
      speechTimeout: "auto",
      action: `${baseUrl}/handle-followup`,
      method: "POST",
    });

    gather.play(`${baseUrl}/tts?text=${encodeURIComponent(followUpText)}`);

    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent("No response received. Thank you for calling. Goodbye.")}`);
    twiml.hangup();

    res.type("text/xml");
    return res.send(twiml.toString());
  } catch (err) {
    console.error("handle-input error:", err?.message || err);
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent("Sorry, there was a technical issue. Please try again.")}`);
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }
});

app.post("/handle-followup", async (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const callSid = req.body.CallSid || req.query.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const lower = speech.toLowerCase();

  // Save what user said into transcript even if they say "no"
  if (speech) pushToTranscript(callSid, "user", speech);

  const noWords = [
    "no",
    "nope",
    "nah",
    "nothing",
    "that's all",
    "that is all",
    "bye",
    "goodbye",
    "thanks",
    "thank you",
  ];
  const saidNo = noWords.some((w) => lower.includes(w));

  if (saidNo) {
    const goodbye = "Thank you for calling. Goodbye.";
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(goodbye)}`);
    pushToTranscript(callSid, "assistant", goodbye);
    twiml.hangup();

    // Helpful for you: log where to see summary
    console.log("Call ended. Summary URL:", `${baseUrl}/call-summary?callSid=${callSid}`);

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const onlyYes = ["yes", "yeah", "yep", "sure"].includes(lower) || lower.length < 3;
  if (onlyYes) {
    const gather = twiml.gather({
      input: "speech",
      language: "en-US",
      speechTimeout: "auto",
      action: `${baseUrl}/handle-input`,
      method: "POST",
    });
    gather.play(`${baseUrl}/tts?text=${encodeURIComponent("Sure. Please ask your next admissions question.")}`);

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Treat as next question
  try {
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent("Got it. One moment.")}`);

    const answer = await getAIAnswer(callSid, speech);
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(answer)}`);

    const gather = twiml.gather({
      input: "speech",
      language: "en-US",
      speechTimeout: "auto",
      action: `${baseUrl}/handle-followup`,
      method: "POST",
    });
    gather.play(`${baseUrl}/tts?text=${encodeURIComponent("Anything else you want to know?")}`);

    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent("No response received. Thank you for calling. Goodbye.")}`);
    twiml.hangup();

    res.type("text/xml");
    return res.send(twiml.toString());
  } catch (e) {
    console.error("handle-followup error:", e?.message || e);
    const msg = "Sorry, I faced an issue. Please call again later. Goodbye.";
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(msg)}`);
    pushToTranscript(callSid, "assistant", msg);
    twiml.hangup();

    res.type("text/xml");
    return res.send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
