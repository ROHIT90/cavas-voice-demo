import express from "express";
import twilio from "twilio";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));

const baseUrl = "https://cavas-voice-demo.onrender.com";

// ---- OpenAI client ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// ---- OpenAI answer ----
async function getAIAnswer(userSpeech) {
  if (!process.env.OPENAI_API_KEY) {
    return "OpenAI is not configured yet. Please add OPENAI_API_KEY in Render environment variables.";
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system =
    "You are Cavas AI admissions assistant. Answer clearly in 1 to 3 sentences. " +
    "If the user asks something unrelated to admissions, bring them back to admissions. " +
    "If you don't know, ask one clarification question.";

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userSpeech },
    ],
  });

  return (
    completion.choices?.[0]?.message?.content?.trim() ||
    "Sorry, I couldn't generate an answer. Please repeat your question."
  );
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

  twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);

  res.type("text/xml");
  res.send(twiml.toString());
});

// ---- Twilio handle speech -> OpenAI -> ElevenLabs -> Twilio Play ----
app.post("/handle-input", async (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    const userSpeech = (req.body.SpeechResult || "").trim();

    if (!userSpeech) {
      const retryText = "Sorry, I didn't catch that. Please repeat your question.";
      twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(retryText)}`);
      twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // small "thinking" line (feels real)
    const thinking = "Got it. Let me check that quickly.";
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(thinking)}`);

    const answer = await getAIAnswer(userSpeech);

    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(answer)}`);

    // loop again
    twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);

    res.type("text/xml");
    return res.send(twiml.toString());
  } catch (err) {
    console.error("handle-input error:", err?.message || err);
    const failText = "Sorry, there was a technical issue. Please try again.";
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(failText)}`);
    twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);
    res.type("text/xml");
    return res.send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
