
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const { v4: uuidv4 } = require("uuid");
const { Resend } = require("resend");
const OpenAI = require("openai");

const app = express();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
      priority: lead.priority,
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

async function analyzeLeadWithAI(lead) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a lead qualification assistant.

Return ONLY valid JSON:

{
  "score": number,
  "qualification": "Hot Lead" | "Warm Lead" | "Cold Lead",
  "recommendedAction": string,
  "summary": string
}`
        },
        {
          role: "user",
          content: JSON.stringify(lead)
        }
      ],
      response_format: { type: "json_object" }
    });

    return JSON.parse(completion.choices[0].message.content);

  } catch (error) {
    console.error("AI analysis failed:", error.message);

    return {
      score: 50,
      qualification: "Needs Review",
      recommendedAction: "Call customer back",
      summary: "AI analysis unavailable"
    };
  }
}

function scoreLead(lead) {
  let score = 0;
  const text = `${lead.jobType || ""} ${lead.priority || ""} ${lead.notes || ""}`.toLowerCase();

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
    `priority: ${lead.priority || "Not captured"}`,
    `Preferred time: ${lead.preferredTime || "Not captured"}`,
    `Score: ${lead.score}`,
    `Action: Call back, text, approve appointment, or reschedule.`
  ].join("\n");
}

async function sendOwnerEmail(lead) {
  if (!lead.companyId) return;

const { data: company, error } = await supabase
  .from("companies")
  .select("notification_email")
  .eq("id", lead.companyId)
  .single();

if (error || !company?.notification_email) return;

  const resend = new Resend(process.env.RESEND_API_KEY);

  await resend.emails.send({
    from: "ServicePilot <onboarding@resend.dev>",
    to: company.notification_email,
    subject: `New ServicePilot Lead - ${lead.qualification}`,
    text: `
Name: ${lead.name}
Phone: ${lead.phone || lead.callerPhone}
Job Type: ${lead.jobType}
Location: ${lead.location}
priority: ${lead.priority}
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
app.post("/voice/start", async (req, res) => {
  const response = new VoiceResponse();
  const callSid = req.body.CallSid || "";
  const callerPhone = req.body.From || "";
  const { data: company } = await supabase
  .from("companies")
  .select("business_name, ai_prompt")
  .eq("id", process.env.DEFAULT_COMPANY_ID)
  .single();

const businessName = company?.business_name || "the business";

const introPrompt = `Thanks for calling ${businessName}. I'm going to grab your info quick.`;

  response.say(
  { voice: "Polly.Matthew" },
  introPrompt
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
    `/voice/priority?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(jobType)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/priority", (req, res) => {
  const response = new VoiceResponse();
  const location = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "how urgent is this — emergency, soon, or whenever available?",
    `/voice/preferred-time?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(location)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/preferred-time", (req, res) => {
  const response = new VoiceResponse();
  const priority = req.body.SpeechResult || "Not captured";
  const location = req.query.location || "";
  sayAndGather(
    response,
    "When are you free for a call back?",
    `/voice/notes?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(req.query.location || "")}&priority=${encodeURIComponent(priority)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/notes", (req, res) => {
  const response = new VoiceResponse();
  const preferredTime = req.body.SpeechResult || "Not captured";
  const location = req.query.location || "";
  const priority = req.query.priority || "";
  sayAndGather(
    response,
    "Any other details you need to say now?",
    `/voice/finish?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(req.query.location || "")}&priority=${encodeURIComponent(req.query.priority || "")}&preferredTime=${encodeURIComponent(preferredTime)}`
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
    priority: req.query.priority || "Not captured",
    preferredTime: req.query.preferredTime || "Not captured",
    notes,
    createdAt: new Date().toISOString()
  };

  const aiAnalysis = await analyzeLeadWithAI(lead);

lead.score = aiAnalysis.score;
lead.qualification = aiAnalysis.qualification;
lead.recommendedAction = aiAnalysis.recommendedAction;
lead.notes = lead.notes
  ? `${lead.notes}\n\nAI Summary: ${aiAnalysis.summary}`
  : aiAnalysis.summary;
  
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
    priority: body,
    preferredTime: "Not captured",
    notes: body,
    createdAt: new Date().toISOString()
  };

  const aiAnalysis = await analyzeLeadWithAI(lead);

lead.score = aiAnalysis.score;
lead.qualification = aiAnalysis.qualification;
lead.recommendedAction = aiAnalysis.recommendedAction;
lead.notes = lead.notes
  ? `${lead.notes}\n\nAI Summary: ${aiAnalysis.summary}`
  : aiAnalysis.summary;

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
    priority: lead.priority,
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
    .eq("company_id", process.env.DEFAULT_COMPANY_ID)
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
