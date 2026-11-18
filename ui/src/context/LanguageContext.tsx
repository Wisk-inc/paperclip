import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  APP_LANGUAGE_AUTO,
  DEFAULT_APP_LANGUAGE,
  appLanguage,
  detectAppLanguage,
  effectiveAppLanguage,
  formattingLocale,
  isAppLanguagePreference,
  updateLanguagePreferenceSchema,
  type AppLanguageCode,
  type AppLanguagePreference,
  type DetectedLanguage,
  type LanguagePreference,
  type UpdateLanguagePreference,
} from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { languagePreferencesApi } from "@/api/languagePreferences";
import { uiTranslationsApi } from "@/api/uiTranslations";
import { i18n } from "@/i18n";
import { loadBuiltinTranslations } from "@/i18n/builtin-translations";
import { setFormatLocale } from "@/i18n/format-locale";
import { LiveTranslator } from "@/i18n/live-translator";
import { loadUiStringIndex } from "@/i18n/ui-string-index";
import { UiTranslationStore } from "@/i18n/ui-translation-store";
import { automaNative } from "@/lib/automa-native";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The language Automa's screens are in: Auto (what this phone or browser asks
 * for, with the country from its time zone) or one the person chose. The
 * choice is kept on this device, so the board opens in it at once, and saved
 * to the person's account, so it follows them to their other devices and
 * agents write to them in it (see server/src/services/language-preferences.ts).
 */

export const LANGUAGE_STORAGE_KEY = "automa:language";
/** Set while a choice made on this device has not reached the account yet. */
export const LANGUAGE_UNSYNCED_KEY = "automa:language:unsynced";

export interface LanguageContextValue {
  /** What the person chose: "auto", or a language. */
  preference: AppLanguagePreference;
  /** The language the screens are in. */
  language: AppLanguageCode;
  /** What Auto finds on this device: language, locale, country, time zone. */
  detected: DetectedLanguage;
  setPreference: (next: AppLanguagePreference) => void;
  /** The choice is on this device but has not reached the account yet (signed out, or offline). */
  unsynced: boolean;
  /** Screens without built-in translations get AI ones (signed in, not English). */
  aiTranslation: boolean;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStored(key: string): string | null {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    const storage = browserStorage();
    if (!storage) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Private mode or a full device: the account still has the choice.
  }
}

export function readStoredLanguagePreference(): AppLanguagePreference {
  const stored = readStored(LANGUAGE_STORAGE_KEY);
  return isAppLanguagePreference(stored) ? stored : APP_LANGUAGE_AUTO;
}

/** What this device says: its languages in order of preference, and its time zone. */
export function detectDeviceLanguage(): DetectedLanguage {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const languages = nav?.languages?.length ? [...nav.languages] : nav?.language ? [nav.language] : [];
  let timeZone: string | null = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    timeZone = null;
  }
  return detectAppLanguage(languages, timeZone);
}

const REPORT_FIELDS = ["detectedLanguage", "detectedLocale", "country", "timeZone"] as const;

/** The detection as the account keeps it; a value the server would refuse is left out. */
export function deviceReport(detected: DetectedLanguage): UpdateLanguagePreference {
  const shape = updateLanguagePreferenceSchema.shape;
  const report: UpdateLanguagePreference = { detectedLanguage: detected.language };
  if (shape.detectedLocale.safeParse(detected.locale).success) report.detectedLocale = detected.locale;
  if (shape.country.safeParse(detected.country).success) report.country = detected.country;
  if (shape.timeZone.safeParse(detected.timeZone).success) report.timeZone = detected.timeZone;
  return report;
}

/** Whether the account's copy of the detection is not this device's. */
export function reportDiffers(saved: LanguagePreference, report: UpdateLanguagePreference): boolean {
  return REPORT_FIELDS.some((field) => field in report && (report[field] ?? null) !== (saved[field] ?? null));
}

