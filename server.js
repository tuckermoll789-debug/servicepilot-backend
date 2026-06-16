
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

app.set("etag", false);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");
const DASHBOARD_FILE = path.join(__dirname, "dashboard.html");
const ADMIN_FILE = path.join(__dirname, "admin.html");
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

function preventCache(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0"
  });
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

async function requirePlatformAdmin(req, res, next) {
  preventCache(res);
  const authHeader = req.get("Authorization") || "";
  const authParts = authHeader.split(" ");
  const [scheme, accessToken] = authParts;

  if (authParts.length !== 2 || scheme !== "Bearer" || !accessToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);

    if (authError || !authData?.user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { data: platformAdmins, error: platformAdminError } = await supabase
      .from("platform_admins")
      .select("role")
      .eq("auth_user_id", authData.user.id)
      .eq("active", true)
      .in("role", ["platform_owner", "platform_admin"])
      .limit(1);

    if (platformAdminError) {
      console.error("Platform admin lookup failed:", platformAdminError.message);
      return res.status(500).json({ error: "Authentication failed" });
    }

    const platformAdmin = platformAdmins && platformAdmins[0];

    if (!platformAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    req.authUserId = authData.user.id;
    req.platformAdminRole = platformAdmin.role;
    next();
  } catch (error) {
    console.error("Platform admin auth failed:", error.message);
    return res.status(500).json({ error: "Authentication failed" });
  }
}

function safeOnboardingError(res, status, error, code, extra = {}) {
  return res.status(status).json({ error, code, ...extra });
}

function normalizeOnboardingBody(body) {
  return {
    businessName: String(body?.businessName || "").trim(),
    ownerEmail: String(body?.ownerEmail || "").trim().toLowerCase(),
    notificationEmail: String(body?.notificationEmail || "").trim().toLowerCase(),
    twilioNumber: String(body?.twilioNumber || "").trim(),
    aiPrompt: body?.aiPrompt === undefined || body?.aiPrompt === null
      ? null
      : String(body.aiPrompt).trim() || null
  };
}

function validateOnboardingBody(body) {
  const allowedFields = new Set([
    "businessName",
    "ownerEmail",
    "notificationEmail",
    "twilioNumber",
    "aiPrompt"
  ]);
  const forbiddenFields = new Set([
    "company_id",
    "companyId",
    "auth_user_id",
    "authUserId",
    "platformAdminRole",
    "platformRole",
    "role",
    "customerRole",
    "active",
    "redirectTo"
  ]);

  for (const field of Object.keys(body || {})) {
    if (forbiddenFields.has(field) || !allowedFields.has(field)) {
      return "UNEXPECTED_ONBOARDING_FIELD";
    }
  }

  const details = normalizeOnboardingBody(body);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const e164Pattern = /^\+[1-9][0-9]{7,14}$/;

  if (!details.businessName || details.businessName.length > 120) {
    return "INVALID_BUSINESS_NAME";
  }

  if (!emailPattern.test(details.ownerEmail)) {
    return "INVALID_OWNER_EMAIL";
  }

  if (!emailPattern.test(details.notificationEmail)) {
    return "INVALID_NOTIFICATION_EMAIL";
  }

  if (!e164Pattern.test(details.twilioNumber)) {
    return "INVALID_TWILIO_NUMBER";
  }

  if (details.aiPrompt && details.aiPrompt.length > 4000) {
    return "INVALID_AI_PROMPT";
  }

  return null;
}

function validateHttpsOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch (error) {
    return null;
  }
}

function requireValidTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const validatedAppOrigin = validateHttpsOrigin(process.env.APP_ORIGIN);

  if (!authToken || !validatedAppOrigin) {
    console.error("Twilio webhook validation is unavailable.");
    return res.status(500).type("text/plain").send("Webhook validation unavailable");
  }

  try {
    const signature = req.get("X-Twilio-Signature") || "";
    const webhookUrl = `${validatedAppOrigin}${req.originalUrl}`;
    const isValid = twilio.validateRequest(authToken, signature, webhookUrl, req.body);

    if (!isValid) {
      return res.status(403).type("text/plain").send("Forbidden");
    }

    next();
  } catch (error) {
    console.error("Twilio webhook validation failed unexpectedly.");
    return res.status(403).type("text/plain").send("Forbidden");
  }
}

