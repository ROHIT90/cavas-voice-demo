import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();

// Twilio sends form-encoded body by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function absoluteUrl(req, path) {
  // Render sets x-forwarded-proto, x-forwarded-host
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}${path}`;
}

app.get("/", (req, res) => {
  res.send("Cavas Voice Demo is running ✅");
});

/**
 * Twilio Voice webhook (POST)
 * Configure your Twilio number "A call comes in" -> Webhook -> POST -> https://.../welcome
 */
app.post("/welcome", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    language: "en-US",
    speechTimeout: "auto",
    action: absoluteUrl(req, "/handle-input"), // IMPORTANT: absolute URL to your server
    method: "POST",
  });

  gather.say(
    { voice: "alice", language: "en-US" },
    "Hello! Welcome to Cavas AI admissions assistant. Please ask your question about admissions."
  );

  // If user stays silent, loop back
  twiml.redirect({ method: "POST" }, absoluteUrl(req, "/welcome"));

  res.type("text/xml");
  res.send(twiml.toString());
});

/**
 * Handles the user's speech result. Twilio posts SpeechResult in form data.
 */
app.post("/handle-input", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const userText = (req.body?.SpeechResult || "").trim();

  if (!userText) {
    twiml.say(
      { voice: "alice", language: "en-US" },
      "Sorry, I didn't catch that. Please repeat your question."
    );
    twiml.redirect({ method: "POST" }, absoluteUrl(req, "/welcome"));
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Give Twilio a small filler while OpenAI responds
  twiml.say({ voice: "alice", language: "en-US" }, "Got it. One moment.");

  try {
    // Simple “real AI” answer. You can tighten with your own KB rules later.
    const system = `
You are Cavas AI admissions assistant.
Answer clearly and briefly (2-5 sentences).
If the user asks something you don't know, ask 1-2 follow-up questions.
Do NOT invent exact dates or fees. If needed, say "Please confirm on the official website".
`;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system.trim() },
        { role: "user", content: userText },
      ],
    });

    const answer =
      response.output_text?.trim() ||
      "Thanks. Could you please share which program and which intake year you're asking about?";

    twiml.say({ voice: "alice", language: "en-US" }, answer);
  } catch (err) {
    console.error("OpenAI error:", err?.message || err);
    twiml.say(
      { voice: "alice", language: "en-US" },
      "Sorry, I'm having trouble connecting to the knowledge service. Please try again in a moment."
    );
  }

  // Keep the conversation going
  twiml.redirect({ method: "POST" }, absoluteUrl(req, "/welcome"));

  res.type("text/xml");
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
