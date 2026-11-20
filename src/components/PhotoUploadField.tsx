import React, { useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Trash2 } from 'lucide-react';
import { compressImageFile } from '../lib/imageUtils';

interface PhotoUploadFieldProps {
  label: string;
  value: string;
  onChange: (dataUrl: string) => void;
  shape?: 'circle' | 'banner';
  placeholderTitle?: string;
}

export const PhotoUploadField: React.FC<PhotoUploadFieldProps> = ({
  label,
  value,
  onChange,
  shape = 'circle',
  placeholderTitle = 'Upload photo',
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const compressed = await compressImageFile(file, shape === 'banner' ? 960 : 512, 210000);
      onChange(compressed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to process image.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div>
      <span className="block text-xs font-medium text-[#475569] mb-2">{label}</span>
      <div className="flex items-center gap-4">
        {shape === 'circle' ? (
          <div className="w-16 h-16 rounded-full border border-[#E7E5E0] bg-[#F4F2EC] overflow-hidden flex items-center justify-center shrink-0">
            {value ? (
              <img
                src={value}
                alt={label}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            ) : (
              <Camera className="w-6 h-6 text-[#94A3B8]" />
            )}
          </div>
        ) : (
          <div className="w-32 h-20 rounded-xl border border-[#E7E5E0] bg-[#F4F2EC] overflow-hidden flex items-center justify-center shrink-0">
            {value ? (
              <img
                src={value}
                alt={label}
                referrerPolicy="no-referrer"
                className="w-full h-full object-contain bg-[#FAF9F6] p-1"
              />
            ) : (
              <div className="flex flex-col items-center gap-1 text-[#94A3B8]">
                <ImageIcon className="w-5 h-5" />
                <span className="text-[11px]">{placeholderTitle}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            onChange={handleFile}
            className="hidden"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="px-3.5 py-2 min-h-[40px] rounded-lg border border-[#E7E5E0] bg-white text-xs font-medium text-[#0F172A] hover:border-[#312E81]/40 hover:text-[#312E81] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {busy ? 'Compressing...' : value ? 'Replace Photo' : 'Add Photo'}
          </button>
          {value && (
            <button
              type="button"
              onClick={() => onChange('')}
              className="p-2 min-h-[40px] min-w-[40px] rounded-lg border border-[#E7E5E0] bg-white text-[#64748B] hover:text-[#DC2626] transition-colors flex items-center justify-center cursor-pointer"
              aria-label={`Remove ${label}`}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-1.5 text-xs text-[#DC2626]">{error}</p>}
    </div>
  );
};
