
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

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");
const DASHBOARD_FILE = path.join(__dirname, "dashboard.html");
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

async function findCompanyByTwilioNumber(twilioNumber, columns) {
  const { data, error } = await supabase
    .from("companies")
    .select(columns)
    .eq("twilio_number", twilioNumber)
    .limit(1);

  if (error) throw error;

  return data && data[0];
}

async function requireCompanyAuth(req, res, next) {
  const authHeader = req.get("Authorization") || "";
  const authParts = authHeader.split(" ");
  const [scheme, accessToken] = authParts;

  if (authParts.length !== 2 || scheme !== "Bearer" || !accessToken) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);

    if (authError || !authData?.user?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: companyUsers, error: companyUserError } = await supabase
      .from("company_users")
      .select("company_id, role")
      .eq("auth_user_id", authData.user.id)
      .eq("active", true)
      .limit(1);

    if (companyUserError) {
      console.error("Company auth lookup failed:", companyUserError.message);
      return res.status(500).json({ error: "Authentication failed" });
    }

    const companyUser = companyUsers && companyUsers[0];

    if (!companyUser) {
      return res.status(403).json({ error: "Account is not active" });
    }

    req.authUserId = authData.user.id;
    req.companyId = companyUser.company_id;
    req.companyRole = companyUser.role;
    next();
  } catch (error) {
    console.error("Company auth failed:", error.message);
    return res.status(500).json({ error: "Authentication failed" });
  }
}

async function saveLead(lead) {
  if (!lead.companyId) {
    throw new Error("Cannot save lead without companyId");
  }

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
      priority: lead.priority || lead.urgency || "Not captured",
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
  res.sendFile(DASHBOARD_FILE);
});

app.get("/dashboard.html", (req, res) => {
  res.sendFile(DASHBOARD_FILE);
});

app.get("/api/auth-config", (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    appOrigin: process.env.APP_ORIGIN
  });
});

/**
 * Twilio Voice webhook:
 * POST https://your-domain.com/voice/start
 */
app.post("/voice/start", async (req, res) => {
  const response = new VoiceResponse();
  const callSid = req.body.CallSid || "";
  const callerPhone = req.body.From || "";
  const to = req.body.To || "";

  if (!to) {
    console.error("Voice call not started: missing inbound Twilio destination number.");
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not route this call right now. Please try again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  let company;

  try {
    company = await findCompanyByTwilioNumber(to, "id, business_name");
  } catch (error) {
    console.error("Voice call not started: company lookup failed for inbound Twilio number.", error.message);
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not route this call right now. Please try again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  if (!company) {
    console.error("Voice call not started: no company found for inbound Twilio destination number.");
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not route this call right now. Please try again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

const businessName = company?.business_name || "the business";

  response.say(
    { voice: "Polly.Matthew" },
    `Thanks for calling ${businessName}. I'm going to grab your info quick.`
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
  const urgency = req.body.SpeechResult || req.query.urgency || "Not captured";
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
  const urgency = req.query.urgency || "Not captured";
  sayAndGather(
    response,
    "Any other details you need to say now?",
    `/voice/finish?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(req.query.location || "")}&urgency=${encodeURIComponent(urgency)}&preferredTime=${encodeURIComponent(preferredTime)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/finish", async (req, res) => {
  const response = new VoiceResponse();
  const to = req.body.To || "";
  const notes = req.body.SpeechResult || "No extra notes";
  const urgency = req.query.urgency || "Not captured";

  if (!to) {
    console.error("Voice lead not created: missing inbound Twilio destination number.");
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your request right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  let company;

  try {
    company = await findCompanyByTwilioNumber(to, "id");
  } catch (error) {
    console.error("Voice lead not created: company lookup failed for inbound Twilio number.", error.message);
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your request right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  if (!company) {
    console.error("Voice lead not created: no company found for inbound Twilio destination number.");
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your request right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

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
    urgency,
    priority: urgency,
    preferredTime: req.query.preferredTime || "Not captured",
    notes,
    createdAt: new Date().toISOString(),
    companyId: company.id
  };

  lead.score = scoreLead(lead);
  lead.qualification = qualifyLead(lead.score);
  lead.recommendedAction =
    lead.score >= 70
      ? "Call customer now or approve appointment request"
      : "Call customer back and confirm details";

  try {
    await saveLead(lead);
  } catch (error) {
    console.error("Voice lead not created: Supabase save failed.", error.message);
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your request right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

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
  const to = req.body.To || "";
  const body = req.body.Body || "";

  if (!to) {
    console.error("SMS lead not created: missing inbound Twilio destination number.");
    return res.type("text/xml").send(response.toString());
  }

  const { data: companies, error: companyError } = await supabase
    .from("companies")
    .select("id")
    .eq("twilio_number", to)
    .limit(1);

  if (companyError) {
    console.error("SMS lead not created: company lookup failed for inbound Twilio number.", companyError.message);
    return res.type("text/xml").send(response.toString());
  }

  const company = companies && companies[0];

  if (!company) {
    console.error("SMS lead not created: no company found for inbound Twilio destination number.");
    return res.type("text/xml").send(response.toString());
  }

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
    createdAt: new Date().toISOString(),
    companyId: company.id
  };

  lead.score = scoreLead(lead);
  lead.qualification = qualifyLead(lead.score);
  lead.recommendedAction = "Text or call customer back";

  try {
    await saveLead(lead);
  } catch (error) {
    console.error("SMS lead not created: Supabase save failed.", error.message);
    return res.type("text/xml").send(response.toString());
  }

  try {
    await notifyOwner(lead);
  } catch (error) {
    console.error("Owner SMS notification failed:", error.message);
  }

  response.message("I got your info sent over and we will be in touch soon. Thanks!");
  res.type("text/xml").send(response.toString());
});

app.get("/api/leads", requireCompanyAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("company_id", req.companyId)
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
    urgency: lead.priority,
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

app.patch("/api/leads/:id", requireCompanyAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const { data, error } = await supabase
    .from("leads")
    .update({
      status,
      last_updated: new Date().toISOString()
    })
    .eq("id", id)
    .eq("company_id", req.companyId)
    .select()
    .maybeSingle();

  if (error) {
    console.error("Supabase update error:", JSON.stringify(error, null, 2));
    return res.status(500).json({ error: error.message });
  }

  if (!data) {
    return res.status(404).json({ error: "Lead not found" });
  }

  res.json(data);
});

app.listen(PORT, () => {
  console.log(`ServicePilot backend running on http://localhost:${PORT}`);
});
