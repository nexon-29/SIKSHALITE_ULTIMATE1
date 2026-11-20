import React, { useState } from 'react';
import { PhoneCall, ShieldAlert } from 'lucide-react';
import { requestTwilioCallerIdVerification } from '../lib/otpClient';
import { normalizePhoneE164 } from '../types/sikshalite';

interface CallerIdHelperPanelProps {
  phoneInput: string;
  countryCode: string;
  onSwitchToFirebase: () => void;
  onCallerIdVerified?: (phoneE164: string) => void;
}

export const CallerIdHelperPanel: React.FC<CallerIdHelperPanelProps> = ({
  phoneInput,
  countryCode,
  onSwitchToFirebase,
  onCallerIdVerified,
}) => {
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [keypadCode, setKeypadCode] = useState('');

  const handleStartCallerIdCall = async () => {
    setErrMsg('');
    setStatusMsg('');
    setKeypadCode('');
    const e164 = normalizePhoneE164(phoneInput, countryCode);
    if (!e164 || e164.length < 8) {
      setErrMsg('Enter a valid mobile number with country code above first.');
      return;
    }

    setBusy(true);
    try {
      const res = await requestTwilioCallerIdVerification(e164);
      if (res.alreadyVerified) {
        setStatusMsg(`${res.phoneE164} is already verified in your Twilio Caller IDs. You can send OTP now.`);
        onCallerIdVerified?.(res.phoneE164);
      } else if (res.callInitiated) {
        setKeypadCode(res.validationCode || '');
        setStatusMsg(
          `Twilio is calling ${res.phoneE164} now. Answer the automated call and enter the keypad code shown below.`
        );
      }
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Unable to add Twilio Caller ID.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 rounded-xl bg-[#FFFBEB] border border-[#FDE68A] text-xs text-[#78350F] space-y-3 leading-relaxed">
      <div className="flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 text-[#B45309] shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-semibold text-[#78350F]">
            Can’t add a Twilio Verified Caller ID?
          </p>
          <p className="text-[#92400E]">
            Twilio Trial accounts verify Caller IDs via an automated <strong>voice call</strong> (not SMS). If adding fails in Twilio Console:
          </p>
        </div>
      </div>

      <ol className="list-decimal list-inside space-y-1 text-[#92400E]">
        <li>
          Enable <strong>Voice Geo-Permissions</strong> for your country in Twilio Console → <strong>Voice → Settings → Geo Permissions</strong> (and check <strong>Messaging → Settings → Geo Permissions</strong> for SMS).
        </li>
        <li>
          Or bypass Twilio Caller IDs completely by switching to <strong>Firebase Phone OTP</strong> (requires enabling <strong>Phone</strong> under Firebase Console → Authentication → Sign-in method) or adding <strong>Fast2SMS / MSG91</strong> in Secrets.
        </li>
      </ol>

      {errMsg && (
        <div className="p-2.5 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] break-words">
          {errMsg}
        </div>
      )}

      {statusMsg && (
        <div className="p-2.5 rounded-lg bg-[#ECFDF5] border border-[#A7F3D0] text-[#059669] space-y-1.5">
          <p>{statusMsg}</p>
          {keypadCode && (
            <p className="font-mono text-sm font-bold tracking-[0.2em] text-[#0F172A]">
              Call Keypad Code: {keypadCode}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          disabled={busy}
          onClick={handleStartCallerIdCall}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#312E81] text-white text-[11px] font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
        >
          <PhoneCall className="w-3.5 h-3.5" />
          {busy ? 'Calling Phone...' : 'Verify Twilio Caller ID (Voice Call)'}
        </button>

        <button
          type="button"
          onClick={onSwitchToFirebase}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white border border-[#F59E0B] text-[#78350F] text-[11px] font-semibold hover:bg-[#FEF3C7] cursor-pointer"
        >
          Switch to Firebase Phone OTP (No Caller ID Needed)
        </button>
      </div>
    </div>
  );
};
