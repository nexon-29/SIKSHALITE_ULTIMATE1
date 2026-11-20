import express, { type Express, type Request } from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

dotenv.config();

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 20 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_COOKIE_NAME = 'sikshalite_otp_challenge';

interface OtpEntry {
  hash: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

const otpStore = new Map<string, OtpEntry>();

function getOtpSigningSecret(): string {
  if (process.env.OTP_SECRET?.trim()) {
    return process.env.OTP_SECRET.trim();
  }
  const seed = [
    process.env.TWILIO_AUTH_TOKEN,
    process.env.FAST2SMS_API_KEY,
    process.env.MSG91_AUTH_KEY,
    process.env.GEMINI_API_KEY,
    process.env.VERCEL_PROJECT_ID,
  ]
    .filter(Boolean)
    .join(':');
  if (seed) {
    return crypto.createHash('sha256').update(`sikshalite-otp:${seed}`).digest('hex');
  }
  return fallbackEphemeralSecret;
}

const fallbackEphemeralSecret = crypto.randomBytes(32).toString('hex');

function hashOtp(phoneE164: string, code: string): string {
  return crypto
    .createHmac('sha256', getOtpSigningSecret())
    .update(`${phoneE164}:${code}`)
    .digest('hex');
}

function createSignedChallengeToken(phoneE164: string, codeHash: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ p: phoneE164, h: codeHash, e: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', getOtpSigningSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseSignedChallengeToken(
  token: string | undefined
): { phoneE164: string; hash: string; expiresAt: number } | null {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.', 2);
  if (!payload || !sig) return null;
  const expectedSig = crypto
    .createHmac('sha256', getOtpSigningSecret())
    .update(payload)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      p?: string;
      h?: string;
      e?: number;
    };
    if (!parsed.p || !parsed.h || typeof parsed.e !== 'number') return null;
    return { phoneE164: parsed.p, hash: parsed.h, expiresAt: parsed.e };
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

type SmsProvider = 'twilio_verify' | 'twilio' | 'fast2sms' | 'msg91';

function getTwilioVerifyServiceSid(): string | null {
  const explicit = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
  if (explicit) return explicit;
  const phoneOrSid = process.env.TWILIO_PHONE_NUMBER?.trim() || '';
  if (/^VA[a-zA-Z0-9]+$/.test(phoneOrSid)) {
    return phoneOrSid;
  }
  return null;
}

function getConfiguredSmsProvider(): SmsProvider | null {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    if (getTwilioVerifyServiceSid()) {
      return 'twilio_verify';
    }
    if (process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID) {
      return 'twilio';
    }
  }
  if (process.env.FAST2SMS_API_KEY) {
    return 'fast2sms';
  }
  if (process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID) {
    return 'msg91';
  }
  return null;
}

function formatTwilioApiError(status: number, errText: string): string {
  try {
    const parsed = JSON.parse(errText) as { code?: number; message?: string };
    const codeHint = parsed.code ? ` [Twilio ${parsed.code}]` : '';
    if (parsed.code === 21608) {
      return `Twilio Trial restriction${codeHint}: Recipient number is not in Twilio Verified Caller IDs. Verify it as a Caller ID (Voice call), upgrade Twilio, or switch to Firebase Phone OTP.`;
    }
    if (parsed.code === 21408) {
      return `Twilio SMS Geo-Permissions${codeHint}: Enable SMS Geo-Permissions for the destination country in Twilio Console -> Messaging -> Settings -> Geo Permissions.`;
    }
    if (parsed.code === 21215) {
      return `Twilio Voice Geo-Permissions${codeHint}: Twilio could not place the Caller ID verification call because Voice Geo-Permissions are disabled for this country. Enable your country in Twilio Console -> Voice -> Settings -> Geo Permissions.`;
    }
    if (parsed.code === 21450 || parsed.code === 21452) {
      return `Twilio Caller ID verification${codeHint}: ${parsed.message || 'Unable to verify this phone number right now. Check Voice Geo-Permissions and retry.'}`;
    }
    return `Twilio error (${status})${codeHint}: ${parsed.message || errText}`;
  } catch {
    return `Twilio SMS failed (${status}): ${errText}`;
  }
}

