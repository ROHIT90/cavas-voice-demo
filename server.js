import express from "express";
import twilio from "twilio";

const app = express();

// Twilio sends form-encoded POST bodies
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/", (req, res) => {
  res.send("Cavas Voice Demo is running ✅");
});

// IMPORTANT: Twilio will POST to this URL when a call comes in
app.post("/welcome", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const baseUrl = "https://cavas-voice-demo.onrender.com"; // <-- keep https

  const gather = twiml.gather({
    input: "speech",
    language: "en-US",
    speechTimeout: "auto",
    action: `${baseUrl}/handle-input`,
    method: "POST",
  });

  gather.say(
    { voice: "alice", language: "en-US" },
    "Hello! Welcome to Cavas AI admissions assistant. Please ask your question about admissions, courses, eligibility, fees, or application."
  );

  // Loop if user says nothing
  twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);

  res.type("text/xml");
  res.send(twiml.toString());
});

// Twilio will POST recognized speech here
app.post("/handle-input", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const baseUrl = "https://cavas-voice-demo.onrender.com"; // <-- keep https

  const userSpeech = req.body.SpeechResult || "";
  const text = userSpeech.toLowerCase();

  let reply =
    "Sorry, I didn't catch that. Please ask about admissions, courses, eligibility, fees, or application.";

  if (text.includes("mba")) {
    reply =
      "We offer a two year MBA program with specializations in International Business, Marketing, and Finance.";
  } else if (text.includes("fee")) {
    reply = "The approximate fees for the MBA program are three point five lakh rupees per year.";
  } else if (text.includes("eligibility")) {
    reply =
      "Eligibility is graduation from a recognized university and a valid entrance exam score.";
  } else if (text.includes("application") || text.includes("apply")) {
    reply =
      "You can apply online through the university website. The application process usually starts in January.";
  }

  twiml.say({ voice: "alice", language: "en-US" }, reply);

  // Ask again (loop)
  twiml.redirect({ method: "POST" }, `${baseUrl}/welcome`);

  res.type("text/xml");
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
