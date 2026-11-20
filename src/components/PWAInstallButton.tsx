import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC<{ variant?: 'header' | 'inline' }> = ({
  variant = 'header',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[40px] rounded-lg border border-[#312E81]/25 bg-[#EEF2FF] text-[#312E81] text-xs font-semibold hover:bg-[#E0E7FF] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        <Download className="w-4 h-4 shrink-0" />
        Install Android App
      </button>
    );
  }

  if (isIOS || variant === 'inline') {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowGuide(true)}
          className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[40px] rounded-lg border border-[#E7E5E0] bg-white text-[#334155] text-xs font-medium hover:border-[#312E81]/40 hover:text-[#312E81] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Smartphone className="w-4 h-4 shrink-0" />
          Install App
        </button>

        {showGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white border border-[#E7E5E0] p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-[#0F172A]">Install Sikshalite App</h3>
                <button
                  type="button"
                  onClick={() => setShowGuide(false)}
                  className="p-2 rounded-lg text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                  aria-label="Close install instructions"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {isIOS ? (
                <p className="text-sm text-[#475569] leading-relaxed">
                  1. Tap the <strong>Share</strong> icon in your Safari toolbar.
                  <br />
                  2. Scroll down and tap <strong>Add to Home Screen</strong>.
                </p>
              ) : (
                <p className="text-sm text-[#475569] leading-relaxed">
                  Open this page in Chrome on Android and tap <strong>Add to Home screen</strong> or{' '}
                  <strong>Install app</strong> from the browser menu to run Sikshalite as a standalone app.
                </p>
              )}
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="mt-5 w-full py-2.5 rounded-lg bg-[#312E81] text-white text-sm font-medium hover:bg-[#4338CA] transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