async function dispatchSmsGateway(phoneE164: string, code: string): Promise<SmsProvider> {
  const provider = getConfiguredSmsProvider();

  if (provider === 'twilio_verify') {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID!.trim();
    const twilioToken = process.env.TWILIO_AUTH_TOKEN!.trim();
    const verifySid = getTwilioVerifyServiceSid()!;
    const authHeader = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
    const body = new URLSearchParams({
      To: phoneE164,
      Channel: 'sms',
    });
    const resp = await fetch(
      `https://verify.twilio.com/v2/Services/${encodeURIComponent(verifySid)}/Verifications`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(formatTwilioApiError(resp.status, errText));
    }
    return 'twilio_verify';
  }

  if (provider === 'twilio') {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID!.trim();
    const twilioToken = process.env.TWILIO_AUTH_TOKEN!.trim();
    const messagingSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER?.trim() || '';
    const authHeader = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
    const params: Record<string, string> = {
      To: phoneE164,
      Body: `${code} is your Sikshalite login verification OTP. Valid for 5 minutes.`,
    };
    if (messagingSid) {
      params.MessagingServiceSid = messagingSid;
    } else if (/^MG[a-zA-Z0-9]+$/.test(twilioFrom)) {
      params.MessagingServiceSid = twilioFrom;
    } else {
      params.From = twilioFrom;
    }
    const body = new URLSearchParams(params);
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(formatTwilioApiError(resp.status, errText));
    }
    return 'twilio';
  }

  if (provider === 'fast2sms') {
    const fast2smsKey = process.env.FAST2SMS_API_KEY!;
    const localDigits = phoneE164.startsWith('+91')
      ? phoneE164.slice(3)
      : phoneE164.replace(/\D/g, '');
    const resp = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        authorization: fast2smsKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        route: 'q',
        message: `Your Sikshalite verification OTP is ${code}. Valid for 5 minutes. Do not share this code.`,
        language: 'english',
        flash: 0,
        numbers: localDigits,
      }),
    });
    const rawText = await resp.text();
    let data: { return?: boolean; message?: string | string[] } = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error(`Fast2SMS returned an unexpected response (${resp.status}).`);
    }
    if (!resp.ok || data.return === false) {
      const msg = Array.isArray(data.message)
        ? data.message.join(', ')
        : data.message || `Fast2SMS failed (${resp.status})`;
      throw new Error(msg);
    }
    return 'fast2sms';
  }

  if (provider === 'msg91') {
    const msg91Key = process.env.MSG91_AUTH_KEY!;
    const templateId = process.env.MSG91_TEMPLATE_ID!;
    const mobile = phoneE164.replace(/\D/g, '');
    const resp = await fetch(
      `https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(templateId)}&mobile=${encodeURIComponent(mobile)}&otp=${encodeURIComponent(code)}`,
      {
        method: 'POST',
        headers: {
          authkey: msg91Key,
          'Content-Type': 'application/json',
        },
      }
    );
    const rawText = await resp.text();
    let data: { type?: string; message?: string } = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error(`MSG91 returned an unexpected response (${resp.status}).`);
    }
    if (!resp.ok || data.type === 'error') {
      throw new Error(data.message || `MSG91 SMS failed (${resp.status})`);
    }
    return 'msg91';
  }

  throw new Error('SMS_NOT_CONFIGURED');
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function formatGeminiError(error: unknown): { status: number; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('API_KEY_INVALID') || raw.includes('400')) {
    return { status: 400, message: `Gemini request failed: ${raw}` };
  }
  if (raw.includes('PERMISSION_DENIED') || raw.includes('403')) {
    return { status: 403, message: 'Gemini API permission denied. Please verify your API key in Settings > Secrets.' };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return { status: 429, message: 'Gemini rate limit or quota reached. Please retry shortly.' };
  }
  return { status: 500, message: raw || 'Unexpected error communicating with Gemini.' };
}

