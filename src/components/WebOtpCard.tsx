import React, { useEffect, useId, useRef, useState } from 'react';
import { ConfirmationResult, RecaptchaVerifier, linkWithPhoneNumber } from 'firebase/auth';
import { CheckCircle2, KeyRound, Phone, ShieldCheck } from 'lucide-react';
import { auth } from '../lib/firebase';
import {
  SmsNotConfiguredError,
  fetchOtpProviderStatus,
  formatOtpProviderLabel,
  isTwilioCallerIdOrGeoError,
  listenWebOtp,
  requestServerOtp,
  verifyServerOtpRequest,
  type OtpGatewayProvider,
  type ServerOtpChallenge,
  type WebOtpChannel,
} from '../lib/otpClient';
import { updateVerifiedPhoneInProfile } from '../lib/sikshaliteService';
import { normalizePhoneE164, type UserProfile } from '../types/sikshalite';
import { CallerIdHelperPanel } from './CallerIdHelperPanel';

interface WebOtpCardProps {
  profile: UserProfile;
}

export const WebOtpCard: React.FC<WebOtpCardProps> = ({ profile }) => {
  const containerId = `recaptcha-profile-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [provider, setProvider] = useState<OtpGatewayProvider>('firebase_only');
  const [channel, setChannel] = useState<WebOtpChannel>('auto');
  const [countryCode, setCountryCode] = useState('+91');
  const [phoneInput, setPhoneInput] = useState(() => {
    const raw = auth.currentUser?.phoneNumber || profile.phoneE164 || '';
    if (raw.startsWith('+91') && raw.length === 13) return raw.slice(3);
    return raw;
  });
  const [otpCode, setOtpCode] = useState('');
  const [fbConfirm, setFbConfirm] = useState<ConfirmationResult | null>(null);
  const [serverChallenge, setServerChallenge] = useState<ServerOtpChallenge | null>(null);
  const [verifiedNumber, setVerifiedNumber] = useState<string>(() => {
    if (auth.currentUser?.phoneNumber) return auth.currentUser.phoneNumber;
    if (typeof window !== 'undefined') {
      return window.sessionStorage.getItem('sikshalite_verified_phone') || '';
    }
    return '';
  });
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');
  const [showCallerIdHelp, setShowCallerIdHelp] = useState(false);
  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => {
    fetchOtpProviderStatus().then(setProvider);
    return () => {
      if (recaptchaRef.current) {
        try {
          recaptchaRef.current.clear();
        } catch {
          // ignore cleanup
        }
        recaptchaRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!fbConfirm && !serverChallenge) return;
    return listenWebOtp((code) => setOtpCode(code));
  }, [fbConfirm, serverChallenge]);

  const getRecaptcha = () => {
    if (recaptchaRef.current) {
      try {
        recaptchaRef.current.clear();
      } catch {
        // ignore
      }
    }
    const verifier = new RecaptchaVerifier(auth, containerId, { size: 'invisible' });
    recaptchaRef.current = verifier;
    return verifier;
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    setErrorMsg('');
    setInfoMsg('');
    const e164 = normalizePhoneE164(phoneInput, countryCode);
    if (!e164 || e164.length < 8) {
      setErrorMsg('Please enter a valid mobile number with country code.');
      return;
    }

    const preferServer =
      channel === 'server' || (channel === 'auto' && provider !== 'firebase_only');

    setBusy(true);
    setShowCallerIdHelp(false);
    try {
      if (preferServer) {
        try {
          const challenge = await requestServerOtp(e164);
          setFbConfirm(null);
          setServerChallenge(challenge);
          setInfoMsg(
            `OTP sent to ${challenge.phoneE164} via ${formatOtpProviderLabel(challenge.mode)}. Enter the code below.`
          );
          return;
        } catch (serverErr) {
          if (channel === 'server') {
            throw serverErr;
          }
          // In Auto mode, fall back to Firebase Phone OTP if server gateway hits Trial/Caller-ID/Geo error
          try {
            const verifier = getRecaptcha();
            const res = await linkWithPhoneNumber(currentUser, e164, verifier);
            setFbConfirm(res);
            setServerChallenge(null);
            setInfoMsg(`SMS OTP sent to ${e164} via Firebase Phone. Enter the code below.`);
            return;
          } catch {
            throw serverErr;
          }
        }
      }

      try {
        const verifier = getRecaptcha();
        const res = await linkWithPhoneNumber(currentUser, e164, verifier);
        setFbConfirm(res);
        setServerChallenge(null);
        setInfoMsg(`SMS OTP sent to ${e164} via Firebase Phone. Enter the code below.`);
        return;
      } catch (fbErr) {
        const code = (fbErr as { code?: string })?.code || '';
        if (code === 'auth/invalid-phone-number' || code === 'auth/too-many-requests') {
          throw fbErr;
        }
        if (channel === 'firebase') {
          throw fbErr;
        }
      }

      const challenge = await requestServerOtp(e164);
      setFbConfirm(null);
      setServerChallenge(challenge);
      setInfoMsg(
        `OTP sent to ${challenge.phoneE164} via ${formatOtpProviderLabel(challenge.mode)}. Enter the code below.`
      );
    } catch (err) {
      if (err instanceof SmsNotConfiguredError) {
        setErrorMsg(
          'No SMS OTP provider is active yet. Enable Phone Sign-In in Firebase Console or add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID in Settings → Secrets.'
        );
      } else {
        const msg = err instanceof Error ? err.message : 'Unable to send OTP.';
        setErrorMsg(msg);
        if (isTwilioCallerIdOrGeoError(msg)) {
          setShowCallerIdHelp(true);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setBusy(true);
    try {
      let confirmedPhone = '';
      if (fbConfirm) {
        const cred = await fbConfirm.confirm(otpCode.trim());
        confirmedPhone = cred.user.phoneNumber || normalizePhoneE164(phoneInput, countryCode);
      } else if (serverChallenge) {
        confirmedPhone = await verifyServerOtpRequest(serverChallenge.phoneE164, otpCode.trim());
      }

      if (confirmedPhone) {
        setVerifiedNumber(confirmedPhone);
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem('sikshalite_verified_phone', confirmedPhone);
        }
        await updateVerifiedPhoneInProfile(profile.uid, confirmedPhone);
        setFbConfirm(null);
        setServerChallenge(null);
        setOtpCode('');
        setInfoMsg(`Mobile number ${confirmedPhone} verified via OTP on the web.`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'OTP verification failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
      <div id={containerId} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-[#312E81]" />
          <div>
            <h3 className="text-base font-bold text-[#0F172A]">Web Mobile OTP Verification</h3>
            <p className="text-xs text-[#64748B]">
              Verify your mobile number directly in the browser using {formatOtpProviderLabel(provider)}.
            </p>
          </div>
        </div>
        {verifiedNumber && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#ECFDF5] border border-[#A7F3D0] text-xs font-mono font-semibold text-[#059669]">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Verified: {verifiedNumber}
          </span>
        )}
      </div>

      {errorMsg && (
        <div className="p-3 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#DC2626] break-words">
          {errorMsg}
        </div>
      )}
      {infoMsg && (
        <div className="p-3 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-xs text-[#059669]">
          {infoMsg}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-[#475569]">Verification Method:</span>
        {(
          [
            { id: 'auto', label: `Auto (${formatOtpProviderLabel(provider)})` },
            { id: 'server', label: 'Twilio / Server OTP' },
            { id: 'firebase', label: 'Firebase Phone OTP' },
          ] as { id: WebOtpChannel; label: string }[]
        ).map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => {
              setChannel(opt.id);
              setErrorMsg('');
            }}
            className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
              channel === opt.id
                ? 'bg-[#312E81] text-white border-[#312E81]'
                : 'bg-[#FAF9F6] text-[#475569] border-[#E7E5E0] hover:border-[#312E81]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {(showCallerIdHelp || isTwilioCallerIdOrGeoError(errorMsg)) && (
        <CallerIdHelperPanel
          phoneInput={phoneInput}
          countryCode={countryCode}
          onSwitchToFirebase={() => {
            setChannel('firebase');
            setErrorMsg('');
            setShowCallerIdHelp(false);
            setInfoMsg('Switched to Firebase Phone OTP. Click Send Web OTP below.');
          }}
          onCallerIdVerified={() => {
            setErrorMsg('');
          }}
        />
      )}

      {!fbConfirm && !serverChallenge ? (
        <form onSubmit={handleSendOtp} className="space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              className="w-20 px-3 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm text-[#0F172A]"
              aria-label="Country dial code"
            />
            <div className="relative flex-1">
              <Phone className="w-4 h-4 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="tel"
                required
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="9876543210"
                className="w-full pl-9 pr-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm text-[#0F172A]"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Sending OTP...' : verifiedNumber ? 'Re-verify Mobile via OTP' : 'Send Web OTP'}
            </button>
            {(provider === 'twilio' || provider === 'twilio_verify' || channel === 'server') && (
              <button
                type="button"
                onClick={() => setShowCallerIdHelp((prev) => !prev)}
                className="text-xs font-medium text-[#312E81] hover:underline cursor-pointer"
              >
                {showCallerIdHelp ? 'Hide Caller ID Help' : 'Can’t add Twilio Caller ID?'}
              </button>
            )}
          </div>
        </form>
      ) : (
        <form onSubmit={handleVerifyOtp} className="space-y-3">
          <div className="relative">
            <KeyRound className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              placeholder="Enter OTP code"
              className="w-full pl-10 pr-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-base tracking-[0.25em] text-[#0F172A]"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setFbConfirm(null);
                setServerChallenge(null);
                setOtpCode('');
                setInfoMsg('');
              }}
              className="px-4 py-2.5 min-h-[40px] rounded-lg border border-[#E7E5E0] text-xs font-medium text-[#475569] cursor-pointer"
            >
              Change Number
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2.5 min-h-[40px] rounded-lg bg-[#059669] text-white text-xs font-semibold hover:bg-[#047857] cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Verifying...' : 'Verify OTP'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
