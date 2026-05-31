# ServicePilot Call-Answering Backend

This is the first real backend version for ServicePilot's phone-answering service.

## What it does

- Answers real phone calls through Twilio Voice webhooks.
- Uses Twilio speech recognition to gather caller details.
- Captures name, phone, job type, location, urgency, preferred time, and notes.
- Scores and qualifies each lead.
- Saves leads into a local JSON file.
- Sends the owner an SMS alert through Twilio.
- Includes a dashboard to call, text, approve, reschedule, or decline leads.
- Handles inbound SMS leads.

## Important

This version uses a structured call flow instead of a fully free-form AI voice agent.

That is intentional for the MVP:
- cheaper
- more predictable
- easier to launch
- less likely to say something wrong

A later version can add OpenAI voice or chat logic.

## Setup

1. Install Node.js.

2. Open terminal in this folder.

3. Install dependencies:

npm install

4. Copy `.env.example` to `.env`.

5. Fill in your Twilio values:

TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
OWNER_PHONE_NUMBER

6. Start the server:

npm start

7. For local testing, install and run ngrok:

ngrok http 3000

8. In Twilio, set your phone number webhooks:

Voice webhook:
POST https://your-ngrok-url.ngrok-free.app/voice/start

Messaging webhook:
POST https://your-ngrok-url.ngrok-free.app/sms

9. Call or text your Twilio number.

10. Open the dashboard:

http://localhost:3000/dashboard.html

## Deploy live

Use Render, Railway, Fly.io, Heroku, DigitalOcean, or another Node host.

## Next build

- Supabase database
- owner login
- per-contractor settings
- Google Calendar integration
- Stripe customer mapping
- OpenAI-powered voice conversation
