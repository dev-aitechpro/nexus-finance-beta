// src/views/Scanner.tsx
import {
  AlertTriangle, Camera, FileText, ImagePlus, LoaderCircle, Plus, ShieldCheck,
} from "lucide-react";
import { createWorker } from "tesseract.js";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useApp } from "../hooks/AppProvider";
import { Field, PageHeader, ProgressBar, useFilePick } from "../components/ui";
import { CameraScanner } from "../components/CameraScanner";
import { CategoryPicker } from "../components/CategoryPicker";
import { formatNumber, parseAmount, todayISO } from "../lib/utils";

type Phase = "idle" | "working" | "done" | "error";

const STATUS_RU: Record<string, string> = {
  "loading tesseract core": "Загрузка OCR-ядра…",
  "initializing tesseract": "Инициализация Tesseract…",
  "initialized tesseract": "Tesseract готов",
  "loading language traineddata": "Загрузка языковых моделей (rus + eng)…",
  "loading language traineddata (from cache)": "Языковые модели из кэша",
  "initialized api": "Движок готов",
  "recognizing text": "Распознавание текста…",
};

// 🔥 Предобработка изображения (усиление контраста)
function preprocessImage(imageSource: string | File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject('Canvas not supported');

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      const contrast = 1.4;
      const brightness = 8;
      
      for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.min(255, Math.max(0, (data[i] - 128) * contrast + 128 + brightness));
        data[i+1] = Math.min(255, Math.max(0, (data[i+1] - 128) * contrast + 128 + brightness));
        data[i+2] = Math.min(255, Math.max(0, (data[i+2] - 128) * contrast + 128 + brightness));
      }
      
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };
    
    img.onerror = () => reject('Image load failed');
    
    if (typeof imageSource === 'string') {
      img.src = imageSource;
    } else {
      const reader = new FileReader();
      reader.onload = (e) => { img.src = e.target?.result as string; };
      reader.readAsDataURL(imageSource);
    }
  });
}

// 🔥 Просто извлекаем все суммы из текста (от 1 до 1 млн)
function extractAllAmounts(text: string): number[] {
  const matches = text.match(/\b(\d{1,3}(?:[\s\u00A0]\d{3})*(?:[.,]\d{2})?)\b/g);
  if (!matches) return [];
  
  return matches
    .map(m => parseAmount(m))
    .filter(n => n >= 1 && n <= 1000000);
}

