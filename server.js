import express from "express";

const app = express();

// Twilio sends form-encoded POST bodies
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("Cavas Voice Demo is running ✅");
});

// Helper: escape text for TwiML XML
function xmlEscape(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * /welcome
 * Supports GET (browser test) and POST (Twilio)
 * Returns TwiML that asks user to speak and posts to /handle-input
 */
function welcomeTwiML(req, res) {
  const baseUrl =
    process.env.BASE_URL?.replace(/\/$/, "") ||
    `${req.protocol}://${req.get("host")}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="en-US" speechTimeout="auto" action="${baseUrl}/handle-input" method="POST">
    <Say voice="alice" language="en-US">
      Hello! Welcome to Cavas AI admissions assistant.
      Please ask your question about admissions, courses, eligibility, fees, or application.
    </Say>
  </Gather>
  <Redirect method="POST">${baseUrl}/welcome</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
}

app.get("/welcome", welcomeTwiML);
app.post("/welcome", welcomeTwiML);

/**
 * Calls OpenAI Responses API to get an answer
 */
async function askOpenAI(question) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return "OpenAI API key is not configured yet. Please add OPENAI_API_KEY in Render environment variables.";
  }

  // Using Responses API (recommended in current docs) :contentReference[oaicite:0]{index=0}
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You are Cavas AI admissions assistant. Answer briefly (1-3 sentences), clear and confident. If unsure, ask one follow-up question.",
        },
        {
          role: "user",
          content: question,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return `Sorry, I had trouble generating an answer. (${resp.status})`;
  }

  const data = await resp.json();

  // Most responses include output_text; fallback if not present
  const out =
    data.output_text ||
    (data.output?.[0]?.content?.[0]?.text ?? "").trim() ||
    "Sorry, I couldn't generate a response.";

  // Keep it Twilio-friendly (short)
  return out.slice(0, 600);
}

/**
 * /handle-input
 * Receives Twilio speech result, asks OpenAI, speaks answer, loops
 */
app.post("/handle-input", async (req, res) => {
  const baseUrl =
    process.env.BASE_URL?.replace(/\/$/, "") ||
    `${req.protocol}://${req.get("host")}`;

  // Twilio sends SpeechResult in form body
  const userSpeech = (req.body?.SpeechResult || "").trim();

  let answer;
  if (!userSpeech) {
    answer =
      "Sorry, I didn't catch that. Please repeat your question about admissions.";
  } else {
    answer = await askOpenAI(userSpeech);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">${xmlEscape(answer)}</Say>
  <Pause length="1" />
  <Redirect method="POST">${baseUrl}/welcome</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
