import React from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';

export interface GrowthBarItem {
  label: string;
  prePercent: number;
  postPercent: number;
  delta: number;
}

export const PrePostComparisonChart: React.FC<{ items: GrowthBarItem[]; emptyMessage?: string }> = ({
  items,
  emptyMessage = 'Complete Pre-Tests and Post-Tests to visualize learning growth.',
}) => {
  if (items.length === 0) {
    return (
      <div className="py-10 px-4 text-center border border-dashed border-[#E7E5E0] rounded-xl bg-[#FAF9F6]">
        <p className="text-sm text-[#64748B]">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-[#64748B]">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#CBD5E1] inline-block" />
            Pre-Test Baseline
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#312E81] inline-block" />
            Post-Test Mastery
          </span>
        </div>
        <span className="font-mono tabular-nums">Scale 0–100%</span>
      </div>

      <div className="space-y-3.5">
        {items.map((item, idx) => {
          const isPositive = item.delta >= 0;
          return (
            <div key={`${item.label}-${idx}`} className="space-y-1.5">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="font-medium text-[#0F172A] truncate">{item.label}</span>
                <div className="flex items-center gap-3 shrink-0 font-mono text-xs tabular-nums">
                  <span className="text-[#64748B]">
                    {item.prePercent}% → {item.postPercent}%
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 font-semibold ${
                      isPositive ? 'text-[#059669]' : 'text-[#DC2626]'
                    }`}
                  >
                    {isPositive ? (
                      <TrendingUp className="w-3.5 h-3.5" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5" />
                    )}
                    {isPositive ? `+${item.delta}%` : `${item.delta}%`}
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="w-full h-2 bg-[#F1F0EA] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#CBD5E1] rounded-full transition-all duration-300"
                    style={{ width: `${Math.max(2, Math.min(100, item.prePercent))}%` }}
                  />
                </div>
                <div className="w-full h-2 bg-[#F1F0EA] rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      isPositive ? 'bg-[#312E81]' : 'bg-[#D97706]'
                    }`}
                    style={{ width: `${Math.max(2, Math.min(100, item.postPercent))}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const GrowthRing: React.FC<{ percent: number; label: string; sublabel?: string }> = ({
  percent,
  label,
  sublabel,
}) => {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div className="flex items-center gap-3.5">
      <div className="relative w-20 h-20 shrink-0">
        <svg viewBox="0 0 76 76" className="w-full h-full -rotate-90">
          <circle
            cx="38"
            cy="38"
            r={radius}
            fill="none"
            stroke="#E7E5E0"
            strokeWidth="6"
          />
          <circle
            cx="38"
            cy="38"
            r={radius}
            fill="none"
            stroke="#059669"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-sm font-semibold text-[#0F172A] tabular-nums">
            {Math.round(clamped)}%
          </span>
        </div>
      </div>
      <div>
        <div className="text-sm font-semibold text-[#0F172A]">{label}</div>
        {sublabel && <div className="text-xs text-[#64748B] mt-0.5">{sublabel}</div>}
      </div>
    </div>
  );
};
