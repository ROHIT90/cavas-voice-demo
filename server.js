import express from "express";
import twilio from "twilio";
import axios from "axios";

const app = express();

// Twilio sends form-encoded POST bodies
app.use(express.urlencoded({ extended: false }));

const baseUrl = "https://cavas-voice-demo.onrender.com"; // keep https

// Health check
app.get("/", (req, res) => {
  res.send("Cavas Voice Demo is running ✅");
});

// -------- ElevenLabs helper --------
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
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    responseType: "arraybuffer",
  });

  return Buffer.from(r.data);
}

// This endpoint returns MP3 audio for Twilio <Play>
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "").toString();
    if (!text) return res.status(400).send("Missing text");

    const audio = await elevenTTS(text);

    res.set("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    console.error("TTS error:", err?.response?.data || err.message);
    res.status(500).send("TTS failed");
  }
});

// IMPORTANT: Twilio will POST to this URL when a call comes in
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

  // Use ElevenLabs by playing audio from our /tts endpoint
  const welcomeText =
    "Hello! Welcome to Cavas AI admissions assistant. Please ask your question about admissions, courses, eligibility, fees, or application.";

  gather.play(`${baseUrl}/tts?text=${encodeURIComponent(welcomeText)}`);

  // Loop if user says nothing
  twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);

  res.type("text/xml");
  res.send(twiml.toString());
});

// Twilio will POST recognized speech here
app.post("/handle-input", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const userSpeech = req.body.SpeechResult || "";
  const text = userSpeech.toLowerCase();

  let reply =
    "Sorry, I didn't catch that. Please ask about admissions, courses, eligibility, fees, or application.";

  if (text.includes("mba")) {
    reply =
      "We offer a two year MBA program with specializations in International Business, Marketing, and Finance.";
  } else if (text.includes("fee")) {
    reply =
      "The approximate fees for the MBA program are three point five lakh rupees per year.";
  } else if (text.includes("eligibility")) {
    reply =
      "Eligibility is graduation from a recognized university and a valid entrance exam score.";
  } else if (text.includes("application") || text.includes("apply")) {
    reply =
      "You can apply online through the university website. The application process usually starts in January.";
  }

  // Play ElevenLabs audio
  twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(reply)}`);

  // Ask again (loop)
  twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);

  res.type("text/xml");
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