export function Scanner() {
  const { addTransaction, notify, data } = useApp();
  const currency = data.currency;

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("groceries");
  const [date, setDate] = useState(todayISO());
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const [foundAmounts, setFoundAmounts] = useState<number[]>([]);

  const busyRef = useRef(false);

  const handleScan = useCallback((data: { amount: number; description: string; date?: string }) => {
    setAmount(String(data.amount));
    setDescription(data.description);
    if (data.date) {
      setDate(data.date);
    }
    setPhase("done");
    notify(`✅ Распознано: ${formatNumber(data.amount, currency)}`);
  }, [currency, notify]);

  const run = useCallback(async (file: File) => {
    if (busyRef.current) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      notify("Поддерживаются только JPG, PNG и WEBP", "error");
      return;
    }
    busyRef.current = true;
    setPhase("working");
    setProgress(0);
    setStatusText("Подготовка изображения…");
    setRawText("");
    setShowRaw(false);
    setError("");
    setFoundAmounts([]);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(URL.createObjectURL(file));

    try {
      const processedDataUrl = await preprocessImage(file);
      setImageUrl(processedDataUrl);

      const worker = await createWorker(["rus", "eng"], 1, {
        logger: (m) => {
          if (m.status === "recognizing text") {
            setProgress(m.progress);
            setStatusText(`Распознавание текста… ${Math.round(m.progress * 100)}%`);
          } else {
            setStatusText(STATUS_RU[m.status] ?? m.status);
          }
        },
      });
      const { data: result } = await worker.recognize(processedDataUrl);
      await worker.terminate();

      setRawText(result.text);
      
      // 🔥 Только суммы, никаких категорий
      const amounts = extractAllAmounts(result.text);
      setFoundAmounts(amounts);
      
      if (amounts.length > 0) {
        notify(`✅ Найдено ${amounts.length} сумм. Кликните на нужную.`);
      } else {
        notify("⚠️ Суммы не найдены, введите вручную", "info");
      }

      setPhase("done");
    } catch (e) {
      console.error(e);
      setPhase("error");
      notify("Распознавание не удалось. Проверьте интернет и попробуйте ещё раз.", "error");
    } finally {
      busyRef.current = false;
    }
  }, [currency, imageUrl, notify]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void run(f);
  };

  const { input, pick } = useFilePick((f) => void run(f));

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (f) void run(f);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [run]);

  const reset = () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(null);
    setPhase("idle");
    setProgress(0);
    setRawText("");
    setAmount("");
    setDescription("");
    setError("");
    setFoundAmounts([]);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    if (n <= 0) { setError("Сумма должна быть больше нуля"); return; }
    if (!date) { setError("Укажите дату"); return; }
    addTransaction({
      type: "expense", category, amount: n,
      description: description.trim() || null,
      date, source: "manual",
    });
    reset();
  };

  return (
    <div className="space-y-5">
      <PageHeader
        kicker="OCR · Tesseract.js"
        title="Сканер чеков"
        actions={
          <button className="btn btn-primary" onClick={() => setCameraOpen(true)}>
            <Camera size={15} /> Камера
          </button>
        }
      />

      <div className="grid lg:grid-cols-2 gap-5">
        <section className="card cut p-5 rise-in" aria-label="Загрузка чека">
          <header className="card-head">
            <h2 className="card-title">Изображение чека</h2>
            <span className="card-sub">JPG · PNG · WEBP</span>
          </header>

          {!imageUrl && (
            <button
              className={`dropzone ${dragOver ? "dropzone-active" : ""}`}
              onClick={pick}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              aria-label="Загрузить изображение чека"
            >
              <span className="hex flex items-center justify-center" style={{ width: 62, height: 62, color: "var(--accent)" }}>
                <ImagePlus size={26} strokeWidth={1.5} />
              </span>
              <span className="font-display text-sm uppercase tracking-[0.12em] mt-4" style={{ color: "var(--text)" }}>
                Перетащите чек сюда
              </span>
              <span className="text-sm mt-1.5" style={{ color: "var(--muted)" }}>
                или нажмите, чтобы выбрать файл — также работает вставка из буфера (Ctrl+V)
              </span>
            </button>
          )}

          {imageUrl && (
            <div className="scan-frame relative mt-1">
              <img src={imageUrl} alt="Скан чека" className="scan-img" />
              {phase === "working" && (
                <>
                  <div className="scan-line" aria-hidden />
                  <div className="scan-veil" aria-hidden />
                </>
              )}
            </div>
          )}

          {phase === "working" && (
            <div className="mt-4">
              <div className="flex items-center gap-2 text-sm mb-2" style={{ color: "var(--text)" }}>
                <LoaderCircle size={15} className="spin" style={{ color: "var(--accent)" }} />
                {statusText}
              </div>
              <ProgressBar pct={progress * 100} color="var(--accent)" height={7} />
            </div>
          )}

          {phase === "error" && (
            <div className="mt-4 flex items-start gap-2.5 text-sm p-3" style={{ color: "var(--danger)", border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)", background: "color-mix(in srgb, var(--danger) 8%, transparent)" }}>
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              Распознавание не удалось. Модули Tesseract загружаются из интернета — проверьте соединение и повторите попытку.
            </div>
          )}

          {phase === "done" && rawText && (
            <div className="mt-4">
              <button className="card-link" onClick={() => setShowRaw((v) => !v)}>
                <FileText size={13} className="inline" /> {showRaw ? "Скрыть" : "Показать"} распознанный текст
              </button>
              {showRaw && (
                <pre className="raw-text mono mt-2">{rawText}</pre>
              )}
            </div>
          )}
        </section>

        <section className="card cut p-5 rise-in" style={{ animationDelay: "90ms" }} aria-label="Результат распознавания">
          <header className="card-head">
            <h2 className="card-title">Новая транзакция из чека</h2>
            <span className="card-sub">Кликните по сумме в списке → она вставится в поле</span>
          </header>

          {phase !== "done" ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <ShieldCheck size={34} strokeWidth={1.3} style={{ color: "var(--muted)" }} />
              <p className="text-sm mt-4 max-w-xs" style={{ color: "var(--muted)" }}>
                Распознанные сумма и описание появятся здесь. Изображение обрабатывается локально в приложении и никуда не отправляется.
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              
              {/* 🔥 Список найденных сумм */}
              {foundAmounts.length > 0 && (
                <div className="mb-3">
                  <span className="field-label">Найденные суммы (кликните для вставки):</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {foundAmounts.map((val, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="chip hover:bg-[var(--accent)] hover:text-[var(--on-accent)] transition-colors"
                        onClick={() => {
                          setAmount(String(val));
                          notify(`✅ Вставлена сумма: ${formatNumber(val, currency)}`);
                        }}
                      >
                        {formatNumber(val, currency)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              <Field label="Сумма" error={error && error.includes("Сумма") ? error : undefined}>
                <input className="input mono" inputMode="decimal" placeholder="0" value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d\s.,]/g, ""))} />
              </Field>
              <Field label="Описание (магазин)">
                <input className="input" placeholder="Например: Пятёрочка" value={description} maxLength={80}
                  onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Категория">
                  <CategoryPicker value={category} onChange={setCategory} type="expense" compact />
                </Field>
                <Field label="Дата" error={error && error.includes("дату") ? error : undefined}>
                  <input className="input" type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
                </Field>
              </div>
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" className="btn btn-ghost" onClick={reset}>Очистить</button>
                <button type="submit" className="btn btn-primary"><Plus size={15} /> Создать транзакцию</button>
              </div>
            </form>
          )}
        </section>
      </div>

      <CameraScanner
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onScan={handleScan}
      />

      {input}
    </div>
  );
}