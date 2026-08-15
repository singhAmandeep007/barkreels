import React, { useCallback, useState } from 'react';
import { PawPrint, Upload, Image as ImageIcon } from 'lucide-react';

interface DropZoneProps {
  /** Receives every accepted image. Index 0 is treated as the hero shot. */
  onImageSelect: (files: File[]) => void;
  currentImage: string | null;
}

/** Guard against someone dropping a 200-photo camera roll. */
const MAX_IMAGES = 6;

function acceptImages(list: FileList | null): File[] {
  if (!list) return [];
  return Array.from(list)
    .filter((f) => f.type.startsWith('image/'))
    .slice(0, MAX_IMAGES);
}

export function DropZone({ onImageSelect, currentImage }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragging(true);
    } else if (e.type === 'dragleave') {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = acceptImages(e.dataTransfer.files);
      if (files.length > 0) onImageSelect(files);
    },
    [onImageSelect]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    const files = acceptImages(e.target.files);
    if (files.length > 0) onImageSelect(files);
  };

  return (
    <div className="w-full max-w-2xl mx-auto animate-slide-up">
      <div
        className={`relative group rounded-3xl border-2 transition-all duration-500 overflow-hidden glass-card ${
          isDragging
            ? 'border-amber-500 bg-amber-500/10 scale-[0.99]'
            : currentImage
              ? 'border-gray-800 bg-gray-950/20'
              : 'border-dashed border-gray-800 hover:border-gray-700 hover:bg-gray-900/30'
        }`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <input
          type="file"
          accept="image/jpeg, image/png, image/webp"
          multiple
          onChange={handleChange}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20"
        />

        {currentImage ? (
          <div className="relative aspect-[4/5] w-full max-h-[50vh] flex items-center justify-center p-6">
            {/* Ambient Background Glow matching the dog's picture */}
            <div 
              className="absolute inset-0 opacity-40 blur-[40px] scale-90 pointer-events-none transition-transform duration-500 group-hover:scale-95"
              style={{ 
                backgroundImage: `url(${currentImage})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center'
              }}
            />
            
            {/* The actual image container formatted beautifully */}
            <div className="relative z-10 w-full h-full rounded-2xl overflow-hidden border border-white/10 shadow-2xl bg-gray-950/50">
              <img
                src={currentImage}
                alt="Uploaded dog"
                className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-[1.02]"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-gray-950 via-transparent to-transparent opacity-60 pointer-events-none" />
            </div>

            {/* Float Action Overlay */}
            <div className="absolute bottom-10 left-0 right-0 flex justify-center z-30 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              <span className="flex items-center gap-2 bg-black/60 backdrop-blur-md border border-white/10 px-5 py-2.5 rounded-full text-white font-medium shadow-2xl hover:bg-black/80 transition-colors">
                <ImageIcon className="h-4 w-4 text-amber-500" />
                Change Photo
              </span>
            </div>
            
            {/* Glow border ring */}
            <div className="absolute inset-0 rounded-3xl border border-white/5 pointer-events-none z-10 group-hover:border-amber-500/30 transition-colors duration-500" />
          </div>
        ) : (
          <div className="relative flex flex-col items-center justify-center py-24 px-6 text-center overflow-hidden grid-bg">
            {/* Ambient decoration */}
            <div className="absolute -top-12 -left-12 w-24 h-24 bg-amber-500/10 rounded-full blur-2xl pointer-events-none" />
            <div className="absolute -bottom-12 -right-12 w-24 h-24 bg-rose-500/10 rounded-full blur-2xl pointer-events-none" />

            <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-amber-500/10 to-rose-500/10 border border-amber-500/20 flex items-center justify-center mb-6 group-hover:scale-110 group-hover:border-amber-500/40 transition-all duration-300 shadow-xl">
              <PawPrint className="h-10 w-10 text-amber-500" />
            </div>
            
            <h3 className="text-2xl font-black text-white mb-2 leading-tight">
              Upload your dog's portrait
            </h3>
            <p className="text-gray-400 mb-8 max-w-sm text-sm leading-relaxed">
              Drag and drop here, or click to browse. JPG, PNG and WebP. Add a few
              different angles if you have them.
            </p>
            
            <button className="flex items-center gap-2 text-white font-bold bg-gradient-to-r from-amber-500 to-rose-500 px-6 py-3 rounded-xl hover:scale-105 active:scale-95 transition-all duration-300 shadow-lg shadow-orange-500/20 pointer-events-none">
              <Upload className="h-4 w-4" />
              Select Photo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
