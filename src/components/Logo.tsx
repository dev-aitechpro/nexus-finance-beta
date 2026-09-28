// src/components/Logo.tsx
import { cn } from "../utils/cn";

interface LogoProps {
  className?: string;
  showText?: boolean;
}

export function Logo({ className, showText = true }: LogoProps) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      {/* Кодовый логотип (hex + доллар) */}
      <div className="relative flex items-center justify-center w-10 h-10 shrink-0">
        {/* Внешний шестиугольник */}
        <div className="absolute inset-0 bg-gradient-to-br from-blue-600/30 to-blue-900/10 border-2 border-blue-500/60 clip-hex shadow-[0_0_20px_rgba(59,130,246,0.3)]" />
        
        {/* Внутренний круг-мишень */}
        <div className="absolute w-7 h-7 rounded-full border-[1.5px] border-blue-400/50" />
        <div className="absolute w-4 h-4 rounded-full border-[1.5px] border-blue-400/50" />
        
        {/* Угловые скобы (прицел) */}
        <div className="absolute top-1 left-1 w-2.5 h-2.5 border-t-[2px] border-l-[2px] border-blue-500" />
        <div className="absolute top-1 right-1 w-2.5 h-2.5 border-t-[2px] border-r-[2px] border-blue-500" />
        <div className="absolute bottom-1 left-1 w-2.5 h-2.5 border-b-[2px] border-l-[2px] border-blue-500" />
        <div className="absolute bottom-1 right-1 w-2.5 h-2.5 border-b-[2px] border-r-[2px] border-blue-500" />
        
        {/* Символ доллара */}
        <span className="font-bold text-blue-400 text-lg relative z-10 font-mono">$</span>
      </div>

      {/* Текстовая часть */}
      {showText && (
        <div className="flex flex-col leading-none">
          <span className="font-display font-extrabold text-[15px] tracking-[0.22em] text-[var(--text)]">
            NEXUS
          </span>
          <span className="block text-[9px] tracking-[0.34em] mt-1 uppercase text-[var(--accent)]">
            finance os
          </span>
        </div>
      )}
    </div>
  );
}