export function createApiApp(): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'sikshalite-api',
      otpProvider: getConfiguredSmsProvider() ?? 'firebase_only',
      hasTwilioAccount: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    });
  });

  app.post('/api/twilio/caller-id', async (req, res) => {
    try {
      const phoneE164 = String(req.body?.phoneE164 ?? '').trim();
      if (!isValidE164(phoneE164)) {
        res.status(400).json({
          error: 'Enter a valid mobile number with country code (e.g. +919876543210).',
        });
        return;
      }

      const twilioSid = process.env.TWILIO_ACCOUNT_SID?.trim();
      const twilioToken = process.env.TWILIO_AUTH_TOKEN?.trim();
      if (!twilioSid || !twilioToken) {
        res.status(422).json({
          code: 'TWILIO_NOT_CONFIGURED',
          error: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set in environment variables.',
        });
        return;
      }

      const authHeader = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');

      const checkResp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid)}/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(phoneE164)}`,
        {
          headers: { Authorization: `Basic ${authHeader}` },
        }
      );

      if (checkResp.ok) {
        const checkData = (await checkResp.json()) as {
          outgoing_caller_ids?: Array<{ phone_number?: string }>;
        };
        if (Array.isArray(checkData.outgoing_caller_ids) && checkData.outgoing_caller_ids.length > 0) {
          res.json({ alreadyVerified: true, phoneE164 });
          return;
        }
      }

      const body = new URLSearchParams({
        PhoneNumber: phoneE164,
        FriendlyName: 'Sikshalite Verified Number',
      });
      const reqResp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid)}/OutgoingCallerIds.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${authHeader}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        }
      );

      const rawText = await reqResp.text();
      if (!reqResp.ok) {
        res.status(400).json({ error: formatTwilioApiError(reqResp.status, rawText) });
        return;
      }

      let parsed: { validation_code?: string; phone_number?: string } = {};
      try {
        parsed = rawText ? JSON.parse(rawText) : {};
      } catch {
        parsed = {};
      }

      res.json({
        callInitiated: true,
        phoneE164: parsed.phone_number || phoneE164,
        validationCode: parsed.validation_code || '',
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unable to initiate Twilio Caller ID verification.',
      });
    }
  });

  app.post('/api/otp/send', async (req, res) => {
    try {
      const phoneE164 = String(req.body?.phoneE164 ?? '').trim();
      if (!isValidE164(phoneE164)) {
        res.status(400).json({
          error: 'Please enter a valid mobile number with country code (e.g. +919876543210).',
        });
        return;
      }

      if (!getConfiguredSmsProvider()) {
        res.status(422).json({
          code: 'SMS_NOT_CONFIGURED',
          error:
            'Live SMS delivery requires enabling Phone Sign-In in Firebase Console or adding a carrier SMS gateway key (FAST2SMS_API_KEY, MSG91_AUTH_KEY, or TWILIO_*) in environment variables.',
        });
        return;
      }

      const now = Date.now();
      const existing = otpStore.get(phoneE164);
      if (existing && now - existing.lastSentAt < OTP_COOLDOWN_MS) {
        const waitSec = Math.ceil((OTP_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
        res.status(429).json({
          error: `Please wait ${waitSec}s before requesting another OTP.`,
        });
        return;
      }

      const code = String(crypto.randomInt(100000, 1000000));
      const mode = await dispatchSmsGateway(phoneE164, code);
      const expiresAt = now + OTP_TTL_MS;
      const codeHash = hashOtp(phoneE164, code);

      otpStore.set(phoneE164, {
        hash: codeHash,
        expiresAt,
        attempts: 0,
        lastSentAt: now,
      });

      if (mode !== 'twilio_verify') {
        const signedToken = createSignedChallengeToken(phoneE164, codeHash, expiresAt);
        const secureFlag = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.setHeader(
          'Set-Cookie',
          `${OTP_COOKIE_NAME}=${encodeURIComponent(signedToken)}; Path=/api/otp; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(OTP_TTL_MS / 1000)}${secureFlag}`
        );
      }

      res.json({
        sent: true,
        mode,
        phoneE164,
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to send SMS OTP.',
      });
    }
  });

  app.post('/api/otp/verify', async (req, res) => {
    try {
      const phoneE164 = String(req.body?.phoneE164 ?? '').trim();
      const code = String(req.body?.code ?? '').trim();

      if (!isValidE164(phoneE164) || !/^\d{4,8}$/.test(code)) {
        res.status(400).json({ error: 'Enter a valid mobile number and OTP code.' });
        return;
      }

      if (getConfiguredSmsProvider() === 'twilio_verify') {
        const twilioSid = process.env.TWILIO_ACCOUNT_SID!.trim();
        const twilioToken = process.env.TWILIO_AUTH_TOKEN!.trim();
        const verifySid = getTwilioVerifyServiceSid()!;
        const authHeader = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
        const body = new URLSearchParams({
          To: phoneE164,
          Code: code,
        });
        const resp = await fetch(
          `https://verify.twilio.com/v2/Services/${encodeURIComponent(verifySid)}/VerificationCheck`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${authHeader}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
          }
        );
        const rawText = await resp.text();
        if (!resp.ok) {
          res.status(400).json({ error: formatTwilioApiError(resp.status, rawText) });
          return;
        }
        let data: { status?: string } = {};
        try {
          data = rawText ? JSON.parse(rawText) : {};
        } catch {
          res.status(502).json({ error: 'Unexpected response from Twilio Verify.' });
          return;
        }
        if (data.status !== 'approved') {
          res.status(400).json({ error: 'Incorrect or expired OTP code. Please check your SMS and try again.' });
          return;
        }
        otpStore.delete(phoneE164);
        res.json({ verified: true, phoneE164 });
        return;
      }

      const entry = otpStore.get(phoneE164);
      const cookieChallenge = parseSignedChallengeToken(readCookie(req, OTP_COOKIE_NAME));
      const activeHash =
        entry?.hash || (cookieChallenge?.phoneE164 === phoneE164 ? cookieChallenge.hash : null);
      const activeExpiry =
        entry?.expiresAt ?? (cookieChallenge?.phoneE164 === phoneE164 ? cookieChallenge.expiresAt : null);

      if (!activeHash || activeExpiry === null) {
        res.status(400).json({ error: 'No active OTP found for this number. Request a new OTP.' });
        return;
      }

      if (Date.now() > activeExpiry) {
        otpStore.delete(phoneE164);
        res.status(400).json({ error: 'This OTP has expired. Please request a fresh OTP.' });
        return;
      }

      if (entry && entry.attempts >= OTP_MAX_ATTEMPTS) {
        otpStore.delete(phoneE164);
        res.status(429).json({ error: 'Too many incorrect OTP attempts. Request a new OTP.' });
        return;
      }

      const expectedBuf = Buffer.from(activeHash, 'hex');
      const actualBuf = Buffer.from(hashOtp(phoneE164, code), 'hex');
      const matched =
        expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

      if (!matched) {
        if (entry) {
          entry.attempts += 1;
          otpStore.set(phoneE164, entry);
          const remaining = Math.max(0, OTP_MAX_ATTEMPTS - entry.attempts);
          res.status(400).json({
            error: `Incorrect OTP code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
          });
          return;
        }
        res.status(400).json({ error: 'Incorrect OTP code. Please check your SMS and try again.' });
        return;
      }

      otpStore.delete(phoneE164);
      res.setHeader('Set-Cookie', `${OTP_COOKIE_NAME}=; Path=/api/otp; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.json({ verified: true, phoneE164 });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'OTP verification failed.',
      });
    }
  });

  app.post('/api/gemini/generate-quiz', async (req, res) => {
    try {
      const {
        subjectName = '',
        topicTitle = '',
        topicDescription = '',
        quizType = 'pre',
        questionCount = 5,
        referenceContext = '',
      } = req.body ?? {};

      if (!String(subjectName).trim() || !String(topicTitle).trim()) {
        res.status(400).json({ error: 'Subject name and topic title are required.' });
        return;
      }

      const safeCount = Math.min(10, Math.max(3, Number(questionCount) || 5));
      const isPost = quizType === 'post';
      const ai = getGeminiClient();

      const prompt = [
        `Create ${safeCount} multiple-choice questions for a ${isPost ? 'Post-Test (summative mastery & application)' : 'Pre-Test (diagnostic baseline & foundational concepts)'}.`,
        `Subject: ${String(subjectName).trim()}`,
        `Topic: ${String(topicTitle).trim()}`,
        topicDescription ? `Topic Scope: ${String(topicDescription).trim()}` : '',
        referenceContext ? `Study Context: ${String(referenceContext).slice(0, 2000)}` : '',
        'Each question must have exactly 4 distinct options, a valid zero-based correctIndex (0-3), and a concise 1-2 sentence explanation.',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'You are an expert academic assessment designer for Sikshalite. Produce rigorous, unambiguous multiple-choice questions tailored to the exact subject and topic.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              questions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    question: { type: Type.STRING, description: 'Clear question stem.' },
                    options: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                      description: 'Exactly 4 answer choices.',
                    },
                    correctIndex: {
                      type: Type.INTEGER,
                      description: 'Zero-based index (0, 1, 2, or 3) of the right option.',
                    },
                    explanation: {
                      type: Type.STRING,
                      description: 'Brief explanation of why the correct answer is right.',
                    },
                  },
                  required: ['question', 'options', 'correctIndex', 'explanation'],
                },
              },
            },
            required: ['questions'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{"questions":[]}').trim());
      const questions = Array.isArray(parsed.questions)
        ? parsed.questions.slice(0, 15).map((q: Record<string, unknown>, idx: number) => {
            const opts = Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : [];
            while (opts.length < 4) opts.push(`Option ${opts.length + 1}`);
            const ci = Number(q.correctIndex);
            return {
              id: `${quizType}_q_${Date.now()}_${idx}`,
              question: String(q.question ?? '').slice(0, 500),
              options: opts.map((o) => o.slice(0, 220)),
              correctIndex: Number.isInteger(ci) && ci >= 0 && ci <= 3 ? ci : 0,
              explanation: String(q.explanation ?? '').slice(0, 400),
            };
          })
        : [];

      res.json({ questions });
    } catch (error) {
      const formatted = formatGeminiError(error);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/gemini/generate-material', async (req, res) => {
    try {
      const { subjectName = '', topicTitle = '', topicDescription = '', gradeLevel = '' } = req.body ?? {};
      if (!String(subjectName).trim() || !String(topicTitle).trim()) {
        res.status(400).json({ error: 'Subject name and topic title are required.' });
        return;
      }

      const ai = getGeminiClient();
      const prompt = [
        'Generate structured, student-friendly study material for:',
        `Subject: ${String(subjectName).trim()}`,
        `Topic: ${String(topicTitle).trim()}`,
        topicDescription ? `Focus Notes: ${String(topicDescription).trim()}` : '',
        gradeLevel ? `Learner Level: ${String(gradeLevel).trim()}` : '',
        'Include an overview summary, 3 to 4 structured learning sections with clear examples/formulas, and 4 concise key takeaways.',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'You are a master educator creating clear, well-paced study guides for Sikshalite students. Avoid fluff and write precise, memorable explanations.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              sections: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    heading: { type: Type.STRING },
                    body: { type: Type.STRING },
                  },
                  required: ['heading', 'body'],
                },
              },
              keyTakeaways: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['summary', 'sections', 'keyTakeaways'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
      const takeaways = Array.isArray(parsed.keyTakeaways) ? parsed.keyTakeaways : [];
      const formattedMarkdown = [
        parsed.summary ? `Overview\n${String(parsed.summary).trim()}\n` : '',
        ...sections.map(
          (sec: { heading?: string; body?: string }) =>
            `## ${String(sec.heading ?? '').trim()}\n${String(sec.body ?? '').trim()}\n`
        ),
        takeaways.length > 0
          ? `## Key Takeaways\n${takeaways.map((t: unknown) => `• ${String(t).trim()}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 28000);

      res.json({
        studyContent: formattedMarkdown,
        summary: String(parsed.summary ?? ''),
        sections,
        keyTakeaways: takeaways,
      });
    } catch (error) {
      const formatted = formatGeminiError(error);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/gemini/generate-assignment', async (req, res) => {
    try {
      const {
        subjectName = '',
        topicTitle = '',
        topicDescription = '',
        assignmentMode = 'both',
      } = req.body ?? {};

      if (!String(subjectName).trim() || !String(topicTitle).trim()) {
        res.status(400).json({ error: 'Subject name and topic title are required.' });
        return;
      }

      const ai = getGeminiClient();
      const modeHint =
        assignmentMode === 'file'
          ? 'Students will upload a handwritten photo, worksheet scan, or PDF/document file.'
          : assignmentMode === 'written'
            ? 'Students will write their structured response directly inside the app.'
            : 'Students may submit either a written response or an uploaded file/photo.';

      const prompt = [
        'Design a practical, high-impact student assignment for:',
        `Subject: ${String(subjectName).trim()}`,
        `Topic: ${String(topicTitle).trim()}`,
        topicDescription ? `Context: ${String(topicDescription).trim()}` : '',
        modeHint,
        'Provide clear step-by-step instructions, deliverables, and evaluation criteria.',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'You are an experienced curriculum designer creating actionable student assignments for Sikshalite.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              instructions: { type: Type.STRING },
              checklist: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['title', 'instructions', 'checklist'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      const checklist = Array.isArray(parsed.checklist) ? parsed.checklist : [];
      const assignmentPrompt = [
        parsed.title ? `${String(parsed.title).trim()}\n` : '',
        parsed.instructions ? `${String(parsed.instructions).trim()}\n` : '',
        checklist.length > 0
          ? `Submission Checklist:\n${checklist.map((item: unknown, i: number) => `${i + 1}. ${String(item).trim()}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 3800);

      res.json({ assignmentPrompt });
    } catch (error) {
      const formatted = formatGeminiError(error);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/gemini/generate-diagram', async (req, res) => {
    try {
      const {
        subjectName = '',
        topicTitle = '',
        topicDescription = '',
        studyContext = '',
        visualPrompt = '',
      } = req.body ?? {};

      if (!String(subjectName).trim() || !String(topicTitle).trim()) {
        res.status(400).json({ error: 'Subject name and topic title are required.' });
        return;
      }

      const ai = getGeminiClient();
      const prompt = [
        'Create a clear, publication-grade educational visual diagram / illustrated concept chart as standalone SVG.',
        `Subject: ${String(subjectName).trim()}`,
        `Topic: ${String(topicTitle).trim()}`,
        topicDescription ? `Topic Scope: ${String(topicDescription).trim()}` : '',
        visualPrompt ? `Teacher Visual Request: ${String(visualPrompt).trim()}` : '',
        studyContext ? `Study Context: ${String(studyContext).slice(0, 1400)}` : '',
        'SVG design rules:',
        '- Root tag MUST be <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 540" width="880" height="540">.',
        '- Include a light Academic Ivory canvas background (<rect width="880" height="540" fill="#FAF9F6" rx="16"/>).',
        '- Use Deep Indigo (#312E81), Emerald (#059669), Slate (#0F172A, #475569), and soft pastel fills (#EEF2FF, #ECFDF5, #FFFFFF) with crisp borders (#E2E8F0).',
        '- Draw meaningful subject-specific diagrams: labeled boxes, flow arrows, step numbers, schematic elements, formulas, or metric cards with generous spacing so text never overlaps or clips.',
        '- Use font-family="system-ui, -apple-system, sans-serif" and readable font sizes (13px-22px).',
        '- STRICT SAFETY: No <script>, no <foreignObject>, no event handlers (onload, onclick, etc.), and no external URLs or images.',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'You are an educational illustrator and instructional designer for Sikshalite. Output valid, clean, self-contained SVG diagrams with zero overlapping labels.',
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              caption: {
                type: Type.STRING,
                description: 'Concise 4-9 word caption describing the generated visual.',
              },
              svg: {
                type: Type.STRING,
                description: 'Complete standalone SVG markup starting with <svg and ending with </svg>.',
              },
            },
            required: ['caption', 'svg'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        caption?: unknown;
        svg?: unknown;
      };
      const rawSvg = String(parsed.svg ?? '').trim();
      const svgMatch = rawSvg.match(/<svg[\s\S]*<\/svg>/i);
      if (!svgMatch) {
        res.status(502).json({ error: 'Gemini did not return a valid diagram. Please try again.' });
        return;
      }

      let safeSvg = svgMatch[0]
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
        .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/\s(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*')/gi, '')
        .replace(/\ssrc\s*=\s*("[^"]*"|'[^']*')/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/url\(\s*['"]?\s*https?:\/\/[^)]*\)/gi, 'none');

      if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(safeSvg)) {
        safeSvg = safeSvg
          .replace(/\sxmlns\s*=\s*("[^"]*"|'[^']*')/i, '')
          .replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      }

      const caption =
        String(parsed.caption ?? `${String(topicTitle).trim()} Diagram`)
          .trim()
          .slice(0, 80) || `${String(topicTitle).trim()} Diagram`.slice(0, 80);

      res.json({ caption, svg: safeSvg });
    } catch (error) {
      const formatted = formatGeminiError(error);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  return app;
}
