import express from "express";

const app = express();

// Twilio sends form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/", (req, res) => {
  res.send("Cavas Voice Demo is running ✅");
});

// (Optional) so your browser doesn't show "Cannot GET /welcome"
app.get("/welcome", (req, res) => {
  res.send("OK ✅ Use POST /welcome from Twilio");
});

// ✅ Twilio entrypoint (set this in Twilio Voice -> A call comes in)
app.post("/welcome", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Gather input="speech" language="en-US" speechTimeout="auto" action="/handle-input" method="POST">
    <Say voice="alice" language="en-US">
      Hello! Welcome to Cavas AI admissions assistant. Please ask your question about admissions.
    </Say>
  </Gather>
  <Redirect>/welcome</Redirect>
</Response>
  `.trim());
});

// ✅ Receives speech text from Twilio
app.post("/handle-input", (req, res) => {
  const userSpeech = (req.body.SpeechResult || "").toLowerCase();

  let reply = "Sorry, I didn’t catch that. Please ask about fees, eligibility, MBA, or application process.";

  if (userSpeech.includes("mba")) {
    reply = "We offer a two year MBA program with specializations in International Business, Marketing, and Finance.";
  } else if (userSpeech.includes("fee")) {
    reply = "The approximate fees are three point five lakh rupees per year.";
  } else if (userSpeech.includes("eligib")) {
    reply = "Eligibility is graduation from a recognized university and qualifying the entrance exam.";
  } else if (userSpeech.includes("apply") || userSpeech.includes("application")) {
    reply = "You can apply online through the university website. The application process typically starts in January.";
  } else if (userSpeech.trim().length > 0) {
    reply = `You asked: ${req.body.SpeechResult}. For admissions, you can ask about fees, eligibility, or how to apply.`;
  }

  res.type("text/xml");
  res.send(`
<Response>
  <Say voice="alice" language="en-US">${escapeXml(reply)}</Say>
  <Redirect>/welcome</Redirect>
</Response>
  `.trim());
});

function escapeXml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
