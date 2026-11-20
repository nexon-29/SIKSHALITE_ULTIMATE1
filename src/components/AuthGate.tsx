import React, { useEffect, useRef, useState } from 'react';
import {
  ConfirmationResult,
  RecaptchaVerifier,
  linkWithPhoneNumber,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  KeyRound,
  Phone,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { auth, formatReadableFirestoreError, googleProvider } from '../lib/firebase';
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
import { claimRoleByVerifiedPhone, createInstitutionAccount } from '../lib/sikshaliteService';
import { normalizePhoneE164, type UserProfile } from '../types/sikshalite';
import { CallerIdHelperPanel } from './CallerIdHelperPanel';
import { PhotoUploadField } from './PhotoUploadField';
import { PWAInstallButton } from './PWAInstallButton';

interface AuthGateProps {
  firebaseUser: User | null;
  authLoading: boolean;
  onProfileResolved: (profile: UserProfile) => void;
  onRecheckEnrollment: () => Promise<void>;
}

export const AuthGate: React.FC<AuthGateProps> = ({
  firebaseUser,
  authLoading,
  onProfileResolved,
  onRecheckEnrollment,
}) => {
  const [authTab, setAuthTab] = useState<'phone' | 'google'>('phone');
  const [countryCode, setCountryCode] = useState('+91');
  const [mobileInput, setMobileInput] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const [serverOtp, setServerOtp] = useState<ServerOtpChallenge | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return window.sessionStorage.getItem('sikshalite_verified_phone') || '';
    }
    return '';
  });
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');
  const [smsSetupNeeded, setSmsSetupNeeded] = useState(false);
  const [showCallerIdHelp, setShowCallerIdHelp] = useState(false);
  const [otpProvider, setOtpProvider] = useState<OtpGatewayProvider>('firebase_only');
  const [otpChannel, setOtpChannel] = useState<WebOtpChannel>('auto');

  // Institution Onboarding state (when signed-in user has no profile yet)
  const [onboardTab, setOnboardTab] = useState<'institution' | 'link'>('institution');
  const [instName, setInstName] = useState('');
  const [instTagline, setInstTagline] = useState('');
  const [adminName, setAdminName] = useState('');
  const [instPhoto, setInstPhoto] = useState('');
  const [adminPhoto, setAdminPhoto] = useState('');

  // Link Phone to signed-in account state
  const [linkPhoneInput, setLinkPhoneInput] = useState('');
  const [linkOtp, setLinkOtp] = useState('');
  const [linkConfirm, setLinkConfirm] = useState<ConfirmationResult | null>(null);
  const [linkServerOtp, setLinkServerOtp] = useState<ServerOtpChallenge | null>(null);

  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => {
    fetchOtpProviderStatus().then(setOtpProvider);
  }, []);

  useEffect(() => {
    if (firebaseUser?.displayName && !adminName) {
      setAdminName(firebaseUser.displayName);
    }
  }, [firebaseUser, adminName]);

  useEffect(() => {
    if (!confirmation && !serverOtp) return;
    return listenWebOtp((code) => setOtpCode(code));
  }, [confirmation, serverOtp]);

  useEffect(() => {
    if (!linkConfirm && !linkServerOtp) return;
    return listenWebOtp((code) => setLinkOtp(code));
  }, [linkConfirm, linkServerOtp]);

  useEffect(() => {
    return () => {
      if (recaptchaRef.current) {
        try {
          recaptchaRef.current.clear();
        } catch {
          // ignore cleanup errors
        }
        recaptchaRef.current = null;
      }
    };
  }, []);

  const getRecaptcha = (containerId: string) => {
    if (recaptchaRef.current) {
      try {
        recaptchaRef.current.clear();
      } catch {
        // ignore
      }
    }
    const verifier = new RecaptchaVerifier(auth, containerId, {
      size: 'invisible',
    });
    recaptchaRef.current = verifier;
    return verifier;
  };

  const formatAuthError = (err: unknown): string => {
    const code = (err as { code?: string })?.code || '';
    const msg = err instanceof Error ? err.message : String(err);
    if (code === 'auth/invalid-phone-number') {
      return 'Invalid phone number format. Include country code (e.g. +91 9876543210).';
    }
    if (code === 'auth/invalid-verification-code') {
      return 'Incorrect 6-digit OTP code. Please check your SMS and try again.';
    }
    if (code === 'auth/too-many-requests') {
      return 'Too many attempts from this device. Please wait a moment and retry.';
    }
    if (code === 'auth/popup-closed-by-user') {
      return 'Google Sign-In popup was closed before completing. Click Continue with Google to retry.';
    }
    return msg;
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    setSmsSetupNeeded(false);
    setVerifiedPhone('');
    const e164 = normalizePhoneE164(mobileInput, countryCode);
    if (!e164 || e164.length < 8) {
      setErrorMsg('Please enter a valid 10-digit mobile number.');
      return;
    }

    const preferServer =
      otpChannel === 'server' || (otpChannel === 'auto' && otpProvider !== 'firebase_only');

    setBusy(true);
    setShowCallerIdHelp(false);
    try {
      if (preferServer) {
        try {
          const challenge = await requestServerOtp(e164);
          setConfirmation(null);
          setServerOtp(challenge);
          setInfoMsg(
            `SMS OTP sent to ${challenge.phoneE164} via ${formatOtpProviderLabel(challenge.mode)}. Enter the code received on your mobile.`
          );
          return;
        } catch (serverErr) {
          if (otpChannel === 'server') {
            throw serverErr;
          }
          // In Auto mode, fall back to Firebase Phone Auth if Twilio Trial / Caller ID blocks SMS
          try {
            const verifier = getRecaptcha('recaptcha-container-login');
            const result = await signInWithPhoneNumber(auth, e164, verifier);
            setConfirmation(result);
            setServerOtp(null);
            setInfoMsg(
              `SMS OTP sent to ${e164} via Firebase Phone. Check your phone messages and enter the code below.`
            );
            return;
          } catch {
            throw serverErr;
          }
        }
      }

      try {
        const verifier = getRecaptcha('recaptcha-container-login');
        const result = await signInWithPhoneNumber(auth, e164, verifier);
        setConfirmation(result);
        setServerOtp(null);
        setInfoMsg(
          `SMS OTP sent to ${e164} via Firebase Phone. Check your phone messages and enter the code below.`
        );
        return;
      } catch (fbErr) {
        const code = (fbErr as { code?: string })?.code || '';
        const isUserInputOrThrottle =
          code === 'auth/invalid-phone-number' ||
          code === 'auth/too-many-requests';
        if (isUserInputOrThrottle || otpChannel === 'firebase') {
          throw fbErr;
        }
      }

      // Carrier SMS gateway delivery (Twilio / Fast2SMS / MSG91) when configured on server
      const challenge = await requestServerOtp(e164);
      setConfirmation(null);
      setServerOtp(challenge);
      setInfoMsg(
        `SMS OTP sent to ${challenge.phoneE164} via ${formatOtpProviderLabel(challenge.mode)}. Enter the code delivered to your mobile.`
      );
    } catch (err) {
      if (err instanceof SmsNotConfiguredError) {
        setSmsSetupNeeded(true);
        setErrorMsg(
          `Cannot send SMS to ${e164} yet: live SMS delivery is not enabled on Firebase or a carrier gateway. Follow the steps below to send real SMS OTPs directly to mobile numbers.`
        );
      } else {
        const formatted = formatAuthError(err);
        setErrorMsg(formatted);
        if (isTwilioCallerIdOrGeoError(formatted)) {
          setShowCallerIdHelp(true);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const handleResendServerOtp = async () => {
    if (!serverOtp) return;
    setErrorMsg('');
    setBusy(true);
    try {
      const challenge = await requestServerOtp(serverOtp.phoneE164);
      setServerOtp(challenge);
      setInfoMsg(`New SMS OTP sent to ${challenge.phoneE164}. Check your mobile messages.`);
    } catch (err) {
      setErrorMsg(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setBusy(true);
    try {
      if (confirmation) {
        await confirmation.confirm(otpCode.trim());
      } else if (serverOtp) {
        const confirmedPhone = await verifyServerOtpRequest(serverOtp.phoneE164, otpCode.trim());
        setVerifiedPhone(confirmedPhone);
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem('sikshalite_verified_phone', confirmedPhone);
        }
        setServerOtp(null);
        setOtpCode('');
        setInfoMsg(
          `Mobile ${confirmedPhone} verified! Click "Complete Sign-In with Google" below to open your workspace.`
        );
      }
    } catch (err) {
      setErrorMsg(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setErrorMsg('');
    setBusy(true);
    try {
      if (verifiedPhone && typeof window !== 'undefined') {
        window.sessionStorage.setItem('sikshalite_verified_phone', verifiedPhone);
      }
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setErrorMsg(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateInstitution = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setErrorMsg('');
    if (instName.trim().length < 2 || adminName.trim().length < 1) {
      setErrorMsg('Please enter both Institution Name and Admin Name.');
      return;
    }
    setBusy(true);
    try {
      const profile = await createInstitutionAccount(firebaseUser, {
        institutionName: instName,
        tagline: instTagline,
        adminName,
        institutionPhoto: instPhoto,
        adminPhoto,
      });
      onProfileResolved(profile);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to register institution.');
    } finally {
      setBusy(false);
    }
  };

  const handleSendLinkOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setErrorMsg('');
    setInfoMsg('');
    setSmsSetupNeeded(false);
    const e164 = normalizePhoneE164(linkPhoneInput, countryCode);
    if (!e164 || e164.length < 8) {
      setErrorMsg('Enter the exact mobile number registered by your Institution or Teacher.');
      return;
    }
    const preferServer =
      otpChannel === 'server' || (otpChannel === 'auto' && otpProvider !== 'firebase_only');

    setBusy(true);
    setShowCallerIdHelp(false);
    try {
      if (preferServer) {
        try {
          const challenge = await requestServerOtp(e164);
          setLinkConfirm(null);
          setLinkServerOtp(challenge);
          setInfoMsg(
            `Verification SMS sent to ${challenge.phoneE164} via ${formatOtpProviderLabel(challenge.mode)}. Enter the OTP received on your phone.`
          );
          return;
        } catch (serverErr) {
          if (otpChannel === 'server') {
            throw serverErr;
          }
          try {
            const verifier = getRecaptcha('recaptcha-container-link');
            const res = await linkWithPhoneNumber(firebaseUser, e164, verifier);
            setLinkConfirm(res);
            setLinkServerOtp(null);
            setInfoMsg(`Verification SMS sent to ${e164} via Firebase Phone. Check your phone messages.`);
            return;
          } catch {
            throw serverErr;
          }
        }
      }

      try {
        const verifier = getRecaptcha('recaptcha-container-link');
        const res = await linkWithPhoneNumber(firebaseUser, e164, verifier);
        setLinkConfirm(res);
        setLinkServerOtp(null);
        setInfoMsg(`Verification SMS sent to ${e164} via Firebase Phone. Check your phone messages.`);
        return;
      } catch (fbErr) {
        const code = (fbErr as { code?: string })?.code || '';
        const isUserInputOrThrottle =
          code === 'auth/invalid-phone-number' ||
          code === 'auth/too-many-requests';
        if (isUserInputOrThrottle || otpChannel === 'firebase') {
          throw fbErr;
        }
      }

      const challenge = await requestServerOtp(e164);
      setLinkConfirm(null);
      setLinkServerOtp(challenge);
      setInfoMsg(
        `Verification SMS sent to ${challenge.phoneE164} via ${formatOtpProviderLabel(challenge.mode)}. Enter the code received on your phone.`
      );
    } catch (err) {
      if (err instanceof SmsNotConfiguredError) {
        setSmsSetupNeeded(true);
        setErrorMsg(
          `Cannot send SMS to ${e164} yet: enable Phone Sign-In in Firebase Console or add TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SERVICE_SID in Secrets.`
        );
      } else {
        const formatted = formatAuthError(err);
        setErrorMsg(formatted);
        if (isTwilioCallerIdOrGeoError(formatted)) {
          setShowCallerIdHelp(true);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmLinkOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setErrorMsg('');
    setBusy(true);
    try {
      if (linkConfirm) {
        await linkConfirm.confirm(linkOtp.trim());
        await onRecheckEnrollment();
      } else if (linkServerOtp) {
        const confirmedPhone = await verifyServerOtpRequest(linkServerOtp.phoneE164, linkOtp.trim());
        setVerifiedPhone(confirmedPhone);
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem('sikshalite_verified_phone', confirmedPhone);
        }
        const claimed = await claimRoleByVerifiedPhone(firebaseUser, confirmedPhone);
        setLinkServerOtp(null);
        setLinkOtp('');
        if (claimed) {
          onProfileResolved(claimed);
        } else {
          setInfoMsg(
            `Mobile ${confirmedPhone} verified, but no unclaimed Teacher/Student record was found for this number yet. Ask your Institution Admin or Teacher to enroll ${confirmedPhone}, then click Recheck My Enrollment.`
          );
        }
      }
    } catch (err) {
      setErrorMsg(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#FAF9F6] flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 rounded-xl bg-[#312E81] mx-auto flex items-center justify-center text-white font-display font-bold text-lg">
            S
          </div>
          <p className="text-sm text-[#475569]">Loading Sikshalite workspace...</p>
        </div>
      </div>
    );
  }

  // Signed in, but not yet bound to an Institution / Teacher / Student profile
  if (firebaseUser) {
    return (
      <div className="min-h-screen bg-[#FAF9F6]">
        <header className="border-b border-[#E7E5E0] bg-white">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-8">
            <span className="font-display text-lg font-bold tracking-tight text-[#0F172A] whitespace-nowrap shrink-0">
              Sikshalite
            </span>
            <div className="hidden md:flex items-center gap-6 text-xs text-[#64748B]">
              <span>Signed in: {firebaseUser.phoneNumber || firebaseUser.email}</span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <PWAInstallButton />
              <button
                type="button"
                onClick={() => signOut(auth)}
                className="px-4 py-2 rounded-lg border border-[#E7E5E0] text-xs font-medium text-[#334155] hover:text-[#0F172A] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Sign Out
              </button>
            </div>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-6 py-10">
          <div className="mb-8">
            <p className="text-xs font-medium text-[#312E81] mb-2">Account Setup</p>
            <h1 className="text-2xl md:text-3xl font-bold text-[#0F172A] tracking-tight text-balance">
              Complete your Sikshalite setup
            </h1>
            <p className="mt-2 text-sm text-[#475569] leading-relaxed">
              Register as an Institution first to manage subjects, teachers, and students—or verify your enrolled mobile number if a teacher already added you.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#EFECE4] rounded-xl mb-6 w-fit">
            <button
              type="button"
              onClick={() => {
                setOnboardTab('institution');
                setErrorMsg('');
              }}
              className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                onboardTab === 'institution'
                  ? 'bg-white text-[#0F172A] shadow-sm'
                  : 'text-[#475569] hover:text-[#0F172A]'
              }`}
            >
              Register Institution
            </button>
            <button
              type="button"
              onClick={() => {
                setOnboardTab('link');
                setErrorMsg('');
              }}
              className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                onboardTab === 'link'
                  ? 'bg-white text-[#0F172A] shadow-sm'
                  : 'text-[#475569] hover:text-[#0F172A]'
              }`}
            >
              Claim Teacher / Student ID
            </button>
          </div>

          {errorMsg && (
            <div className="mb-5 p-3.5 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#DC2626] break-words">
              {formatReadableFirestoreError(errorMsg, errorMsg)}
            </div>
          )}
          {infoMsg && (
            <div className="mb-5 p-3.5 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-xs text-[#059669]">
              {infoMsg}
            </div>
          )}

          {onboardTab === 'institution' ? (
            <form
              onSubmit={handleCreateInstitution}
              className="bg-white border border-[#E7E5E0] rounded-2xl p-6 md:p-8 space-y-5"
            >
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1.5">
                  Institution Name *
                </label>
                <input
                  type="text"
                  required
                  maxLength={120}
                  value={instName}
                  onChange={(e) => setInstName(e.target.value)}
                  placeholder="e.g. Vidya Bharati Science Academy"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm text-[#0F172A] focus:outline-none focus:border-[#312E81]"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1.5">
                    Admin / Principal Name *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={adminName}
                    onChange={(e) => setAdminName(e.target.value)}
                    placeholder="e.g. Dr. Ananya Sen"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm text-[#0F172A] focus:outline-none focus:border-[#312E81]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1.5">
                    Academic Motto / Tagline
                  </label>
                  <input
                    type="text"
                    maxLength={200}
                    value={instTagline}
                    onChange={(e) => setInstTagline(e.target.value)}
                    placeholder="e.g. Tracking mastery every week"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm text-[#0F172A] focus:outline-none focus:border-[#312E81]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                <PhotoUploadField
                  label="Institution Photo / Crest"
                  value={instPhoto}
                  onChange={setInstPhoto}
                  shape="banner"
                  placeholderTitle="Campus / Logo"
                />
                <PhotoUploadField
                  label="Your Admin Photo"
                  value={adminPhoto}
                  onChange={setAdminPhoto}
                  shape="circle"
                />
              </div>

              <div className="pt-3 flex items-center justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-6 py-3 min-h-[44px] rounded-xl bg-[#312E81] text-white text-sm font-semibold hover:bg-[#4338CA] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {busy ? 'Creating Institution...' : 'Launch Institution Dashboard'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          ) : (
            <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 md:p-8 space-y-6">
              <div className="space-y-2">
                <h2 className="text-base font-semibold text-[#0F172A]">
                  Link Enrolled Mobile Number
                </h2>
                <p className="text-sm text-[#475569]">
                  If your Institution Admin or Teacher registered you using your mobile number, sign in with that phone number via SMS OTP (or link it below) to automatically load your subjects and Unique Student ID.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onRecheckEnrollment}
                  className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-xs font-semibold text-[#0F172A] hover:border-[#312E81] cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4" />
                  Recheck My Enrollment
                </button>
              </div>

              {!firebaseUser.phoneNumber && (
                <div className="pt-4 border-t border-[#E7E5E0] space-y-4">
                  <div id="recaptcha-container-link" />
                  {!linkConfirm && !linkServerOtp ? (
                    <form onSubmit={handleSendLinkOtp} className="space-y-3">
                      <label className="block text-xs font-medium text-[#475569]">
                        Link Mobile Number via Web OTP
                      </label>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-medium text-[#64748B] mr-1">
                          OTP Option:
                        </span>
                        {(
                          [
                            { id: 'auto', label: `Auto (${formatOtpProviderLabel(otpProvider)})` },
                            { id: 'server', label: 'Twilio / Server OTP' },
                            { id: 'firebase', label: 'Firebase Phone OTP' },
                          ] as { id: WebOtpChannel; label: string }[]
                        ).map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => {
                              setOtpChannel(opt.id);
                              setErrorMsg('');
                            }}
                            className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
                              otpChannel === opt.id
                                ? 'bg-[#312E81] text-white border-[#312E81]'
                                : 'bg-[#FAF9F6] text-[#475569] border-[#E7E5E0] hover:border-[#312E81]'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={countryCode}
                          onChange={(e) => setCountryCode(e.target.value)}
                          className="w-20 px-3 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm text-[#0F172A]"
                          aria-label="Country code"
                        />
                        <input
                          type="tel"
                          value={linkPhoneInput}
                          onChange={(e) => setLinkPhoneInput(e.target.value)}
                          placeholder="10-digit mobile number"
                          className="flex-1 px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm text-[#0F172A]"
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="submit"
                          disabled={busy}
                          className="px-5 py-2.5 min-h-[44px] rounded-lg bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                        >
                          {busy ? 'Sending OTP...' : 'Send Link OTP'}
                        </button>
                        {(otpProvider === 'twilio' || otpProvider === 'twilio_verify' || otpChannel === 'server') && (
                          <button
                            type="button"
                            onClick={() => setShowCallerIdHelp((prev) => !prev)}
                            className="text-xs font-medium text-[#312E81] hover:underline cursor-pointer"
                          >
                            {showCallerIdHelp ? 'Hide Caller ID Help' : 'Can’t add Twilio Caller ID?'}
                          </button>
                        )}
                      </div>
                      {(showCallerIdHelp || isTwilioCallerIdOrGeoError(errorMsg)) && (
                        <CallerIdHelperPanel
                          phoneInput={linkPhoneInput}
                          countryCode={countryCode}
                          onSwitchToFirebase={() => {
                            setOtpChannel('firebase');
                            setErrorMsg('');
                            setShowCallerIdHelp(false);
                            setInfoMsg('Switched to Firebase Phone OTP. Click Send Link OTP above.');
                          }}
                          onCallerIdVerified={() => setErrorMsg('')}
                        />
                      )}
                    </form>
                  ) : (
                    <form onSubmit={handleConfirmLinkOtp} className="space-y-3">
                      <label className="block text-xs font-medium text-[#475569]">
                        Enter SMS Verification OTP
                      </label>
                      <input
                        type="text"
                        required
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={8}
                        value={linkOtp}
                        onChange={(e) => setLinkOtp(e.target.value)}
                        placeholder="Enter OTP"
                        className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-base tracking-widest text-[#0F172A]"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setLinkConfirm(null);
                            setLinkServerOtp(null);
                            setLinkOtp('');
                          }}
                          className="px-4 py-2.5 min-h-[44px] rounded-lg border border-[#E7E5E0] text-xs font-medium text-[#475569] cursor-pointer"
                        >
                          Change Number
                        </button>
                        <button
                          type="submit"
                          disabled={busy}
                          className="px-5 py-2.5 min-h-[44px] rounded-lg bg-[#059669] text-white text-xs font-semibold hover:bg-[#047857] cursor-pointer disabled:opacity-50"
                        >
                          {busy ? 'Verifying...' : 'Verify & Claim Role'}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FAF9F6] flex flex-col">
      {/* Three-Zone Top Bar Contract */}
      <header className="border-b border-[#E7E5E0] bg-white/95 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-6 py-3.5 flex items-center justify-between gap-8">
          <a
            href="#top"
            className="font-display text-xl font-bold tracking-tight text-[#312E81] whitespace-nowrap shrink-0"
          >
            Sikshalite
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-[#475569]">
            <a href="#workflow" className="hover:text-[#0F172A] transition-colors whitespace-nowrap shrink-0">
              How It Works
            </a>
            <a href="#roles" className="hover:text-[#0F172A] transition-colors whitespace-nowrap shrink-0">
              Institutions
            </a>
            <a href="#roles" className="hover:text-[#0F172A] transition-colors whitespace-nowrap shrink-0">
              Teachers
            </a>
            <a href="#roles" className="hover:text-[#0F172A] transition-colors whitespace-nowrap shrink-0">
              Students
            </a>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <PWAInstallButton />
            <a
              href="#auth-panel"
              className="px-4 py-2 min-h-[40px] inline-flex items-center rounded-lg bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] transition-colors whitespace-nowrap shrink-0"
            >
              Sign In
            </a>
          </div>
        </div>
      </header>

      {/* Main Split Hero */}
      <main id="top" className="flex-1 max-w-7xl w-full mx-auto px-6 py-10 md:py-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          {/* Left Column: Editorial Academic Pitch */}
          <div className="lg:col-span-7 flex flex-col justify-between space-y-8">
            <div className="space-y-5">
              <p className="text-xs font-medium text-[#475569]">
                Web & Android Study Growth Platform · Powered by Gemini AI
              </p>
              <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-[#0F172A] tracking-tight leading-[1.12] text-balance max-w-2xl">
                Measure every student’s academic growth from Pre-Test to mastery.
              </h1>
              <p className="text-base text-[#475569] leading-relaxed max-w-xl">
                Institutions onboard first, assign subject-scoped teachers, and enroll students with unique IDs linked to their mobile numbers. Teachers deliver AI-assisted study guides, reference visuals, assignments, and Pre/Post assessments that prove real learning gain.
              </p>
            </div>

            {/* Clean Architectural SVG Academic Visual (Zero external broken image dependencies) */}
            <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between text-xs text-[#64748B]">
                <span className="font-medium text-[#0F172A]">4-Stage Topic Growth Loop</span>
                <span className="font-mono tabular-nums">Pre-Test → Study → Assignment → Post-Test</span>
              </div>
              <svg viewBox="0 0 680 150" className="w-full h-auto" role="img" aria-label="Study growth trajectory from Pre-Test to Post-Test">
                <rect x="0" y="0" width="680" height="150" rx="12" fill="#FAF9F6" />
                <line x1="40" y1="118" x2="640" y2="118" stroke="#E7E5E0" strokeWidth="1.5" />
                <path
                  d="M70 102 C170 96, 250 86, 340 68 C430 50, 520 34, 610 26"
                  fill="none"
                  stroke="#059669"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                />
                {[
                  { x: 70, y: 102, label: '1. Pre-Test', sub: '48% Baseline' },
                  { x: 250, y: 84, label: '2. Study + Visuals', sub: 'Reference Pics' },
                  { x: 430, y: 50, label: '3. Assignment', sub: 'Written / File' },
                  { x: 610, y: 26, label: '4. Post-Test', sub: '86% (+38% Gain)' },
                ].map((pt, i) => (
                  <g key={i}>
                    <circle cx={pt.x} cy={pt.y} r="7" fill="#312E81" stroke="#FAF9F6" strokeWidth="2.5" />
                    <text x={pt.x} y="135" textAnchor="middle" fill="#0F172A" fontSize="11" fontWeight="600">
                      {pt.label}
                    </text>
                    <text x={pt.x} y={pt.y - 14} textAnchor="middle" fill="#059669" fontSize="10" fontWeight="600">
                      {pt.sub}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          </div>

          {/* Right Column: SMS OTP & Google Sign-In Panel */}
          <div id="auth-panel" className="lg:col-span-5 flex">
            <div className="w-full bg-white border border-[#E7E5E0] rounded-2xl p-6 sm:p-8 flex flex-col justify-between">
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-bold text-[#0F172A]">Sign in to Sikshalite</h2>
                  <p className="mt-1 text-sm text-[#64748B]">
                    Access your Institution Admin, Teacher, or Student workspace.
                  </p>
                </div>

                {/* Auth Mode Tabs */}
                <div className="grid grid-cols-2 gap-1 p-1 bg-[#F4F2EC] rounded-xl">
                  <button
                    type="button"
                    onClick={() => {
                      setAuthTab('phone');
                      setErrorMsg('');
                    }}
                    className={`py-2.5 px-3 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                      authTab === 'phone'
                        ? 'bg-white text-[#0F172A] shadow-sm'
                        : 'text-[#475569] hover:text-[#0F172A]'
                    }`}
                  >
                    Mobile SMS OTP
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthTab('google');
                      setErrorMsg('');
                    }}
                    className={`py-2.5 px-3 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                      authTab === 'google'
                        ? 'bg-white text-[#0F172A] shadow-sm'
                        : 'text-[#475569] hover:text-[#0F172A]'
                    }`}
                  >
                    Google Fallback
                  </button>
                </div>

                {errorMsg && (
                  <div className="p-3.5 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#DC2626] leading-relaxed break-words">
                    {formatReadableFirestoreError(errorMsg, errorMsg)}
                  </div>
                )}

                {smsSetupNeeded && (
                  <div className="p-3.5 rounded-xl bg-[#FFFBEB] border border-[#FDE68A] text-xs text-[#92400E] space-y-2 leading-relaxed">
                    <p className="font-semibold text-[#78350F]">
                      How to deliver real SMS OTPs to mobile numbers:
                    </p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>
                        <strong>Firebase Phone SMS:</strong> Open Firebase Console → Authentication → Sign-in method → enable <strong>Phone</strong>, and add this app domain under Authorized domains.
                      </li>
                      <li>
                        <strong>Twilio Verify OTP (Recommended for Twilio):</strong> Add <code className="font-mono">TWILIO_ACCOUNT_SID</code>, <code className="font-mono">TWILIO_AUTH_TOKEN</code>, and <code className="font-mono">TWILIO_VERIFY_SERVICE_SID</code> (starts with <code className="font-mono">VA...</code>) — or <code className="font-mono">TWILIO_PHONE_NUMBER</code> / <code className="font-mono">FAST2SMS_API_KEY</code> / <code className="font-mono">MSG91_*</code> — in Settings → Secrets.
                      </li>
                    </ol>
                  </div>
                )}

                {infoMsg && (
                  <div className="p-3.5 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-xs text-[#059669] leading-relaxed">
                    {infoMsg}
                  </div>
                )}

                <div id="recaptcha-container-login" />

                {authTab === 'phone' ? (
                  verifiedPhone ? (
                    <div className="space-y-4">
                      <div className="p-4 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] space-y-1.5">
                        <p className="text-xs font-semibold text-[#059669]">
                          Mobile Number Verified
                        </p>
                        <p className="font-mono text-sm font-bold text-[#0F172A]">
                          {verifiedPhone}
                        </p>
                        <p className="text-xs text-[#475569] leading-relaxed">
                          Finish connecting your session with Google to automatically open your Teacher, Student, or Institution workspace.
                        </p>
                      </div>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleGoogleSignIn}
                        className="w-full py-3 min-h-[44px] rounded-xl bg-[#312E81] text-white text-sm font-semibold hover:bg-[#4338CA] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        {busy ? 'Opening Workspace...' : 'Complete Sign-In with Google'}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setVerifiedPhone('');
                          if (typeof window !== 'undefined') {
                            window.sessionStorage.removeItem('sikshalite_verified_phone');
                          }
                          setInfoMsg('');
                        }}
                        className="w-full py-2 text-xs font-medium text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                      >
                        Use a different mobile number
                      </button>
                    </div>
                  ) : !confirmation && !serverOtp ? (
                    <form onSubmit={handleSendOtp} className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1.5">
                          Web OTP Verification Option
                        </label>
                        <div className="flex flex-wrap gap-1.5">
                          {(
                            [
                              { id: 'auto', label: `Auto (${formatOtpProviderLabel(otpProvider)})` },
                              { id: 'server', label: 'Twilio / Server OTP' },
                              { id: 'firebase', label: 'Firebase Phone OTP' },
                            ] as { id: WebOtpChannel; label: string }[]
                          ).map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => {
                                setOtpChannel(opt.id);
                                setErrorMsg('');
                              }}
                              className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
                                otpChannel === opt.id
                                  ? 'bg-[#312E81] text-white border-[#312E81]'
                                  : 'bg-[#FAF9F6] text-[#475569] border-[#E7E5E0] hover:border-[#312E81]'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1.5">
                          Registered Mobile Number
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={countryCode}
                            onChange={(e) => setCountryCode(e.target.value)}
                            className="w-20 px-3 py-3 rounded-xl border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm text-[#0F172A] focus:outline-none focus:border-[#312E81]"
                            aria-label="Country dial code"
                          />
                          <div className="relative flex-1">
                            <Phone className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2" />
                            <input
                              type="tel"
                              required
                              value={mobileInput}
                              onChange={(e) => setMobileInput(e.target.value)}
                              placeholder="9876543210"
                              className="w-full pl-10 pr-3.5 py-3 rounded-xl border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm text-[#0F172A] focus:outline-none focus:border-[#312E81]"
                            />
                          </div>
                        </div>
                      </div>

                      <button
                        type="submit"
                        disabled={busy}
                        className="w-full py-3 min-h-[44px] rounded-xl bg-[#312E81] text-white text-sm font-semibold hover:bg-[#4338CA] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                      >
                        {busy ? 'Sending SMS OTP...' : 'Send SMS OTP'}
                        <ArrowRight className="w-4 h-4" />
                      </button>

                      {(otpProvider === 'twilio' || otpProvider === 'twilio_verify' || otpChannel === 'server') && (
                        <button
                          type="button"
                          onClick={() => setShowCallerIdHelp((prev) => !prev)}
                          className="text-xs font-medium text-[#312E81] hover:underline cursor-pointer"
                        >
                          {showCallerIdHelp ? 'Hide Caller ID Help' : 'Can’t add Twilio Caller ID?'}
                        </button>
                      )}

                      {(showCallerIdHelp || isTwilioCallerIdOrGeoError(errorMsg)) && (
                        <CallerIdHelperPanel
                          phoneInput={mobileInput}
                          countryCode={countryCode}
                          onSwitchToFirebase={() => {
                            setOtpChannel('firebase');
                            setErrorMsg('');
                            setShowCallerIdHelp(false);
                            setInfoMsg('Switched to Firebase Phone OTP. Click Send SMS OTP above.');
                          }}
                          onCallerIdVerified={() => setErrorMsg('')}
                        />
                      )}
                    </form>
                  ) : (
                    <form onSubmit={handleVerifyOtp} className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1.5">
                          Enter SMS OTP Code
                        </label>
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
                            placeholder="Enter OTP"
                            className="w-full pl-10 pr-3.5 py-3 rounded-xl border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-base tracking-[0.3em] text-[#0F172A] focus:outline-none focus:border-[#312E81]"
                          />
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmation(null);
                            setServerOtp(null);
                            setOtpCode('');
                            setInfoMsg('');
                          }}
                          className="px-4 py-3 min-h-[44px] rounded-xl border border-[#E7E5E0] text-xs font-semibold text-[#475569] hover:text-[#0F172A] cursor-pointer"
                        >
                          Change Number
                        </button>
                        <button
                          type="submit"
                          disabled={busy}
                          className="flex-1 py-3 min-h-[44px] rounded-xl bg-[#059669] text-white text-sm font-semibold hover:bg-[#047857] transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {busy ? 'Verifying...' : 'Verify OTP'}
                        </button>
                      </div>

                      {serverOtp && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={handleResendServerOtp}
                          className="text-xs font-medium text-[#312E81] hover:underline cursor-pointer disabled:opacity-50"
                        >
                          Resend OTP code
                        </button>
                      )}
                    </form>
                  )
                ) : (
                  <div className="space-y-4">
                    <p className="text-xs text-[#475569] leading-relaxed">
                      Sign in instantly with Google to register a new Institution, or access a Teacher/Student profile linked with your email or mobile.
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleGoogleSignIn}
                      className="w-full py-3 min-h-[44px] rounded-xl border border-[#E7E5E0] bg-white hover:border-[#312E81] text-sm font-semibold text-[#0F172A] transition-colors flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-4 h-4 text-[#312E81]" />
                      {busy ? 'Connecting...' : 'Continue with Google'}
                    </button>
                  </div>
                )}
              </div>

              <div className="pt-6 mt-6 border-t border-[#E7E5E0] space-y-2">
                <p className="text-xs text-[#64748B] leading-relaxed">
                  Registered teachers and students verify via Mobile SMS OTP; Institution Admins can also sign in directly with Google.
                </p>
                {authTab === 'phone' && !verifiedPhone && (
                  <button
                    type="button"
                    onClick={handleGoogleSignIn}
                    disabled={busy}
                    className="text-xs font-semibold text-[#312E81] hover:underline cursor-pointer"
                  >
                    Or continue with Google Sign-In →
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Role & Architecture Strip */}
        <section id="roles" className="mt-14 pt-10 border-t border-[#E7E5E0] grid grid-cols-1 md:grid-cols-3 gap-6">
          <div id="workflow" className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-2.5">
            <ShieldCheck className="w-5 h-5 text-[#312E81]" />
            <h3 className="text-base font-bold text-[#0F172A]">1. Institution Admin First</h3>
            <p className="text-sm text-[#475569] leading-relaxed">
              Add institution and admin photos, define subjects, assign teachers to specific subjects, and track growth across every class.
            </p>
          </div>
          <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-2.5">
            <BookOpen className="w-5 h-5 text-[#312E81]" />
            <h3 className="text-base font-bold text-[#0F172A]">2. Subject-Scoped Teachers</h3>
            <p className="text-sm text-[#475569] leading-relaxed">
              Teachers access only their assigned subjects, upload topic reference pictures, and author study materials, assignments, and Pre/Post quizzes manually or with Gemini AI.
            </p>
          </div>
          <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-2.5">
            <TrendingUp className="w-5 h-5 text-[#059669]" />
            <h3 className="text-base font-bold text-[#0F172A]">3. Student IDs & Growth Proof</h3>
            <p className="text-sm text-[#475569] leading-relaxed">
              Students receive unique IDs linked to their mobile numbers, take Pre-Tests, study materials, submit written or file assignments, and see Post-Test growth deltas.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
};
