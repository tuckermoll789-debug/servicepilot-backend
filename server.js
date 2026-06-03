
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const { v4: uuidv4 } = require("uuid");
const { Resend } = require("resend");

const app = express();
const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, "[]");

function readLeads() {
  return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

async function saveLead(lead) {
  const { data, error } = await supabase
    .from("leads")
    .insert({
      source: lead.source,
      status: lead.status,
      call_sid: lead.callSid,
      caller_phone: lead.callerPhone,
      phone: lead.phone,
      name: lead.name,
      job_type: lead.jobType,
      location: lead.location,
      urgency: lead.urgency,
      preferred_time: lead.preferredTime,
      notes: lead.notes,
      score: lead.score,
      qualification: lead.qualification,
      recommended_action: lead.recommendedAction,
      company_id: lead.companyId
    })
    .select()
    .single();

  if (error) {
  console.error("Supabase save error:", JSON.stringify(error, null, 2));
  throw error;
}
  return data;
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

async function sendOwnerEmail(lead) {
  if (!process.env.NOTIFICATION_EMAIL) return;

  const resend = new Resend(process.env.RESEND_API_KEY);

  await resend.emails.send({
    from: "ServicePilot <onboarding@resend.dev>",
    to: process.env.NOTIFICATION_EMAIL,
    subject: `New ServicePilot Lead - ${lead.qualification}`,
    text: `
Name: ${lead.name}
Phone: ${lead.phone || lead.callerPhone}
Job Type: ${lead.jobType}
Location: ${lead.location}
Urgency: ${lead.urgency}
Preferred Time: ${lead.preferredTime}

Notes:
${lead.notes}

Recommended Action:
${lead.recommendedAction}
`
  });
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

  gatherNode.say({ voice: "Polly.Matthew" }, prompt);
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
    { voice: "Polly.Matthew" },
    "Thanks for calling. I'm the ServicePilot assistant. Im going to grab your info quick."
  );

  response.redirect(`/voice/name?callSid=${encodeURIComponent(callSid)}&callerPhone=${encodeURIComponent(callerPhone)}`);
  res.type("text/xml").send(response.toString());
});

app.post("/voice/name", (req, res) => {
  const response = new VoiceResponse();
  sayAndGather(
    response,
    "what's your name?",
    `/voice/job-type?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/job-type", (req, res) => {
  const response = new VoiceResponse();
  const name = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "what job do you need done",
    `/voice/location?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(name)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/location", (req, res) => {
  const response = new VoiceResponse();
  const jobType = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "Where are you located?",
    `/voice/urgency?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(jobType)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/urgency", (req, res) => {
  const response = new VoiceResponse();
  const location = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "is this an Emergency?",
    `/voice/preferred-time?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(location)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/preferred-time", (req, res) => {
  const response = new VoiceResponse();
  const urgency = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "When are you free for a call back?",
    `/voice/notes?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(req.query.location || "")}&urgency=${encodeURIComponent(urgency)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/notes", (req, res) => {
  const response = new VoiceResponse();
  const preferredTime = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "Any other details you need to say now?",
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

  lead.companyId = process.env.DEFAULT_COMPANY_ID;
  
  await saveLead(lead);

  try {
    await notifyOwner(lead);
    await sendOwnerEmail(lead);
  } catch (error) {
    console.error("Owner notification failed:", error.message);
  }

  response.say(
    { voice: "Polly.Matthew" },
    "I got your info sent over and we will be in touch soon. Thanks!"
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

  await saveLead(lead);

  try {
    await notifyOwner(lead);
  } catch (error) {
    console.error("Owner SMS notification failed:", error.message);
  }

  response.message("I got your info sent over and we will be in touch soon. Thanks!");
  res.type("text/xml").send(response.toString());
});

app.get("/api/leads", async (req, res) => {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("company_id", process.env.DEFAULT_COMPANY_ID)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const leads = data.map(lead => ({
    id: lead.id,
    source: lead.source,
    status: lead.status,
    callSid: lead.call_sid,
    callerPhone: lead.caller_phone,
    phone: lead.phone,
    name: lead.name,
    jobType: lead.job_type,
    location: lead.location,
    urgency: lead.urgency,
    preferredTime: lead.preferred_time,
    notes: lead.notes,
    score: lead.score,
    qualification: lead.qualification,
    recommendedAction: lead.recommended_action,
    createdAt: lead.created_at,
    lastUpdated: lead.last_updated
  }));

  res.json(leads);
});

app.patch("/api/leads/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const { data, error } = await supabase
    .from("leads")
    .update({
      status,
      last_updated: new Date().toISOString()
    })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("Supabase update error:", JSON.stringify(error, null, 2));
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.listen(PORT, () => {
  console.log(`ServicePilot backend running on http://localhost:${PORT}`);
});
