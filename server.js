import express from "express";
import bodyParser from "body-parser";

const app = express();

// Twilio sends x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// Health check
app.get("/", (req, res) => {
  res.send("Cavas Voice Demo is running ✅");
});

/**
 * 1️⃣ WELCOME ROUTE
 */
app.post("/welcome", (req, res) => {
  res.type("text/xml");
  res.send(`
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Gather input="speech" language="en-US" speechTimeout="auto"
              action="/handle-input" method="POST">
        <Say voice="alice">
          Hello! Welcome to Cavas AI admissions assistant.
          Please ask your question about admissions.
        </Say>
      </Gather>
      <Redirect method="POST">/welcome</Redirect>
    </Response>
  `);
});

/**
 * 2️⃣ HANDLE INPUT ROUTE (TEMP DUMMY)
 */
app.post("/handle-input", (req, res) => {
  const speech = req.body.SpeechResult || "";

  console.log("User said:", speech);

  res.type("text/xml");
  res.send(`
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice">
        You asked: ${speech || "something I could not hear clearly"}.
        This will be answered by AI next.
      </Say>
      <Redirect method="POST">/welcome</Redirect>
    </Response>
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
