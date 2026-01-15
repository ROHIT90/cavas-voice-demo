import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Cavas Voice Demo is running ✅");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