async function findAuthUserByEmail(email) {
  const perPage = 1000;
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) throw error;

    const users = data?.users || [];
    const matchingUser = users.find(user =>
      String(user?.email || "").toLowerCase() === email
    );

    if (matchingUser) return matchingUser;
    if (users.length < perPage) return null;
  }

  throw new Error("Auth user lookup exceeded maximum pages");
}

function isConflictError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return code === "23505" ||
    code === "409" ||
    message.includes("duplicate") ||
    message.includes("unique") ||
    message.includes("conflict");
}

function companyResponseFromRecord(company) {
  return {
    id: company.id,
    businessName: company.business_name,
    notificationEmail: company.notification_email,
    twilioNumber: company.twilio_number
  };
}

function firstCompanyRecord(data) {
  if (Array.isArray(data)) return data[0];
  return data;
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
      call_type: lead.callType || "New Lead",
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
  const callType = lead.callType || "New Lead";
  const phone = lead.phone || lead.callerPhone || "Not captured";
  const name = lead.name || "Not captured";
  let subject = `New ServicePilot Lead - ${lead.qualification}`;
  let text = `
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
`;

  if (callType === "Existing Customer") {
    subject = `Existing customer callback needed: ${name}`;
    text = `
Call type: ${callType}
Name: ${name}
Phone: ${phone}
Job address: ${lead.location || "Not captured"}
Reason: ${lead.notes || "Not captured"}
Urgency: ${lead.urgency || "Not captured"}
Preferred callback time: ${lead.preferredTime || "Not captured"}
Recommended action: ${lead.recommendedAction || "Contact the existing customer and review the related job or appointment."}
`;
  } else if (callType === "General Message") {
    const callbackRequested = lead.preferredTime && lead.preferredTime !== "Not requested" ? "Yes" : "No";
    subject = `New general message: ${name}`;
    text = `
Call type: ${callType}
Name: ${name}
Phone: ${phone}
Organization: ${lead.jobType || "General Message"}
Message: ${lead.notes || "Not captured"}
Callback requested: ${callbackRequested}
Preferred callback time: ${lead.preferredTime || "Not requested"}
Recommended action: ${lead.recommendedAction || "Review the message."}
`;
  }

  await resend.emails.send({
    from: "ServicePilot <onboarding@resend.dev>",
    to: company.notification_email,
    subject,
    text
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

function sayAndGatherLongSpeech(response, prompt, actionUrl) {
  const gatherNode = response.gather({
    input: "speech",
    action: actionUrl,
    method: "POST",
    speechTimeout: 2,
    language: "en-US"
  });

  gatherNode.say({ voice: "Polly.Matthew" }, prompt);
  response.redirect(actionUrl);
}

function gatherClassification(response, businessName, actionUrl) {
  const prompt = `Thanks for calling ${businessName}. I'm the automated assistant helping while the team is unavailable. For a new service request, press or say 1. For an existing job or appointment, press or say 2. For anything else, press or say 3.`;
  const gatherNode = response.gather({
    input: "speech dtmf",
    numDigits: 1,
    action: actionUrl,
    method: "POST",
    speechTimeout: "auto",
    language: "en-US"
  });

  gatherNode.say({ voice: "Polly.Matthew" }, prompt);
  response.redirect(actionUrl);
}

function classifyCallType(digits, speechResult) {
  const digit = String(digits || "").trim();
  if (digit === "1") return "New Lead";
  if (digit === "2") return "Existing Customer";
  if (digit === "3") return "General Message";

  const speech = String(speechResult || "").toLowerCase();
  const normalizedSpeech = speech.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!speech) return null;

  if (["one", "1", "number one"].includes(normalizedSpeech)) return "New Lead";
  if (["two", "2", "number two"].includes(normalizedSpeech)) return "Existing Customer";
  if (["three", "3", "number three"].includes(normalizedSpeech)) return "General Message";

  if (
    speech.includes("new service") ||
    speech.includes("new request") ||
    speech.includes("service request") ||
    speech.includes("new lead") ||
    speech.includes("new customer") ||
    speech.includes("estimate") ||
    speech.includes("quote")
  ) {
    return "New Lead";
  }

  if (
    speech.includes("existing job") ||
    speech.includes("existing appointment") ||
    speech.includes("current customer") ||
    speech.includes("existing customer") ||
    speech.includes("reschedule") ||
    speech.includes("warranty") ||
    speech.includes("billing") ||
    speech.includes("job status") ||
    speech.includes("current appointment") ||
    speech.includes("appointment status") ||
    speech.includes("reschedule appointment")
  ) {
    return "Existing Customer";
  }

  if (
    speech.includes("something else") ||
    speech.includes("general message") ||
    speech.includes("vendor") ||
    speech.includes("employee") ||
    normalizedSpeech === "other" ||
    /\bother\b/.test(normalizedSpeech)
  ) {
    return "General Message";
  }

  return null;
}

function wantsCallback(digits, speechResult) {
  const digit = String(digits || "").trim();
  if (digit === "1") return true;
  if (digit === "2") return false;

  const normalizedSpeech = String(speechResult || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalizedSpeech) return null;

  if (
    normalizedSpeech === "no" ||
    normalizedSpeech === "no callback" ||
    normalizedSpeech.includes("do not call") ||
    normalizedSpeech.includes("don t call") ||
    normalizedSpeech.includes("dont call") ||
    normalizedSpeech.includes("never call") ||
    normalizedSpeech.includes("don t need a callback") ||
    normalizedSpeech.includes("dont need a callback") ||
    normalizedSpeech.includes("not needed")
  ) {
    return false;
  }

  if (
    normalizedSpeech === "yes" ||
    normalizedSpeech === "yes please" ||
    normalizedSpeech.includes("call me") ||
    normalizedSpeech.includes("would like a callback")
  ) {
    return true;
  }

  return null;
}

function organizationOrGeneralMessage(organization) {
  const value = String(organization || "").replace(/\s+/g, " ").trim();
  const normalized = value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\w'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedWithoutApostrophes = normalized
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const negativeOrganizationResponses = new Set([
    "none",
    "no",
    "no organization",
    "no company",
    "no business",
    "i dont have a business",
    "i dont have a business organization",
    "i dont have an organization",
    "i dont have an organization name",
    "i dont have a company",
    "i am not calling from an organization",
    "i am not calling from any organization",
    "i am not with a company",
    "i am not with any company",
    "i am not with any organization",
    "im not calling from an organization",
    "im not calling from any organization",
    "im not with a company",
    "im not with any company",
    "im not with any organization",
    "no this is a personal call",
    "this is a personal call",
    "this is just a personal call",
    "just myself",
    "not applicable",
    "n a"
  ]);
  const negativeOrganizationPatterns = [
    /^i (?:do not|dont) have (?:a|an|any) (?:business(?: organization)?|organization(?: name)?|company)$/,
    /^i (?:am|m) not with (?:a|any) (?:company|organization)$/,
    /^(?:no )?this is (?:just )?a personal call$/
  ];

  if (
    !value ||
    negativeOrganizationResponses.has(normalizedWithoutApostrophes) ||
    negativeOrganizationPatterns.some((pattern) => pattern.test(normalizedWithoutApostrophes))
  ) {
    return "General Message";
  }
  return value;
}

function generalMessageCallerName(name) {
  const value = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:my name is|this is|i am|i'm|i’m|you can call me)\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return value || "Not captured";
}

app.get("/", (req, res) => {
  preventCache(res);
  res.sendFile(DASHBOARD_FILE);
});

app.get("/dashboard.html", (req, res) => {
  preventCache(res);
  res.sendFile(DASHBOARD_FILE);
});

app.get("/admin", (req, res) => {
  preventCache(res);
  res.sendFile(ADMIN_FILE);
});

app.get("/admin.html", (req, res) => {
  preventCache(res);
  res.sendFile(ADMIN_FILE);
});

app.get("/api/auth-config", (req, res) => {
  preventCache(res);
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    appOrigin: process.env.APP_ORIGIN
  });
});

