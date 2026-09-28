// src/components/CameraScanner.tsx
import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import jsQR from "jsqr";
import { createWorker } from "tesseract.js";
import { useOverlay } from "../hooks/useOverlayStack";
import { parseAmount } from "../lib/utils";

interface CameraScannerProps {
  onScan: (data: { amount: number; description: string; date?: string }) => void;
  onClose: () => void;
  open: boolean;
}

export function CameraScanner({ onScan, onClose, open }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [mode, setMode] = useState<"qr" | "text">("qr");
  const workerRef = useRef<any>(null);
  const scanIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      stopCamera();
      return;
    }

    startCamera();

    return () => {
      stopCamera();
    };
  }, [open]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setScanning(true);
      
      // Запускаем непрерывное сканирование кадра каждые 500мс
      if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = window.setInterval(() => {
        if (mode === "qr") captureFrame();
      }, 500);
      
    } catch (error) {
      console.error("Ошибка доступа к камере:", error);
    }
  };

  const stopCamera = () => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (videoRef.current?.srcObject) {
      const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
      tracks.forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    setScanning(false);
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  };

  /**
   * Аппаратная кнопка «Назад». Сканер — не Modal, регистрируем вручную, и
   * закрываем ровно тем же, чем крестик в шапке: сначала гасим камеру, иначе
   * индикатор записи останется включённым (эффект на `open` погасил бы его
   * позже, но между закрытием и следующим кадром камера ещё жива).
   */
  useOverlay(open, () => {
    stopCamera();
    onClose();
  });

  const captureFrame = () => {
    if (!videoRef.current || !canvasRef.current || !scanning) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx?.getImageData(0, 0, canvas.width, canvas.height);
    if (!imageData) return;

    // QR-сканирование
    if (mode === "qr") {
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code) {
        // Парсим данные из QR (сумма, описание, дата)
        const data = parseQRData(code.data);
        if (data) {
          onScan(data);
          stopCamera();
          onClose();
        }
      }
    } else {
      // Распознавание текста через Tesseract
      if (!workerRef.current) {
        setLoading(true);
        createWorker(["rus", "eng"]).then((worker) => {
          workerRef.current = worker;
          setLoading(false);
          recognizeText();
        });
        return;
      }
      recognizeText();
    }
  };

  const recognizeText = async () => {
    if (!canvasRef.current || !workerRef.current) return;

    const canvas = canvasRef.current;
    const imageData = canvas.toDataURL("image/jpeg");

    const { data } = await workerRef.current.recognize(imageData);
    const parsed = parseReceiptText(data.text);

    if (parsed) {
      onScan(parsed);
      stopCamera();
      onClose();
    }
  };

  // 🔥 Улучшенный парсинг QR-кода с чека
  const parseQRData = (data: string): { amount: number; description: string; date?: string } | null => {
    // Формат QR чека (пример: t=20240814T1430&s=1234.56&fn=1234567890&i=123456&fp=1234567890&n=1)
    // Ищем сумму (s= или сумма:)
    let amount: number | null = null;
    let description = "Чек по QR";
    let date: string | undefined = undefined;

    // Попытка распарсить как URL-параметры (формат ФНС)
    if (data.includes('&') || data.includes('t=')) {
      const params = new URLSearchParams(data);
      const s = params.get('s');
      const t = params.get('t');
      const fn = params.get('fn');
      
      if (s) {
        const parsed = parseAmount(s);
        if (parsed > 0) amount = parsed;
      }
      
      if (t && t.length >= 8) {
        // Формат t=20240814T1430
        try {
          const year = t.substring(0, 4);
          const month = t.substring(4, 6);
          const day = t.substring(6, 8);
          date = `${year}-${month}-${day}`;
        } catch {}
      }
      
      if (fn) {
        description = `Чек ФН: ${fn}`;
      }
    } else {
      // Попытка найти сумму в тексте
      const amountMatch = data.match(/(\d+[.,]\d{2})/);
      if (amountMatch) {
        amount = parseFloat(amountMatch[1].replace(",", "."));
        description = data.split("\n")[0] || "Чек по QR";
      }
    }

    if (amount) {
      return { amount, description, date };
    }
    return null;
  };

  const parseReceiptText = (text: string): { amount: number; description: string; date?: string } | null => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const amountRe = /(\d{1,3}(?:[\s\u00A0]\d{3})*(?:[.,]\d{1,2})?)/;
    const moneyRe = new RegExp(`${amountRe.source}\\s*(?:₽|руб|р\\.)?`, "i");

    let amount: number | null = null;
    const totalIdx = lines.findIndex((l) => /итог|total|к\s*оплате|сумма|sum/i.test(l));
    const pool = totalIdx >= 0 ? [...lines.slice(totalIdx), ...lines] : lines;
    for (const line of pool) {
      const m = line.match(moneyRe);
      if (m) {
        const a = parseAmount(m[1]);
        if (a > 0) { amount = a; break; }
      }
    }

    const description = lines.find((l) => l.length > 2 && !/^[\d\s.,:₽-]+$/.test(l))?.slice(0, 60) ?? null;
    if (amount) {
      return { amount, description: description || "Чек" };
    }
    return null;
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="relative w-full max-w-2xl bg-card rounded-lg overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-line">
          <h3 className="font-display text-sm tracking-[0.14em] uppercase text-text">
            {mode === "qr" ? "Сканирование QR-кода" : "Распознавание чека"}
          </h3>
          <div className="flex gap-2">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setMode(mode === "qr" ? "text" : "qr")}
            >
              {mode === "qr" ? "Текст" : "QR"}
            </button>
            <button className="btn-icon" onClick={() => { stopCamera(); onClose(); }}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="relative p-4">
          <video
            ref={videoRef}
            className="w-full aspect-video bg-black rounded-lg object-cover"
            autoPlay
            playsInline
          />
          <canvas ref={canvasRef} className="hidden" />

          {/* Визуальный сканер для QR */}
          {mode === "qr" && scanning && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div className="w-3/4 h-3/4 border-2 border-accent/50 rounded-xl animate-pulse" />
              <div className="absolute w-full h-1 bg-accent/30 top-1/2 -translate-y-1/2 shadow-[0_0_20px_rgba(0,212,255,0.3)] animate-[scan-sweep_2s_ease-in-out_infinite]" />
            </div>
          )}

          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <div className="text-center">
                <div className="spin inline-block">
                  <Camera size={32} className="text-accent" />
                </div>
                <p className="text-sm mt-2 text-white">Загрузка распознавания...</p>
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-center gap-3">
            <button
              className="btn btn-primary"
              onClick={captureFrame}
              disabled={loading || !scanning}
            >
              <Camera size={16} /> Сканировать вручную
            </button>
          </div>
        </div>

        <div className="p-4 text-xs text-muted border-t border-line text-center">
          {mode === "qr"
            ? "Наведите камеру на QR-код на чеке — сканирование происходит автоматически"
            : "Наведите камеру на текст чека"}
        </div>
      </div>
    </div>
  );
}