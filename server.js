
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const { v4: uuidv4 } = require("uuid");

const app = express();
const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, "[]");

function readLeads() {
  return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function saveLead(lead) {
  const leads = readLeads();
  leads.unshift(lead);
  writeLeads(leads);
  return lead;
}

function scoreLead(lead) {
  let score = 0;
  const text = `${lead.jobType || ""} ${lead.urgency || ""} ${lead.notes || ""}`.toLowerCase();

  if (text.includes("emergency")) score += 40;
  if (text.includes("leak")) score += 35;
  if (text.includes("no heat")) score += 35;
  if (text.includes("water")) score += 25;
  if (text.includes("today") || text.includes("tomorrow") || text.includes("this week")) score += 25;
  if (lead.phone || lead.callerPhone) score += 15;
  if (lead.location) score += 10;

  return Math.min(score, 100);
}

function qualifyLead(score) {
  if (score >= 70) return "High intent";
  if (score >= 40) return "Medium intent";
  return "Needs follow-up";
}

function ownerSmsText(lead) {
  return [
    `New ServicePilot lead: ${lead.qualification}`,
    `Name: ${lead.name || "Not captured"}`,
    `Phone: ${lead.phone || lead.callerPhone || "Not captured"}`,
    `Job: ${lead.jobType || "Not captured"}`,
    `Location: ${lead.location || "Not captured"}`,
    `Urgency: ${lead.urgency || "Not captured"}`,
    `Preferred time: ${lead.preferredTime || "Not captured"}`,
    `Score: ${lead.score}`,
    `Action: Call back, text, approve appointment, or reschedule.`
  ].join("\n");
}

async function notifyOwner(lead) {
  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER,
    OWNER_PHONE_NUMBER
  } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !OWNER_PHONE_NUMBER) {
    console.log("Owner SMS skipped. Missing Twilio env vars.");
    console.log(ownerSmsText(lead));
    return;
  }

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: TWILIO_PHONE_NUMBER,
    to: OWNER_PHONE_NUMBER,
    body: ownerSmsText(lead)
  });
}

function sayAndGather(response, prompt, actionUrl) {
  const gatherNode = response.gather({
    input: "speech",
    action: actionUrl,
    method: "POST",
    speechTimeout: "auto",
    language: "en-US"
  });

  gatherNode.say({ voice: "alice" }, prompt);
  response.redirect(actionUrl);
}

app.get("/", (req, res) => {
  res.redirect("/dashboard.html");
});

/**
 * Twilio Voice webhook:
 * POST https://your-domain.com/voice/start
 */
app.post("/voice/start", (req, res) => {
  const response = new VoiceResponse();
  const callSid = req.body.CallSid || "";
  const callerPhone = req.body.From || "";

  response.say(
    { voice: "alice" },
    "Thanks for calling. I am the ServicePilot assistant. I will collect a few details and send them to the owner."
  );

  response.redirect(`/voice/name?callSid=${encodeURIComponent(callSid)}&callerPhone=${encodeURIComponent(callerPhone)}`);
  res.type("text/xml").send(response.toString());
});

app.post("/voice/name", (req, res) => {
  const response = new VoiceResponse();
  sayAndGather(
    response,
    "First, what is your name?",
    `/voice/job-type?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/job-type", (req, res) => {
  const response = new VoiceResponse();
  const name = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "Thanks. What type of job do you need help with? For example, roof leak, plumbing issue, H V A C repair, or landscaping estimate.",
    `/voice/location?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(name)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/location", (req, res) => {
  const response = new VoiceResponse();
  const jobType = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "What city or area is the job located in?",
    `/voice/urgency?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(jobType)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/urgency", (req, res) => {
  const response = new VoiceResponse();
  const location = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "How urgent is this? Is it an emergency, needed this week, or are you just getting quotes?",
    `/voice/preferred-time?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(location)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/preferred-time", (req, res) => {
  const response = new VoiceResponse();
  const urgency = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "What time works best for the owner to call you back or request an appointment?",
    `/voice/notes?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(req.query.location || "")}&urgency=${encodeURIComponent(urgency)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/notes", (req, res) => {
  const response = new VoiceResponse();
  const preferredTime = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "Last question. Is there anything else the owner should know?",
    `/voice/finish?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(req.query.location || "")}&urgency=${encodeURIComponent(req.query.urgency || "")}&preferredTime=${encodeURIComponent(preferredTime)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/finish", async (req, res) => {
  const response = new VoiceResponse();
  const notes = req.body.SpeechResult || "No extra notes";

  const lead = {
    id: uuidv4(),
    source: "Phone Call",
    status: "New",
    callSid: req.query.callSid || "",
    callerPhone: req.query.callerPhone || "",
    phone: req.query.callerPhone || "",
    name: req.query.name || "Not captured",
    jobType: req.query.jobType || "Not captured",
    location: req.query.location || "Not captured",
    urgency: req.query.urgency || "Not captured",
    preferredTime: req.query.preferredTime || "Not captured",
    notes,
    createdAt: new Date().toISOString()
  };

  lead.score = scoreLead(lead);
  lead.qualification = qualifyLead(lead.score);
  lead.recommendedAction =
    lead.score >= 70
      ? "Call customer now or approve appointment request"
      : "Call customer back and confirm details";

  saveLead(lead);

  try {
    await notifyOwner(lead);
  } catch (error) {
    console.error("Owner notification failed:", error.message);
  }

  response.say(
    { voice: "alice" },
    "Thank you. I sent your information to the owner. They can call you back, send a text, or approve an appointment request. Goodbye."
  );
  response.hangup();

  res.type("text/xml").send(response.toString());
});

/**
 * Twilio SMS webhook:
 * POST https://your-domain.com/sms
 */
app.post("/sms", async (req, res) => {
  const response = new MessagingResponse();
  const from = req.body.From || "";
  const body = req.body.Body || "";

  const lead = {
    id: uuidv4(),
    source: "SMS",
    status: "New",
    phone: from,
    callerPhone: from,
    name: "SMS Lead",
    jobType: body,
    location: "Not captured",
    urgency: body,
    preferredTime: "Not captured",
    notes: body,
    createdAt: new Date().toISOString()
  };

  lead.score = scoreLead(lead);
  lead.qualification = qualifyLead(lead.score);
  lead.recommendedAction = "Text or call customer back";

  saveLead(lead);

  try {
    await notifyOwner(lead);
  } catch (error) {
    console.error("Owner SMS notification failed:", error.message);
  }

  response.message("Thanks for reaching out. I sent your message to the owner. They can call or text you back soon.");
  res.type("text/xml").send(response.toString());
});

app.get("/api/leads", (req, res) => {
  res.json(readLeads());
});

app.patch("/api/leads/:id", (req, res) => {
  const leads = readLeads();
  const index = leads.findIndex((lead) => lead.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Lead not found" });

  leads[index] = { ...leads[index], ...req.body, lastUpdated: new Date().toISOString() };
  writeLeads(leads);
  res.json(leads[index]);
});

app.delete("/api/leads", (req, res) => {
  writeLeads([]);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`ServicePilot backend running on http://localhost:${PORT}`);
});