app.get("/api/admin/bootstrap", requirePlatformAdmin, async (req, res) => {
  preventCache(res);

  const { data: companies, error } = await supabase
    .from("companies")
    .select("id, business_name, notification_email, twilio_number, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Admin bootstrap company query failed:", error.message);
    return res.status(500).json({ error: "Could not load admin data" });
  }

  res.json({
    admin: {
      authUserId: req.authUserId,
      role: req.platformAdminRole
    },
    companies
  });
});

app.post("/api/admin/onboard-company", requirePlatformAdmin, async (req, res) => {
  const validationCode = validateOnboardingBody(req.body);

  if (validationCode) {
    return safeOnboardingError(res, 400, "Invalid onboarding details", validationCode);
  }

  const {
    businessName,
    ownerEmail,
    notificationEmail,
    twilioNumber,
    aiPrompt
  } = normalizeOnboardingBody(req.body);

  const appOrigin = validateHttpsOrigin(process.env.APP_ORIGIN);

  if (!appOrigin) {
    console.error("Onboarding failed at app origin validation.");
    return safeOnboardingError(res, 500, "Could not complete customer onboarding", "ONBOARDING_FAILED", {
      recoveryRequired: true
    });
  }

  const { data: existingCompanies, error: twilioLookupError } = await supabase
    .from("companies")
    .select("id")
    .eq("twilio_number", twilioNumber)
    .limit(1);

  if (twilioLookupError) {
    console.error("Onboarding failed at Twilio number lookup:", twilioLookupError.message);
    return safeOnboardingError(res, 500, "Could not complete customer onboarding", "ONBOARDING_FAILED", {
      recoveryRequired: true
    });
  }

  if (existingCompanies?.[0]) {
    return safeOnboardingError(res, 409, "Twilio number is already assigned", "TWILIO_NUMBER_IN_USE");
  }

  let authUser;
  let createdAuthUser = false;

  try {
    authUser = await findAuthUserByEmail(ownerEmail);
  } catch (error) {
    console.error("Onboarding failed at Auth user lookup:", error.message);
    return safeOnboardingError(res, 500, "Could not complete customer onboarding", "ONBOARDING_FAILED", {
      recoveryRequired: true
    });
  }

  if (authUser) {
    const { data: companyUsers, error: companyUserError } = await supabase
      .from("company_users")
      .select("company_id")
      .eq("auth_user_id", authUser.id)
      .limit(1);

    if (companyUserError) {
      console.error("Onboarding failed at company user lookup:", companyUserError.message);
      return safeOnboardingError(res, 500, "Could not complete customer onboarding", "ONBOARDING_FAILED", {
        recoveryRequired: true
      });
    }

    if (companyUsers?.[0]) {
      return safeOnboardingError(res, 409, "Customer email is already assigned", "OWNER_EMAIL_ALREADY_ASSIGNED");
    }

    const { data: platformAdmins, error: platformAdminError } = await supabase
      .from("platform_admins")
      .select("auth_user_id")
      .eq("auth_user_id", authUser.id)
      .eq("active", true)
      .in("role", ["platform_owner", "platform_admin"])
      .limit(1);

    if (platformAdminError) {
      console.error("Onboarding failed at platform admin reservation check:", platformAdminError.message);
      return safeOnboardingError(res, 500, "Could not complete customer onboarding", "ONBOARDING_FAILED", {
        recoveryRequired: true
      });
    }

    if (platformAdmins?.[0]) {
      return safeOnboardingError(res, 409, "This email cannot be used for a customer account", "OWNER_EMAIL_RESERVED");
    }
  } else {
    const { data: createdUserData, error: createUserError } = await supabase.auth.admin.createUser({
      email: ownerEmail,
      email_confirm: true
    });

    if (createUserError || !createdUserData?.user?.id) {
      console.error("Onboarding failed at Auth user creation:", createUserError?.message || "No user returned");
      return safeOnboardingError(res, 500, "Could not complete customer onboarding", "ONBOARDING_FAILED", {
        recoveryRequired: true
      });
    }

    authUser = createdUserData.user;
    createdAuthUser = true;
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc("onboard_company_record", {
    p_auth_user_id: authUser.id,
    p_business_name: businessName,
    p_notification_email: notificationEmail,
    p_twilio_number: twilioNumber,
    p_ai_prompt: aiPrompt
  });

  if (rpcError) {
    console.error("Onboarding failed at company RPC:", rpcError.message);

    if (isConflictError(rpcError)) {
      return safeOnboardingError(res, 409, "Customer conflicts with an existing account", "ONBOARDING_CONFLICT");
    }

    return safeOnboardingError(res, 500, "Could not complete customer onboarding", "ONBOARDING_FAILED", {
      recoveryRequired: true
    });
  }

  let company = firstCompanyRecord(rpcData);

  if (!company?.id || !company.business_name || !company.notification_email || !company.twilio_number) {
    const { data: companyLookupData, error: companyLookupError } = await supabase
      .from("companies")
      .select("id, business_name, notification_email, twilio_number")
      .eq("twilio_number", twilioNumber)
      .maybeSingle();

    if (companyLookupError || !companyLookupData?.id) {
      console.error("Onboarding failed at created company lookup:", companyLookupError?.message || "No company returned");
      return safeOnboardingError(res, 500, "Could not complete customer onboarding", "ONBOARDING_FAILED", {
        recoveryRequired: true
      });
    }

    company = companyLookupData;
  }

  const { error: passwordEmailError } = await supabase.auth.resetPasswordForEmail(ownerEmail, {
    redirectTo: `${appOrigin}/dashboard.html?mode=reset`
  });

  if (passwordEmailError) {
    console.error("Onboarding password setup email failed:", passwordEmailError.message);
    return res.status(201).json({
      company: companyResponseFromRecord(company),
      ownerEmail,
      passwordSetupEmailSent: false,
      warning: "Customer was created, but the password setup email was not sent."
    });
  }

  res.status(201).json({
    company: companyResponseFromRecord(company),
    ownerEmail,
    passwordSetupEmailSent: true
  });
});

/**
 * Twilio Voice webhook:
 * POST https://your-domain.com/voice/start
 */
app.post("/voice/start", requireValidTwilioSignature, async (req, res) => {
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

  gatherClassification(
    response,
    businessName,
    `/voice/classify?callSid=${encodeURIComponent(callSid)}&callerPhone=${encodeURIComponent(callerPhone)}&businessName=${encodeURIComponent(businessName)}&attempt=1`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/classify", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const callSid = req.query.callSid || "";
  const callerPhone = req.query.callerPhone || "";
  const businessName = req.query.businessName || "the business";
  const attempt = Number(req.query.attempt || "1");
  const callType = classifyCallType(req.body.Digits, req.body.SpeechResult);

  if (callType === "New Lead") {
    response.redirect(`/voice/name?callSid=${encodeURIComponent(callSid)}&callerPhone=${encodeURIComponent(callerPhone)}`);
  } else if (callType === "Existing Customer") {
    response.redirect(`/voice/existing/name?callSid=${encodeURIComponent(callSid)}&callerPhone=${encodeURIComponent(callerPhone)}`);
  } else if (callType === "General Message" || attempt >= 2) {
    response.redirect(`/voice/general/name?callSid=${encodeURIComponent(callSid)}&callerPhone=${encodeURIComponent(callerPhone)}`);
  } else {
    gatherClassification(
      response,
      businessName,
      `/voice/classify?callSid=${encodeURIComponent(callSid)}&callerPhone=${encodeURIComponent(callerPhone)}&businessName=${encodeURIComponent(businessName)}&attempt=2`
    );
  }

  res.type("text/xml").send(response.toString());
});

app.post("/voice/existing/name", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  sayAndGather(
    response,
    "Please say your name.",
    `/voice/existing/address?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/existing/address", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const name = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "What is the job or service address?",
    `/voice/existing/reason?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(name)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/existing/reason", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const location = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "What is the reason for your call?",
    `/voice/existing/urgency?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&location=${encodeURIComponent(location)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/existing/urgency", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const notes = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "Does this need urgent attention, or is normal business-hours follow-up okay? If anyone is in immediate danger, please hang up and call 911 or the appropriate emergency service.",
    `/voice/existing/callback-time?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&location=${encodeURIComponent(req.query.location || "")}&notes=${encodeURIComponent(notes)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/existing/callback-time", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const urgency = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "What is the best callback time?",
    `/voice/existing/finish?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&location=${encodeURIComponent(req.query.location || "")}&notes=${encodeURIComponent(req.query.notes || "")}&urgency=${encodeURIComponent(urgency)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/existing/finish", requireValidTwilioSignature, async (req, res) => {
  const response = new VoiceResponse();
  const to = req.body.To || "";
  const preferredTime = req.body.SpeechResult || "Not captured";

  if (!to) {
    console.error("Voice existing customer callback not created: missing inbound Twilio destination number.");
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your message right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  let company;

  try {
    company = await findCompanyByTwilioNumber(to, "id");
  } catch (error) {
    console.error("Voice existing customer callback not created: company lookup failed for inbound Twilio number.", error.message);
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your message right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  if (!company) {
    console.error("Voice existing customer callback not created: no company found for inbound Twilio destination number.");
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your message right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  const urgency = req.query.urgency || "Not captured";
  const lead = {
    id: uuidv4(),
    source: "Phone Call",
    callType: "Existing Customer",
    status: "Callback Needed",
    callSid: req.query.callSid || "",
    callerPhone: req.query.callerPhone || "",
    phone: req.query.callerPhone || "",
    name: req.query.name || "Not captured",
    jobType: "Existing job or appointment",
    location: req.query.location || "Not captured",
    urgency,
    priority: urgency,
    preferredTime,
    notes: req.query.notes || "Not captured",
    score: null,
    qualification: null,
    recommendedAction: "Contact the existing customer and review the related job or appointment.",
    createdAt: new Date().toISOString(),
    companyId: company.id
  };

  try {
    await saveLead(lead);
  } catch (error) {
    console.error("Voice existing customer callback not created: Supabase save failed.", error.message);
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your message right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  try {
    await sendOwnerEmail(lead);
  } catch (error) {
    console.error("Owner email notification failed:", error.message);
  }

  response.say(
    { voice: "Polly.Matthew" },
    "Thank you. I've sent your message to the team. I don't have access to their schedule, billing records, or individual job details, so someone from the business will need to follow up with you."
  );
  response.hangup();
  res.type("text/xml").send(response.toString());
});

app.post("/voice/general/name", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  sayAndGather(
    response,
    "Please say your first and last name.",
    `/voice/general/organization?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/general/organization", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const name = generalMessageCallerName(req.body.SpeechResult);
  sayAndGather(
    response,
    "Please say the business or organization name, or say none.",
    `/voice/general/message?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(name)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/general/message", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const organization = req.body.SpeechResult || "General Message";
  sayAndGatherLongSpeech(
    response,
    "What message would you like to leave?",
    `/voice/general/callback-requested?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&organization=${encodeURIComponent(organization)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/general/callback-requested", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const message = req.body.SpeechResult || "Not captured";
  const actionUrl = `/voice/general/callback-answer?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&organization=${encodeURIComponent(req.query.organization || "")}&message=${encodeURIComponent(message)}&callbackAttempt=1`;

  sayAndGather(response, "Would you like a callback? Please say yes or no.", actionUrl);
  res.type("text/xml").send(response.toString());
});

app.post("/voice/general/callback-answer", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const callbackRequested = wantsCallback(req.body.Digits, req.body.SpeechResult);
  const callbackAttempt = Number(req.query.callbackAttempt || "1");

  if (callbackRequested === false || (callbackRequested === null && callbackAttempt >= 2)) {
    response.redirect(`/voice/general/finish?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&organization=${encodeURIComponent(req.query.organization || "")}&message=${encodeURIComponent(req.query.message || "")}&callbackRequested=no&preferredTime=${encodeURIComponent("Not requested")}`);
    return res.type("text/xml").send(response.toString());
  }

  if (callbackRequested === null) {
    sayAndGather(
      response,
      "Would you like a callback? Please say yes or no.",
      `/voice/general/callback-answer?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&organization=${encodeURIComponent(req.query.organization || "")}&message=${encodeURIComponent(req.query.message || "")}&callbackAttempt=2`
    );
    return res.type("text/xml").send(response.toString());
  }

  sayAndGather(
    response,
    "What is the best callback time?",
    `/voice/general/finish?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&organization=${encodeURIComponent(req.query.organization || "")}&message=${encodeURIComponent(req.query.message || "")}&callbackRequested=yes`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/general/finish", requireValidTwilioSignature, async (req, res) => {
  const response = new VoiceResponse();
  const to = req.body.To || "";
  const callbackRequested = req.query.callbackRequested === "yes";
  const preferredTime = callbackRequested ? req.body.SpeechResult || "Not captured" : req.query.preferredTime || "Not requested";

  if (!to) {
    console.error("Voice general message not created: missing inbound Twilio destination number.");
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your message right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  let company;

  try {
    company = await findCompanyByTwilioNumber(to, "id");
  } catch (error) {
    console.error("Voice general message not created: company lookup failed for inbound Twilio number.", error.message);
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your message right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  if (!company) {
    console.error("Voice general message not created: no company found for inbound Twilio destination number.");
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your message right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  const organization = organizationOrGeneralMessage(req.query.organization);
  const lead = {
    id: uuidv4(),
    source: "Phone Call",
    callType: "General Message",
    status: "New",
    callSid: req.query.callSid || "",
    callerPhone: req.query.callerPhone || "",
    phone: req.query.callerPhone || "",
    name: req.query.name || "Not captured",
    jobType: organization || "General Message",
    location: "Not captured",
    urgency: "Normal",
    priority: "Normal",
    preferredTime,
    notes: req.query.message || "Not captured",
    score: null,
    qualification: null,
    recommendedAction: callbackRequested ? "Call back if requested and review the message." : "Review the message.",
    createdAt: new Date().toISOString(),
    companyId: company.id
  };

  try {
    await saveLead(lead);
  } catch (error) {
    console.error("Voice general message not created: Supabase save failed.", error.message);
    response.say({ voice: "Polly.Matthew" }, "Sorry, we could not save your message right now. Please call again later.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  try {
    await sendOwnerEmail(lead);
  } catch (error) {
    console.error("Owner email notification failed:", error.message);
  }

  response.say(
    { voice: "Polly.Matthew" },
    "Thanks. I saved your message for the team to review."
  );
  response.hangup();
  res.type("text/xml").send(response.toString());
});

app.post("/voice/name", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  sayAndGather(
    response,
    "what's your name?",
    `/voice/job-type?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/job-type", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const name = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "what job do you need done",
    `/voice/location?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(name)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/location", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const jobType = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "Where are you located?",
    `/voice/urgency?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(jobType)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/urgency", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const location = req.body.SpeechResult || "Not captured";
  sayAndGather(
    response,
    "is this an Emergency?",
    `/voice/preferred-time?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(location)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/preferred-time", requireValidTwilioSignature, (req, res) => {
  const response = new VoiceResponse();
  const urgency = req.body.SpeechResult || req.query.urgency || "Not captured";
  sayAndGather(
    response,
    "When are you free for a call back?",
    `/voice/notes?callSid=${encodeURIComponent(req.query.callSid || "")}&callerPhone=${encodeURIComponent(req.query.callerPhone || "")}&name=${encodeURIComponent(req.query.name || "")}&jobType=${encodeURIComponent(req.query.jobType || "")}&location=${encodeURIComponent(req.query.location || "")}&urgency=${encodeURIComponent(urgency)}`
  );
  res.type("text/xml").send(response.toString());
});

app.post("/voice/notes", requireValidTwilioSignature, (req, res) => {
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

app.post("/voice/finish", requireValidTwilioSignature, async (req, res) => {
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
    callType: "New Lead",
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
app.post("/sms", requireValidTwilioSignature, async (req, res) => {
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
  preventCache(res);
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
    callType: lead.call_type || "New Lead",
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
  preventCache(res);
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
