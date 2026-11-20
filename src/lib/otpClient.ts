export type OtpGatewayProvider = 'twilio_verify' | 'twilio' | 'fast2sms' | 'msg91' | 'firebase_only';
export type WebOtpChannel = 'auto' | 'server' | 'firebase';

export interface ServerOtpChallenge {
  phoneE164: string;
  mode: Exclude<OtpGatewayProvider, 'firebase_only'>;
}

export class SmsNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsNotConfiguredError';
  }
}

async function parseJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      raw.trim().toLowerCase().startsWith('<!doctype') || raw.trim().startsWith('<html')
        ? 'The server returned a page reload instead of an OTP response. Please refresh the page and retry.'
        : `Unexpected server response (${res.status}).`
    );
  }
}

export async function fetchOtpProviderStatus(): Promise<OtpGatewayProvider> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return 'firebase_only';
    const data = (await res.json()) as { otpProvider?: OtpGatewayProvider };
    return data.otpProvider || 'firebase_only';
  } catch {
    return 'firebase_only';
  }
}

export async function requestServerOtp(phoneE164: string): Promise<ServerOtpChallenge> {
  const res = await fetch('/api/otp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneE164 }),
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    if (res.status === 422 || res.status === 503 || data.code === 'SMS_NOT_CONFIGURED') {
      throw new SmsNotConfiguredError(
        String(data.error || 'Live SMS delivery is not configured yet.')
      );
    }
    throw new Error(String(data.error || 'Unable to send SMS OTP.'));
  }
  return {
    phoneE164: String(data.phoneE164 || phoneE164),
    mode: (data.mode as ServerOtpChallenge['mode']) || 'twilio_verify',
  };
}

export async function verifyServerOtpRequest(phoneE164: string, code: string): Promise<string> {
  const res = await fetch('/api/otp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneE164, code }),
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(String(data.error || 'OTP verification failed.'));
  }
  return String(data.phoneE164 || phoneE164);
}

export function formatOtpProviderLabel(provider: OtpGatewayProvider): string {
  switch (provider) {
    case 'twilio_verify':
      return 'Twilio Verify OTP';
    case 'twilio':
      return 'Twilio SMS OTP';
    case 'fast2sms':
      return 'Fast2SMS OTP';
    case 'msg91':
      return 'MSG91 OTP';
    default:
      return 'Firebase Phone OTP';
  }
}

export function isTwilioCallerIdOrGeoError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('21608') ||
    lower.includes('21215') ||
    lower.includes('21408') ||
    lower.includes('caller id') ||
    lower.includes('trial restriction') ||
    lower.includes('geo-permissions')
  );
}

export interface TwilioCallerIdResult {
  alreadyVerified?: boolean;
  callInitiated?: boolean;
  phoneE164: string;
  validationCode?: string;
}

export async function requestTwilioCallerIdVerification(
  phoneE164: string
): Promise<TwilioCallerIdResult> {
  const res = await fetch('/api/twilio/caller-id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneE164 }),
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(String(data.error || 'Unable to verify Twilio Caller ID.'));
  }
  return {
    alreadyVerified: Boolean(data.alreadyVerified),
    callInitiated: Boolean(data.callInitiated),
    phoneE164: String(data.phoneE164 || phoneE164),
    validationCode: data.validationCode ? String(data.validationCode) : undefined,
  };
}

export function listenWebOtp(onCode: (code: string) => void): () => void {
  if (typeof window === 'undefined' || !('OTPCredential' in window) || !navigator.credentials) {
    return () => {};
  }
  const ac = new AbortController();
  (
    navigator.credentials.get as unknown as (opts: Record<string, unknown>) => Promise<{ code?: string } | null>
  )({
    otp: { transport: ['sms'] },
    signal: ac.signal,
  })
    .then((cred) => {
      if (cred?.code) {
        onCode(cred.code);
      }
    })
    .catch(() => {
      // Ignore abort or unsupported WebOTP environments
    });
  return () => ac.abort();
}