/** The page's language, writing direction, date and number format, and the app's own screens. */
export function applyLanguage(language: AppLanguageCode, detected: DetectedLanguage): void {
  setFormatLocale(formattingLocale(language, detected));
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.lang = language;
    root.dir = appLanguage(language).rtl ? "rtl" : "ltr";
  }
  if (i18n.language !== language) void i18n.changeLanguage(language);
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [detected, setDetected] = useState<DetectedLanguage>(() => detectDeviceLanguage());
  const [preference, setPreferenceState] = useState<AppLanguagePreference>(() => readStoredLanguagePreference());
  // Chosen here and not yet on the account; shown when it can't get there (signed out, or the save failed).
  const [unsynced, setUnsynced] = useState(() => readStored(LANGUAGE_UNSYNCED_KEY) === "1");
  const [syncFailed, setSyncFailed] = useState(false);
  const language = effectiveAppLanguage(preference, detected);

  // The first render already formats dates and numbers in the person's language.
  useState(() => {
    applyLanguage(language, detected);
    return null;
  });
  useLayoutEffect(() => {
    applyLanguage(language, detected);
  }, [language, detected]);

  // The Automa app keeps the choice for its connect screen and, on Android 13+,
  // its own screens; Auto there follows the phone.
  useEffect(() => {
    automaNative.setLanguage(preference);
  }, [preference]);

  // The phone's language changed while Automa was open.
  useEffect(() => {
    const onChange = () => setDetected(detectDeviceLanguage());
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, []);

  // Read only: the sign-in gate and the sidebar ask for the session.
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), enabled: false });
  const userId = session.data?.user?.id ?? null;

  const remote = useQuery({
    queryKey: queryKeys.languagePreferences.mine(userId ?? ""),
    queryFn: () => languagePreferencesApi.get(),
    enabled: !!userId,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const preferenceRef = useRef(preference);
  preferenceRef.current = preference;
  const detectedRef = useRef(detected);
  detectedRef.current = detected;
  const pushes = useRef(0);

  /** Saves to the account; only the latest save's answer is kept (taps can overtake each other). */
  const push = useCallback(
    async (patch: UpdateLanguagePreference) => {
      if (!userId) return;
      const turn = ++pushes.current;
      try {
        const saved = await languagePreferencesApi.update(patch);
        if (turn !== pushes.current) return;
        if (patch.language !== undefined && patch.language === preferenceRef.current) {
          writeStored(LANGUAGE_UNSYNCED_KEY, null);
          setUnsynced(false);
          setSyncFailed(false);
        }
        client.setQueryData(queryKeys.languagePreferences.mine(userId), saved);
      } catch {
        // Kept on this device; it goes to the account the next time Automa reaches it.
        if (patch.language !== undefined && turn === pushes.current) setSyncFailed(true);
      }
    },
    [client, userId],
  );

  const handled = useRef<LanguagePreference | null>(null);
  useEffect(() => {
    const saved = remote.data;
    if (!saved || !userId || handled.current === saved) return;
    handled.current = saved;
    const report = deviceReport(detectedRef.current);
    if (readStored(LANGUAGE_UNSYNCED_KEY) === "1") {
      // Chosen here before it could reach the account: the account takes it now.
      void push({ language: preferenceRef.current, ...report });
      return;
    }
    if (saved.language !== preferenceRef.current) {
      // Chosen on another device: this one follows.
      setPreferenceState(saved.language);
      writeStored(LANGUAGE_STORAGE_KEY, saved.language);
    }
    if (reportDiffers(saved, report)) void push(report);
  }, [remote.data, userId, push]);

  // This device's detection changed (another language, travel): the account learns it.
  useEffect(() => {
    const saved = remote.data;
    if (!saved || !userId) return;
    const report = deviceReport(detected);
    if (reportDiffers(saved, report)) void push(report);
    // remote.data is read, not followed: the effect above handles each answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected, userId, push]);

  const setPreference = useCallback(
    (next: AppLanguagePreference) => {
      setPreferenceState(next);
      preferenceRef.current = next;
      writeStored(LANGUAGE_STORAGE_KEY, next);
      writeStored(LANGUAGE_UNSYNCED_KEY, "1");
      setUnsynced(true);
      void push({ language: next, ...deviceReport(detectedRef.current) });
    },
    [push],
  );

  // Every screen in the language: built-in translations, then saved AI ones, then new ones as screens show them.
  const [store, setStore] = useState<UiTranslationStore | null>(null);
  useEffect(() => {
    if (language === DEFAULT_APP_LANGUAGE) {
      setStore(null);
      return;
    }
    const next = new UiTranslationStore(language, {
      builtin: loadBuiltinTranslations,
      fetchAll: async (code) => (await uiTranslationsApi.all(code)).translations,
      translate: (code, strings) => uiTranslationsApi.translate(code, strings),
      storage: browserStorage(),
    });
    setStore(next);
    let translator: LiveTranslator | null = null;
    let frame: number | null = null;
    let cancelled = false;
    const off = next.onChange(() => {
      if (!translator || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        translator?.refresh();
      });
    });
    void Promise.all([loadUiStringIndex(), next.load()])
      .then(([index]) => {
        if (cancelled) return;
        translator = new LiveTranslator({
          root: document.body,
          index,
          lookup: (source) => next.lookup(source),
          onMissing: (sources) => next.request(sources),
          isolate: appLanguage(language).rtl,
        });
        translator.start();
      })
      .catch((error: unknown) => {
        console.warn("Automa could not load the translations of its screens", error);
      });
    return () => {
      cancelled = true;
      off();
      if (frame !== null) cancelAnimationFrame(frame);
      translator?.stop();
      next.close();
    };
  }, [language]);

  useEffect(() => {
    if (store && userId) void store.connect();
  }, [store, userId]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      preference,
      language,
      detected,
      setPreference,
      unsynced: unsynced && (!userId || syncFailed),
      aiTranslation: language !== DEFAULT_APP_LANGUAGE && !!userId,
    }),
    [preference, language, detected, setPreference, unsynced, syncFailed, userId],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/**
 * The language in use and the picker's actions. Outside the provider (a
 * component rendered on its own, as in tests) it reads as Auto in English,
 * with this device's detection, and choosing changes nothing.
 */
export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (context) return context;
  const detected = detectDeviceLanguage();
  return {
    preference: APP_LANGUAGE_AUTO,
    language: DEFAULT_APP_LANGUAGE,
    detected,
    setPreference: () => undefined,
    unsynced: false,
    aiTranslation: false,
  };
}
