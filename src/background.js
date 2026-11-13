
// @ts-check
/// <reference types="chrome"/>

// טעינת מערכת הלוגים של התוסף בתוך Service Worker
// @ts-ignore - הפונקציה importScripts זמינה בסביבת Service Worker
importScripts("logger.js");

// קבלת מנהל הלוגים והפעלת שמירת הלוגים בין הפעלות של Service Worker
const bgLogger = /** @type {any} */ (globalThis).LibbyLogger;
if (bgLogger) {
  bgLogger.install("background", { persist: true });
  bgLogger.restorePersisted();
}

// מצב העבודה המרכזי של התוסף
/** @type {{
  isDownloading: boolean,
  bookTitle: string,
  kebabTitle: string,
  downloadedUrls: Set<string>,
  pendingUrls: Set<string>,
  fileCount: number,
  tabId: number|null,
  currentPercent: number,
  expectedDuration: string,
  nextRuleId: number,
  spineData: Array<any>,
  spineByPartId: Record<string, any>,
  spineWithTimes: Array<any>,
  missingFiles: Array<any>,
  isFillingGaps: boolean,
  scrubbingComplete: boolean,
  gapFillComplete: boolean,
  capturedRequests: Array<{tabId: number, url: string, baseUrl: string}>
}} */
const state = {
  isDownloading: false,
  bookTitle: "",
  kebabTitle: "",
  downloadedUrls: new Set(),
  pendingUrls: new Set(),
  fileCount: 0,
  tabId: null,
  currentPercent: 0,
  expectedDuration: "",
  nextRuleId: 1,
  spineData: [],
  spineByPartId: {},
  spineWithTimes: [],
  missingFiles: [],
  isFillingGaps: false,
  scrubbingComplete: false,
  gapFillComplete: false,
  capturedRequests: [],
};

// מיפוי מזהי ההורדות של Chrome לחלקים המתאימים בספר
const downloadIdToPart = new Map();

// תור שמות קבצים שממתינים לאירוע קביעת שם הקובץ של Chrome
/** @type {Map<string, string[]>} */
const pendingFilenameSuggestions = new Map();

// מפתח לשמירת בקשות אודיו שנלכדו לפני תחילת ההורדה
const CAPTURED_REQUESTS_KEY = "capturedRequests";

// שחזור בקשות שנשמרו לפני ש-Service Worker הופסק
if (chrome.storage.session) {
  chrome.storage.session.get(CAPTURED_REQUESTS_KEY).then((result) => {
    const stored = result?.[CAPTURED_REQUESTS_KEY];

    if (Array.isArray(stored)) {
      for (const request of stored) {
        if (
          request &&
          typeof request.tabId === "number" &&
          typeof request.url === "string" &&
          typeof request.baseUrl === "string"
        ) {
          const exists = state.capturedRequests.some(
            (item) =>
              item.tabId === request.tabId &&
              item.baseUrl === request.baseUrl
          );

          if (!exists) {
            state.capturedRequests.push(request);
          }
        }
      }

      console.log(
        "[libby-fetch] Restored",
        state.capturedRequests.length,
        "captured request(s)"
      );
    }
  }).catch((err) => {
    console.error("[libby-fetch] Failed to restore captured requests:", err);
  });
}

// כתובות שרתי האודיו שמהם התוסף לוכד קבצים
const AUDIO_URL_PATTERNS = [
  /^https:\/\/odrmediaclips\.cachefly\.net/,
  /^https:\/\/audioclips\.cdn\.overdrive\.com/,
];

/**
 * המרת שם הספר לשם תיקייה בטוח.
 * הפונקציה שומרת אותיות בעברית ובשפות אחרות.
 * @param {string} str
 * @returns {string}
 */
function toKebabCase(str) {
  // ניקוי והמרת שם הספר למחרוזת תקינה
  const result = String(str || "")
    .normalize("NFKC")
    .toLowerCase()
    // שמירת אותיות Unicode, ספרות, רווחים ומקפים
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    // החלפת רווחים במקפים
    .replace(/\s+/g, "-")
    // איחוד רצפים של מקפים
    .replace(/-+/g, "-")
    // הסרת מקפים מההתחלה ומהסוף
    .replace(/^-|-$/g, "");

  // מניעת יצירת נתיב ריק אם שם הספר מכיל רק סימנים
  return result || "libby-audiobook";
}

/**
 * נרמול מזהה חלק לפורמט אחיד של שתי ספרות לפחות.
 * לדוגמה Part1 וגם Part01 יהפכו ל-Part01.
 * @param {string} partId
 * @returns {string}
 */
function normalizePartId(partId) {
  // חילוץ מספר החלק מתוך מזהה כגון Part01
  const match = String(partId || "").match(/Part0*(\d+)/i);

  // החזרת מזהה אחיד עם שתי ספרות לפחות
  return match
    ? `Part${String(Number(match[1])).padStart(2, "0")}`
    : String(partId || "");
}

/**
 * חילוץ מספר החלק מתוך מזהה או שם קובץ.
 * @param {string} value
 * @returns {string|null}
 */
function getPartNumber(value) {
  // חיפוש מספר חלק בתבניות נפוצות
  const match = String(value || "").match(/Part0*(\d+)(?:\.mp3)?/i);

  // החזרת המספר עם שתי ספרות לפחות
  return match ? String(Number(match[1])).padStart(2, "0") : null;
}

/**
 * חילוץ מזהה חלק הספר מתוך כתובת האודיו.
 * פרמטר badurl מכיל כתובת מקורית המקודדת ב-Base64.
 * OverDrive עשוי להציב את הפרמטר אחרי נקודה-פסיק ולא רק אחרי &.
 * @param {string} url
 * @returns {string}
 */
function getBaseUrl(url) {
  // ניסיון לפענח את פרמטר badurl מתוך כתובת OverDrive
  try {
    // איתור badurl גם כאשר הוא מופיע אחרי נקודה-פסיק
    // הערך מסתיים לפני לוכסן, נקודה-פסיק או אמפרסנד
    const badUrlMatch = String(url).match(
      /(?:[?&;])badurl=([^/&;]+)/i
    );

    if (badUrlMatch) {
      // חילוץ ערך Base64 וניסיון לפענח קידוד URL אם קיים
      let b64 = badUrlMatch[1];

      try {
        b64 = decodeURIComponent(b64);
      } catch {
        // אם הערך אינו מקודד URL, ממשיכים עם הערך המקורי
      }

      // המרת Base64 URL-safe לפורמט Base64 רגיל
      b64 = b64
        .replace(/-/g, "+")
        .replace(/_/g, "/");

      // השלמת תווי Padding חסרים
      while (b64.length % 4 !== 0) {
        b64 += "=";
      }

      // פענוח כתובת הקובץ המקורית
      const decoded = atob(b64);

      console.log(
        "[libby-fetch] Decoded badurl:",
        decoded
      );

      // חילוץ מספר החלק מתוך שם הקובץ המקורי
      const partMatch = decoded.match(/Part0*(\d+)\.mp3/i);

      if (partMatch) {
        // החזרת מזהה מנורמל, לדוגמה Part01
        const partId = normalizePartId(`Part${partMatch[1]}`);

        console.log(
          "[libby-fetch] Identified audiobook part from badurl:",
          partId
        );

        return partId;
      }

      // ניסיון לחלץ שם קובץ MP3 אם אין בו מזהה Part
      const filenameMatch = decoded.match(/([^/\\]+\.mp3)(?:[?#]|$)/i);

      if (filenameMatch) {
        console.log(
          "[libby-fetch] Found original audio filename:",
          filenameMatch[1]
        );

        return filenameMatch[1];
      }

      console.warn(
        "[libby-fetch] badurl decoded but no MP3 part was found:",
        decoded
      );
    }
  } catch (e) {
    // הצגת שגיאת הפענוח בלי להניח שסוג השגיאה הוא Error
    console.log(
      "[libby-fetch] Error decoding badurl:",
      e instanceof Error ? e.message : String(e)
    );
  }

  // ניסיון לחלץ מספר חלק ישירות מכל כתובת הבקשה
  const directPartMatch = String(url).match(/Part0*(\d+)\.mp3/i);

  if (directPartMatch) {
    // החזרת מזהה אחיד
    const partId = normalizePartId(`Part${directPartMatch[1]}`);

    console.log(
      "[libby-fetch] Identified audiobook part directly from URL:",
      partId
    );

    return partId;
  }

  // ניסיון נוסף לפענח את שם הקובץ מתוך הנתיב
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/");
    const filename = pathParts[pathParts.length - 1] || "";

    // ניסיון למצוא מזהה חלק בשם הקובץ שבנתיב
    const filenamePartMatch = filename.match(/Part0*(\d+)\.mp3/i);

    if (filenamePartMatch) {
      return normalizePartId(`Part${filenamePartMatch[1]}`);
    }

    // אם לא נמצא מזהה חלק, מחזירים את שם הקובץ
    return filename || url;
  } catch {
    // החזרת הכתובת המקורית אם לא ניתן לנתח אותה
    return url;
  }
}

/**
 * חילוץ סיומת שם הקובץ מתוך רשומת Spine.
 * לדוגמה: Part08.mp3 יהפוך ל-08.mp3.
 * @param {{path: string}} entry
 * @returns {string}
 */
function extractPartSuffix(entry) {
  // פענוח נתיב הקובץ המקורי
  let decoded = entry.path;

  try {
    decoded = decodeURIComponent(entry.path);
  } catch {
    // אם הפענוח נכשל, ממשיכים להשתמש בנתיב המקורי
  }

  // חילוץ מספר החלק מתוך שם הקובץ
  const match = decoded.match(/Part0*(\d+)\.mp3/i);

  if (match) {
    return String(Number(match[1])).padStart(2, "0") + ".mp3";
  }

  // ניסיון חילוץ מספר החלק מתבנית אחרת בנתיב
  const numberMatch = decoded.match(/(?:^|[/\\_-])0*(\d+)\.mp3$/i);

  if (numberMatch) {
    return String(Number(numberMatch[1])).padStart(2, "0") + ".mp3";
  }

  // שימוש בשם הקובץ בלבד במקרה שלא נמצא מספר חלק
  return decoded.replace(/.*[/\\]/, "") || decoded;
}

/**
 * הוספת כלל חסימה כדי למנוע בקשות כפולות לאותו חלק.
 * @param {string} baseUrl
 */
async function blockUrl(baseUrl) {
  // הקצאת מזהה ייחודי לכלל החסימה
  const ruleId = state.nextRuleId++;

  try {
    // הוספת כלל חסימה דינמי לכתובת החלק
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: baseUrl,
          resourceTypes: ["media", "xmlhttprequest", "other"],
        },
      }],
      removeRuleIds: [],
    });

    console.log(
      "[libby-fetch] Added block rule",
      ruleId,
      "for",
      baseUrl
    );
  } catch (err) {
    console.error("[libby-fetch] Failed to add block rule:", err);
  }
}

/**
 * הסרת כללי החסימה הדינמיים של התוסף.
 */
async function clearBlockRules() {
  try {
    // קבלת הכללים הקיימים
    const rules = await chrome.declarativeNetRequest.getDynamicRules();

    // חילוץ מזהי הכללים להסרה
    const ruleIds = rules.map((rule) => rule.id);

    if (ruleIds.length > 0) {
      // הסרת הכללים
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: ruleIds,
        addRules: [],
      });

      console.log(
        "[libby-fetch] Cleared",
        ruleIds.length,
        "block rules"
      );
    }
  } catch (err) {
    console.error("[libby-fetch] Failed to clear block rules:", err);
  }

  // איפוס מונה מזהי הכללים
  state.nextRuleId = 1;
}

/**
 * בדיקה אם כתובת שייכת לשרת אודיו מוכר.
 * @param {string} url
 * @returns {boolean}
 */
function isAudioUrl(url) {
  return AUDIO_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * הסרת הצעת שם קובץ מתור ההצעות.
 * הפעולה משמשת במקרה שההורדה לא התחילה.
 * @param {string} url
 * @param {string} filename
 */
function removePendingFilenameSuggestion(url, filename) {
  // קבלת תור השמות של כתובת ההורדה
  const filenames = pendingFilenameSuggestions.get(url);

  // אין תור להסיר ממנו
  if (!filenames) return;

  // איתור שם הקובץ המסוים
  const index = filenames.indexOf(filename);

  // הסרת השם אם הוא עדיין ממתין
  if (index !== -1) {
    filenames.splice(index, 1);
  }

  // מחיקת התור אם הוא התרוקן
  if (filenames.length === 0) {
    pendingFilenameSuggestions.delete(url);
  }
}

/**
 * קביעת שם הקובץ הסופי עבור הורדות Libby בלבד.
 * הורדות אחרות מועברות ללא שינוי לתוספים אחרים, כולל IDM.
 *
 * חשוב: יש לטעון את התוסף הזה אחרי IDM Integration Module
 * כדי שהצעת השם של Libby תהיה ההצעה האחרונה בהורדות שלו.
 */
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // בדיקה אם ההורדה נוצרה על ידי התוסף הנוכחי
  const initiatedByThisExtension =
    item.byExtensionId === chrome.runtime.id;

  // בדיקה אם מדובר בקובץ אודיו של Libby
  const isLibbyAudio = isAudioUrl(item.url);

  // לא משנים שמות של הורדות אחרות
  if (!initiatedByThisExtension || !isLibbyAudio) {
    suggest();
    return;
  }

  // חיפוש שם הקובץ שהוכן מראש עבור כתובת זו
  const filenames = pendingFilenameSuggestions.get(item.url);

  // אם אין הצעה, לא משנים את שם הקובץ
  if (!filenames || filenames.length === 0) {
    console.warn(
      "[libby-fetch] No pending filename suggestion for:",
      item.url
    );

    suggest();
    return;
  }

  // שליפת שם הקובץ הבא בתור
  const filename = filenames.shift();

  // מחיקת התור אם אין בו שמות נוספים
  if (filenames.length === 0) {
    pendingFilenameSuggestions.delete(item.url);
  }

  console.log(
    "[libby-fetch] Applying Libby filename:",
    filename
  );

  // הצעת הנתיב הרצוי ל-Chrome
  suggest({
    filename,
    conflictAction: "uniquify",
  });
});

/**
 * שמירת בקשות אודיו שנלכדו כדי שישרדו הפעלה מחדש של Service Worker.
 */
function persistCapturedRequests() {
  if (!chrome.storage.session) return;

  chrome.storage.session
    .set({ [CAPTURED_REQUESTS_KEY]: state.capturedRequests })
    .catch((err) => {
      console.error(
        "[libby-fetch] Failed to persist captured requests:",
        err
      );
    });
}

/**
 * שמירת בקשת אודיו שנשלחה לפני שהמשתמש התחיל הורדה.
 * @param {number} tabId
 * @param {string} url
 * @param {string} baseUrl
 */
function captureRequest(tabId, url, baseUrl) {
  // נרמול מזהה החלק לפני שמירת הבקשה
  const normalizedBaseUrl = normalizePartId(baseUrl);

  // בדיקה אם הבקשה כבר נשמרה
  const alreadyCaptured = state.capturedRequests.some(
    (request) =>
      request.tabId === tabId &&
      normalizePartId(request.baseUrl) === normalizedBaseUrl
  );

  if (alreadyCaptured) return;

  // שמירת הבקשה עם מזהה חלק אחיד
  state.capturedRequests.push({
    tabId,
    url,
    baseUrl: normalizedBaseUrl,
  });

  // שמירת המידע באחסון של Chrome
  persistCapturedRequests();
}

/**
 * הסרת בקשות שנשמרו עבור לשונית מסוימת.
 * @param {number} tabId
 */
function clearCapturedRequestsForTab(tabId) {
  // שמירת מספר הבקשות לפני הסינון
  const before = state.capturedRequests.length;

  // השארת בקשות ששייכות ללשוניות אחרות
  state.capturedRequests = state.capturedRequests.filter(
    (request) => request.tabId !== tabId
  );

  // שמירה מחדש רק אם הרשימה השתנתה
  if (state.capturedRequests.length !== before) {
    persistCapturedRequests();
  }
}

/**
 * טעינת נתוני Spine מתוך הקשר הדף ובניית מפת חלקים.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function loadSpineData(tabId) {
  try {
    // הרצת קוד בתוך הדף עצמו, שבו נמצא window.BIF
    const results = await chrome.scripting.executeScript({
      target: {
        tabId,
        allFrames: true,
      },
      world: "MAIN",
      func: () => {
        try {
          // קריאת רשימת חלקי הספר מתוך Libby
          // @ts-ignore
          return window.BIF?.map?.spine || [];
        } catch {
          return [];
        }
      },
    });

    // חיפוש המסגרת שבה נמצאו נתוני הספר
    let spine = [];

    for (const result of results || []) {
      if (
        Array.isArray(result?.result) &&
        result.result.length > 0
      ) {
        spine = result.result;
        break;
      }
    }

    // שמירת נתוני הספר
    state.spineData = spine;

    // איפוס מפת החלקים
    state.spineByPartId = {};

    // בניית מפת מזהים אחידה כגון Part01 ו-Part02
    for (const entry of spine) {
      let decoded = entry.path || "";

      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // שימוש בנתיב המקורי במקרה של כשל בפענוח
      }

      // חילוץ מספר החלק מנתיב הקובץ
      const partMatch = decoded.match(/Part0*(\d+)\.mp3/i);

      if (partMatch) {
        // יצירת מזהה אחיד עם שתי ספרות לפחות
        const normalizedPartId = normalizePartId(
          `Part${partMatch[1]}`
        );

        // שמירת הרשומה לפי המזהה האחיד
        state.spineByPartId[normalizedPartId] = entry;

        console.log(
          "[libby-fetch] Mapped spine entry:",
          normalizedPartId,
          entry.path
        );
      }
    }

    console.log(
      "[libby-fetch] Loaded spine:",
      state.spineData.length,
      "entries"
    );

    console.log(
      "[libby-fetch] Spine part IDs:",
      Object.keys(state.spineByPartId)
    );
  } catch (err) {
    // איפוס המידע במקרה של כשל בטעינת הספר
    console.error("[libby-fetch] Failed to load spine data:", err);

    state.spineData = [];
    state.spineByPartId = {};
  }
}

/**
 * הורדת קובץ Manifest שמכיל את רשימת חלקי הספר וזמני ההשמעה.
 */
function downloadManifest() {
  // אין צורך ליצור Manifest אם לא נמצאו נתוני ספר
  if (state.spineData.length === 0) {
    console.log(
      "[libby-fetch] No spine data available, skipping manifest download"
    );
    return;
  }

  // קביעת שם התיקייה
  const bookFolder = state.kebabTitle || "libby-audiobook";

  // משתנה לצבירת משך הזמן של חלקי הספר
  let cumulativeTime = 0;

  // רשימת קבצים עם זמני התחלה וסיום
  const filesWithTimes = [];

  // בניית רשימת הקבצים מתוך נתוני Spine
  const files = state.spineData.map((entry) => {
    // חילוץ סיומת הקובץ
    const suffix = extractPartSuffix(entry);

    // קריאת משך הקובץ
    const duration = entry["audio-duration"] || 0;

    // בניית נתוני הקובץ
    const file = {
      filename: `${bookFolder}-${suffix}`,
      startTime: cumulativeTime,
      duration,
      endTime: cumulativeTime + duration,
      byteSize: entry["-odread-file-bytes"],
      bitrate: entry["audio-bitrate"],
      spinePosition: entry["-odread-spine-position"],
      path: entry.path,
    };

    // עדכון הזמן המצטבר
    cumulativeTime += duration;

    // שמירת זמן ההתחלה המצטבר לצורך איתור חלקים חסרים
    filesWithTimes.push({
      ...file,
      cumulativeStartTime: cumulativeTime - duration,
    });

    return file;
  });

  // שמירת נתוני הזמנים במצב התוסף
  state.spineWithTimes = filesWithTimes;

  // בניית תוכן ה-Manifest
  const manifest = {
    bookTitle: state.bookTitle,
    kebabTitle: bookFolder,
    generatedAt: new Date().toISOString(),
    totalDuration: cumulativeTime,
    files,
  };

  // המרת הנתונים ל-JSON
  const json = JSON.stringify(manifest, null, 2);

  // יצירת כתובת Data URL להורדת הקובץ
  const dataUrl =
    "data:application/json;charset=utf-8," +
    encodeURIComponent(json);

  // יצירת נתיב יחסי ובטוח לקובץ ה-Manifest
  const manifestPath =
    `${bookFolder}/${bookFolder}-manifest.json`;

  console.log(
    "[libby-fetch] Starting manifest download:",
    manifestPath
  );

  // הורדת קובץ ה-Manifest
  chrome.downloads.download(
    {
      url: dataUrl,
      filename: manifestPath,
      conflictAction: "overwrite",
    },
    (downloadId) => {
      // בדיקת שגיאה שהוחזרה על ידי Chrome
      if (chrome.runtime.lastError || downloadId === undefined) {
        console.error(
          "[libby-fetch] Manifest download failed:",
          chrome.runtime.lastError?.message || "No download ID"
        );
        return;
      }

      console.log(
        "[libby-fetch] Manifest download accepted:",
        downloadId,
        manifestPath
      );

      // בדיקת פרטי ההורדה כפי ש-Chrome רשם
      chrome.downloads.search(
        { id: downloadId },
        (items) => {
          if (chrome.runtime.lastError) {
            console.error(
              "[libby-fetch] Manifest search failed:",
              chrome.runtime.lastError.message
            );
            return;
          }

          // הצגת הנתיב והמצב של קובץ ה-Manifest
          if (items && items.length > 0) {
            console.log(
              "[libby-fetch] Manifest download details:",
              {
                id: items[0].id,
                filename: items[0].filename,
                state: items[0].state,
                error: items[0].error,
              }
            );
          }
        }
      );
    }
  );
}

/**
 * בניית רשימת רצועות שתישלח לסקריפט של הדף.
 * @returns {Array<{partId: string, startTime: number, endTime: number}>}
 */
function buildTrackList() {
  return state.spineWithTimes
    .map((entry) => {
      // חילוץ מספר החלק מתוך שם הקובץ
      const suffixMatch = entry.filename.match(/-(\d+)\.mp3$/);

      // דילוג על קבצים שלא ניתן לזהות את מספר החלק שלהם
      if (!suffixMatch) return null;

      // יצירת פרטי הרצועה עם מזהה אחיד
      return {
        partId: normalizePartId("Part" + suffixMatch[1]),
        startTime: entry.startTime,
        endTime: entry.endTime,
      };
    })
    // הסרת ערכים שלא זוהו
    .filter((track) => track !== null);
}

/**
 * בדיקת קבצים חסרים לפי רשימת Spine והורדות שהסתיימו בהצלחה.
 */
function verifyAndReport() {
  // אין אפשרות לבדוק חוסרים בלי נתוני זמנים
  if (state.spineWithTimes.length === 0) {
    console.log(
      "[libby-fetch] No spine timing data available, skipping verification"
    );
    return;
  }

  // רשימת הקבצים החסרים
  const missing = [];

  // מעבר על כל חלקי הספר הצפויים
  for (const entry of state.spineWithTimes) {
    // חילוץ מזהה החלק מתוך שם הקובץ
    const suffixMatch = entry.filename.match(/-(\d+)\.mp3$/);

    // יצירת מזהה אחיד כגון Part01
    const partId = suffixMatch
      ? normalizePartId("Part" + suffixMatch[1])
      : null;

    // דילוג על קובץ שלא ניתן לזהות
    if (!partId) {
      console.log(
        "[libby-fetch] Could not extract part ID from:",
        entry.filename
      );
      continue;
    }

    // קובץ נחשב חסר אם ההורדה שלו לא הסתיימה בהצלחה
    if (!state.downloadedUrls.has(partId)) {
      missing.push({
        filename: entry.filename,
        partId,
        startTime: entry.cumulativeStartTime,
        duration: entry.duration,
        path: entry.path,
      });
    }
  }

  // שמירת רשימת החוסרים
  state.missingFiles = missing;

  // כתיבת דוח חוסרים ללוג
  if (missing.length > 0) {
    console.warn(
      "[libby-fetch] MISSING FILES:",
      missing.map((file) => file.filename).join(", "),
      `(${missing.length} of ${state.spineWithTimes.length} expected)`
    );
  } else {
    console.log(
      "[libby-fetch] All",
      state.spineWithTimes.length,
      "expected files downloaded successfully"
    );
  }

  // בניית הודעת סיום לחלונית ולדף
  const msg = {
    type: "DOWNLOAD_COMPLETE",
    fileCount: state.fileCount,
    expectedCount: state.spineWithTimes.length,
    missingFiles: missing,
    totalDuration:
      state.spineWithTimes.length > 0
        ? state.spineWithTimes[
          state.spineWithTimes.length - 1
        ].endTime
        : 0,
  };

  // שליחת הודעה לחלונית התוסף
  chrome.runtime.sendMessage(msg).catch(() => { });

  // שליחת הודעה ללשונית שבה מתנגן הספר
  if (state.tabId !== null) {
    chrome.tabs.sendMessage(state.tabId, msg).catch(() => { });
  }
}

/**
 * סיום הורדת הספר לאחר שכל ההורדות הרלוונטיות הסתיימו.
 */
function completeDownload() {
  // מניעת הפעלה חוזרת של פעולת הסיום
  if (!state.isDownloading) return;

  // סימון סיום ההורדה
  state.isDownloading = false;

  // הסרת כללי החסימה
  clearBlockRules();

  // בדיקת קבצים חסרים ושליחת דוח
  verifyAndReport();

  // עדכון ממשק המשתמש
  notifyProgress();
}

/**
 * בדיקה האם אפשר לסיים את תהליך הורדת הספר.
 * ההשלמה מתבצעת רק אחרי שכל ההורדות הפעילות הסתיימו.
 */
function maybeCompleteDownload() {
  // אין תהליך הורדה פעיל
  if (!state.isDownloading) return;

  // בדיקה האם כל חלקי הספר ירדו בהצלחה
  const allFilesDownloaded =
    state.spineData.length > 0 &&
    state.downloadedUrls.size >= state.spineData.length;

  // בדיקה האם הסריקה הסתיימה ואין הורדות פעילות
  const scrubbingFinished =
    state.scrubbingComplete &&
    state.pendingUrls.size === 0;

  // סיום רק אם כל הקבצים ירדו או שהסריקה הסתיימה וכל ההורדות הסתיימו
  if (allFilesDownloaded || scrubbingFinished) {
    console.log(
      "[libby-fetch] Download process can now complete"
    );

    completeDownload();
  }
}

/**
 * סיום תהליך השלמת חלקים חסרים לאחר שההורדות הסתיימו.
 */
function maybeCompleteGapFill() {
  // אין בקשה פעילה להשלמת חלקים
  if (!state.isFillingGaps) return;

  // התוכן עדיין לא סיים לעבור על החלקים החסרים
  if (!state.gapFillComplete) return;

  // עדיין קיימות הורדות פעילות
  if (state.pendingUrls.size > 0) return;

  // סיום תהליך השלמת החלקים
  state.isFillingGaps = false;

  console.log("[libby-fetch] Gap fill downloads finished");

  // בדיקה מחודשת של רשימת החוסרים
  verifyAndReport();

  // עדכון ממשק המשתמש
  notifyProgress();
}

/**
 * בדיקת הנתיב הסופי של הורדה שהסתיימה.
 * @param {number} downloadId
 * @param {string} partId
 */
function inspectCompletedDownload(downloadId, partId) {
  // חיפוש פרטי ההורדה לפי מזהה Chrome
  chrome.downloads.search(
    { id: downloadId },
    (items) => {
      // בדיקת שגיאת Chrome
      if (chrome.runtime.lastError) {
        console.error(
          "[libby-fetch] Could not inspect completed download:",
          chrome.runtime.lastError.message
        );
        return;
      }

      // בדיקה אם נמצאה רשומת הורדה
      if (!items || items.length === 0) {
        console.warn(
          "[libby-fetch] No download details found:",
          downloadId
        );
        return;
      }

      // קבלת פרטי ההורדה
      const item = items[0];

      // הצגת הנתיב הסופי ש-Chrome שמר
      console.log(
        "[libby-fetch] FINAL DOWNLOAD DETAILS:",
        {
          id: item.id,
          partId,
          filename: item.filename,
          state: item.state,
          error: item.error,
          url: item.url,
          finalUrl: item.finalUrl,
        }
      );

      // בניית תחילת הנתיב הצפוי
      const expectedPrefix =
        `${state.kebabTitle}/${state.kebabTitle}-`;

      // התרעה אם Chrome שמר את הקובץ בנתיב אחר
      if (
        item.filename &&
        !item.filename.replace(/\\/g, "/").includes(expectedPrefix)
      ) {
        console.error(
          "[libby-fetch] WARNING: Actual filename differs from expected path",
          {
            expectedPrefix,
            actualFilename: item.filename,
          }
        );
      }
    }
  );
}

/**
 * טיפול בסיום או בכישלון של הורדת קובץ אודיו.
 * @param {number} downloadId
 * @param {"complete"|"interrupted"} result
 * @param {string} [error]
 */
function finishAudioDownload(downloadId, result, error) {
  // איתור החלק ששייך להורדה
  const partId = downloadIdToPart.get(downloadId);

  // התעלמות מהורדות שאינן מנוהלות על ידי התוסף
  if (!partId) return;

  // הסרת ההורדה ממפת ההורדות הפעילות
  downloadIdToPart.delete(downloadId);

  // הסרת החלק מרשימת ההורדות הממתינות
  state.pendingUrls.delete(partId);

  if (result === "complete") {
    // סימון החלק כהורדה שהסתיימה בהצלחה
    state.downloadedUrls.add(partId);

    // עדכון המונה לפי מספר החלקים שהורדו בהצלחה
    state.fileCount = state.downloadedUrls.size;

    console.log(
      "[libby-fetch] Download completed successfully:",
      partId,
      "Total:",
      state.fileCount
    );

    // בדיקת הנתיב הסופי לאחר השלמת ההורדה
    inspectCompletedDownload(downloadId, partId);
  } else {
    // אין לספור הורדה שנקטעה כהצלחה
    console.error(
      "[libby-fetch] Download interrupted:",
      partId,
      error || "Unknown error"
    );
  }

  // עדכון הממשק לאחר שינוי מצב ההורדה
  notifyProgress();

  // בדיקה אם אפשר לסיים את הורדת הספר
  maybeCompleteDownload();

  // בדיקה אם אפשר לסיים השלמת חלקים חסרים
  maybeCompleteGapFill();
}

/**
 * האזנה לשינויי מצב של הורדות Chrome.
 * רק מצב complete נחשב להורדה מוצלחת.
 */
chrome.downloads.onChanged.addListener((delta) => {
  // מתעלמים משינויים שאינם שינוי מצב
  if (!delta.state || !delta.state.current) return;

  // טיפול בהורדה שהסתיימה בהצלחה
  if (delta.state.current === "complete") {
    finishAudioDownload(delta.id, "complete");
    return;
  }

  // טיפול בהורדה שנקטעה או נכשלה
  if (delta.state.current === "interrupted") {
    finishAudioDownload(
      delta.id,
      "interrupted",
      delta.error?.current
    );
  }
});

/**
 * הורדת קובץ אודיו בודד.
 * @param {string} url
 * @param {string} baseUrl
 */
function handleAudioRequest(url, baseUrl) {
  // אין להוריד אם לא מתבצעת הורדה או השלמת חוסרים
  if (!state.isDownloading && !state.isFillingGaps) return;

  // נרמול מזהה החלק לצורך מניעת כפילויות
  const normalizedBaseUrl = normalizePartId(baseUrl);

  // דילוג על חלק שכבר ירד בהצלחה
  if (
    state.downloadedUrls.has(baseUrl) ||
    state.downloadedUrls.has(normalizedBaseUrl)
  ) {
    console.log(
      "[libby-fetch] Skipping already downloaded URL:",
      normalizedBaseUrl
    );
    return;
  }

  // דילוג על חלק שכבר נמצא בתהליך הורדה
  if (
    state.pendingUrls.has(baseUrl) ||
    state.pendingUrls.has(normalizedBaseUrl)
  ) {
    console.log(
      "[libby-fetch] Skipping duplicate pending URL:",
      normalizedBaseUrl
    );
    return;
  }

  // שימוש במזהה האחיד בכל ניהול ההורדה
  const partId = normalizedBaseUrl;

  // סימון החלק כממתין כדי למנוע בקשות כפולות
  state.pendingUrls.add(partId);

  // איתור רשומת החלק מתוך נתוני Spine
  let spineEntry = state.spineByPartId[partId];

  // חילוץ מספר החלק מתוך מזהה הבקשה
  const partNumber = getPartNumber(partId);

  // אם לא נמצאה רשומה לפי המזהה, מנסים לחפש לפי מספר החלק
  if (!spineEntry && partNumber) {
    spineEntry = state.spineData.find((entry) => {
      // פענוח נתיב הרשומה
      let path = entry.path || "";

      try {
        path = decodeURIComponent(path);
      } catch {
        // שימוש בנתיב המקורי במקרה של כשל בפענוח
      }

      // בדיקה אם מספר החלק ברשומה תואם למספר החלק המבוקש
      const match = path.match(/Part0*(\d+)\.mp3/i);

      return match &&
        String(Number(match[1])).padStart(2, "0") === partNumber;
    });
  }

  // חילוץ סיומת הקובץ מתוך רשומת Spine
  let fileSuffix = spineEntry
    ? extractPartSuffix(spineEntry)
    : "";

  // אם לא נמצאה סיומת תקינה, משתמשים במספר החלק
  if (!fileSuffix || !/^\d+\.mp3$/i.test(fileSuffix)) {
    if (partNumber) {
      fileSuffix = `${partNumber}.mp3`;
    } else {
      // אין להשתמש בשם Hash כשאפשר להימנע מכך
      console.error(
        "[libby-fetch] Could not identify audiobook part:",
        {
          baseUrl,
          normalizedBaseUrl,
          partNumber,
          url,
          spineEntry,
        }
      );

      state.pendingUrls.delete(partId);
      notifyProgress();
      maybeCompleteDownload();
      maybeCompleteGapFill();
      return;
    }
  }

  // שימוש בשם תיקייה תקין
  const bookFolder = state.kebabTitle || "libby-audiobook";

  // בניית שם קובץ לפי שם הספר ומספר החלק
  const filename = `${bookFolder}-${fileSuffix}`;

  // בניית נתיב יחסי בתוך תיקיית הספר
  const downloadPath = `${bookFolder}/${filename}`;

  console.log(
    "[libby-fetch] Matched audiobook part:",
    {
      originalBaseUrl: baseUrl,
      normalizedPartId: partId,
      fileSuffix,
      spinePath: spineEntry?.path,
    }
  );

  console.log(
    "[libby-fetch] Starting download:",
    downloadPath,
    "from",
    url
  );

  try {
    // הכנת שם הקובץ בתור לפני בקשת ההורדה
    // כך האירוע onDeterminingFilename יוכל למצוא אותו בזמן
    const filenameQueue = pendingFilenameSuggestions.get(url) || [];
    filenameQueue.push(downloadPath);
    pendingFilenameSuggestions.set(url, filenameQueue);

    // בקשת הורדה מ-Chrome
    chrome.downloads.download(
      {
        url,
        filename: downloadPath,
        conflictAction: "uniquify",
      },
      (downloadId) => {
        // בדיקת שגיאה בהתחלת ההורדה
        if (chrome.runtime.lastError || downloadId === undefined) {
          const errorMessage =
            chrome.runtime.lastError?.message ||
            "Chrome did not return a download ID";

          // ניקוי הצעת שם הקובץ אם היא עדיין ממתינה
          removePendingFilenameSuggestion(url, downloadPath);

          // הסרת החלק מרשימת ההורדות הממתינות
          state.pendingUrls.delete(partId);

          // אין לספור קובץ שלא התחיל לרדת
          console.error(
            "[libby-fetch] Download start error:",
            partId,
            errorMessage
          );

          // עדכון הממשק
          notifyProgress();

          // בדיקה אם אפשר לסיים את התהליך
          maybeCompleteDownload();
          maybeCompleteGapFill();

          return;
        }

        // שמירת הקשר בין מזהה ההורדה לחלק האחיד בספר
        downloadIdToPart.set(downloadId, partId);

        console.log(
          "[libby-fetch] Chrome accepted download:",
          downloadId,
          downloadPath
        );

        // בדיקת פרטי ההורדה כפי ש-Chrome רשם
        chrome.downloads.search(
          { id: downloadId },
          (items) => {
            if (chrome.runtime.lastError) {
              console.error(
                "[libby-fetch] Initial download search failed:",
                chrome.runtime.lastError.message
              );
              return;
            }

            // הצגת פרטי ההורדה הראשוניים
            if (items && items.length > 0) {
              console.log(
                "[libby-fetch] Initial download details:",
                {
                  id: items[0].id,
                  requestedFilename: downloadPath,
                  actualFilename: items[0].filename,
                  state: items[0].state,
                }
              );
            }
          }
        );

        // אישור לסקריפט התוכן שהבקשה התקבלה וניתן להמשיך לסריקה
        if (state.tabId !== null) {
          chrome.tabs.sendMessage(
            state.tabId,
            {
              type: "TRACK_DOWNLOADED",
              partId,
            }
          ).catch(() => { });
        }

        // חסימת בקשות נוספות לאותו חלק רק לאחר ש-Chrome קיבל את ההורדה
        blockUrl(partId);

        // עדכון הממשק
        notifyProgress();
      }
    );
  } catch (err) {
    // ניקוי הצעת שם הקובץ במקרה של שגיאה סינכרונית
    removePendingFilenameSuggestion(url, downloadPath);

    // טיפול בשגיאה סינכרונית בהפעלת ההורדה
    state.pendingUrls.delete(partId);

    console.error(
      "[libby-fetch] Failed to start download:",
      err
    );

    // עדכון הממשק
    notifyProgress();

    // בדיקה אם אפשר לסיים את התהליך
    maybeCompleteDownload();
    maybeCompleteGapFill();
  }
}

/**
 * עיבוד בקשות אודיו שנלכדו לפני לחיצה על Start Download.
 * @param {number} tabId
 */
function processCapturedRequests(tabId) {
  // בחירת בקשות ששייכות ללשונית הנוכחית
  const relevant = state.capturedRequests.filter(
    (request) => request.tabId === tabId
  );

  // אין בקשות מוקדמות לעיבוד
  if (relevant.length === 0) return;

  // הסרת הבקשות שעומדות לעבור עיבוד
  state.capturedRequests = state.capturedRequests.filter(
    (request) => request.tabId !== tabId
  );

  // שמירת הרשימה המעודכנת
  persistCapturedRequests();

  console.log(
    "[libby-fetch] Processing",
    relevant.length,
    "captured request(s) for tab",
    tabId
  );

  // הפעלת הורדה לכל בקשה שנלכדה
  for (const request of relevant) {
    handleAudioRequest(request.url, request.baseUrl);
  }
}

// האזנה לבקשות אודיו שמגיעות משרתי Libby ו-OverDrive
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // חילוץ מזהה החלק מתוך כתובת הבקשה
    const baseUrl = getBaseUrl(details.url);

    // בדיקה אם מתבצעת הורדה או השלמת חוסרים
    const shouldDownload =
      state.isDownloading ||
      state.isFillingGaps;

    // שמירת בקשות מוקדמות לפני תחילת ההורדה
    if (details.tabId >= 0 && !shouldDownload) {
      captureRequest(
        details.tabId,
        details.url,
        baseUrl
      );
    }

    // אין צורך להמשיך אם אין תהליך הורדה פעיל
    if (!shouldDownload) return;

    // טיפול בבקשת האודיו
    handleAudioRequest(details.url, baseUrl);
  },
  {
    urls: [
      "*://odrmediaclips.cachefly.net/*",
      "*://audioclips.cdn.overdrive.com/*",
    ],
  }
);

/**
 * שליחת עדכון התקדמות לחלונית ולדף.
 */
function notifyProgress() {
  // בניית הודעת ההתקדמות
  const message = {
    type: "DOWNLOAD_PROGRESS",
    fileCount: state.fileCount,
    percent: state.currentPercent,
    isDownloading: state.isDownloading,
  };

  // שליחת הודעה לחלונית התוסף אם היא פתוחה
  chrome.runtime.sendMessage(message).catch(() => {
    // אין בעיה אם החלונית אינה פתוחה
  });

  // שליחת הודעה לסקריפט התוכן
  if (state.tabId !== null) {
    chrome.tabs.sendMessage(
      state.tabId,
      message
    ).catch(() => {
      // אין בעיה אם סקריפט התוכן אינו זמין
    });
  }
}

// האזנה להודעות שמגיעות מהחלונית ומסקריפט התוכן
chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    // קבלת רשומות לוג מסקריפטים אחרים
    if (
      message &&
      message.type === "LOG_ENTRY" &&
      message.entry
    ) {
      bgLogger.appendEntry(message.entry);
      sendResponse({ success: true });
      return false;
    }

    console.log(
      "[libby-fetch] Received message:",
      message
    );

    switch (message.type) {
      case "GET_EXPECTED_FILES": {
        // קבלת מזהה הלשונית שממנה הגיעה הבקשה
        const tabId = sender.tab?.id;

        // בדיקה אם מזהה הלשונית קיים
        if (tabId === undefined) {
          sendResponse({ expectedFiles: 0 });
          return false;
        }

        // שימוש בנתונים שכבר נטענו אם קיימים
        if (state.spineData.length > 0) {
          sendResponse({
            expectedFiles: state.spineData.length,
          });
          return false;
        }

        // קריאת מספר חלקי הספר מתוך הקשר הדף
        chrome.scripting.executeScript({
          target: {
            tabId,
            allFrames: true,
          },
          world: "MAIN",
          func: () => {
            try {
              // @ts-ignore
              const spine = window.BIF?.map?.spine;

              return Array.isArray(spine)
                ? spine.length
                : 0;
            } catch {
              return 0;
            }
          },
        }).then((results) => {
          // ברירת מחדל למספר החלקים
          let count = 0;

          // חיפוש תוצאה תקינה מאחת המסגרות
          for (const result of results || []) {
            if (
              typeof result?.result === "number" &&
              result.result > 0
            ) {
              count = result.result;
              break;
            }
          }

          // החזרת מספר החלקים
          sendResponse({ expectedFiles: count });
        }).catch((err) => {
          console.error(
            "[libby-fetch] Error getting expected files:",
            err
          );

          sendResponse({ expectedFiles: 0 });
        });

        // השארת ערוץ ההודעות פתוח לתשובה אסינכרונית
        return true;
      }

      case "START_DOWNLOAD": {
        // ניקוי כללי חסימה מהורדה קודמת
        clearBlockRules();

        // איפוס מצב ההורדה
        state.isDownloading = true;
        state.bookTitle = message.bookTitle || "";
        state.kebabTitle = toKebabCase(state.bookTitle);
        state.downloadedUrls.clear();
        state.pendingUrls.clear();
        state.fileCount = 0;
        state.tabId = message.tabId;
        state.currentPercent = 0;
        state.expectedDuration = message.expectedDuration || "";
        state.spineData = [];
        state.spineByPartId = {};
        state.spineWithTimes = [];
        state.missingFiles = [];
        state.isFillingGaps = false;
        state.scrubbingComplete = false;
        state.gapFillComplete = false;

        // איפוס מיפוי ההורדות הקודמות
        downloadIdToPart.clear();

        // איפוס הצעות שמות קבצים ישנות
        pendingFilenameSuggestions.clear();

        console.log(
          "[libby-fetch] Starting download for:",
          state.bookTitle
        );

        console.log(
          "[libby-fetch] Using folder:",
          state.kebabTitle
        );

        // החזרת אישור לחלונית
        sendResponse({
          success: true,
          kebabTitle: state.kebabTitle,
        });

        // טעינת נתוני הספר והפעלת תהליך ההורדה
        loadSpineData(message.tabId).then(() => {
          // יצירת קובץ Manifest
          downloadManifest();

          // עיבוד בקשות שנלכדו לפני תחילת ההורדה
          processCapturedRequests(message.tabId);

          // שליחת רשימת הרצועות לסקריפט התוכן
          if (state.tabId !== null) {
            chrome.tabs.sendMessage(
              state.tabId,
              {
                type: "START_SCRUBBING",
                tracks: buildTrackList(),
                totalDuration:
                  state.spineWithTimes.length > 0
                    ? state.spineWithTimes[
                      state.spineWithTimes.length - 1
                    ].endTime
                    : 0,
                downloadedParts: Array.from(
                  state.downloadedUrls
                ),
              }
            ).catch((err) => {
              console.error(
                "[libby-fetch] Failed to start scrubbing:",
                err
              );
            });
          }
        }).catch((err) => {
          console.error(
            "[libby-fetch] Failed to initialize download:",
            err
          );

          state.isDownloading = false;
          notifyProgress();
        });

        // הערוץ נסגר לאחר התשובה שכבר נשלחה
        return false;
      }

      case "STOP_DOWNLOAD": {
        // עצירת תהליך ההורדה
        state.isDownloading = false;
        state.scrubbingComplete = false;

        console.log("[libby-fetch] Stopping download");

        // הסרת כללי החסימה
        clearBlockRules();

        // הוראה לסקריפט התוכן לעצור
        if (state.tabId !== null) {
          chrome.tabs.sendMessage(
            state.tabId,
            { type: "STOP_SCRUBBING" }
          ).catch(() => { });
        }

        // אישור עצירה
        sendResponse({ success: true });

        return false;
      }

      case "GET_STATUS": {
        // החזרת מצב ההורדה הנוכחי לחלונית
        sendResponse({
          isDownloading: state.isDownloading,
          fileCount: state.fileCount,
          percent: state.currentPercent,
          bookTitle: state.bookTitle,
          kebabTitle: state.kebabTitle,
          expectedDuration: state.expectedDuration,
          expectedCount: state.spineWithTimes.length,
          missingFiles: state.missingFiles,
          isFillingGaps: state.isFillingGaps,
        });

        return false;
      }

      case "EXPORT_LOGS": {
        // קבלת רשומות הלוג
        const entries = /** @type {Array<{ts: string, level: string, source: string, msg: string}>} */ (
          bgLogger.getEntries()
        );

        // מיון הרשומות לפי זמן
        entries.sort((a, b) =>
          a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
        );

        // יצירת כותרת קובץ הלוג
        const lines = [
          "Libby Audiobook Downloader — debug log",
          "Generated: " + new Date().toISOString(),
          "Extension version: " +
          (chrome.runtime.getManifest().version || "unknown"),
          "Book: " + (state.bookTitle || "(none)"),
          "Expected files: " + (state.spineData.length || 0),
          "Downloaded files: " + state.fileCount,
          "Missing files: " +
          state.missingFiles.map((file) => file.partId).join(", "),
          "",
        ];

        // הוספת כל רשומות הלוג לקובץ
        for (const entry of entries) {
          lines.push(
            "[" + entry.ts + "] [" +
            entry.level + "] [" +
            entry.source + "] " +
            entry.msg
          );
        }

        // חיבור שורות הלוג לטקסט אחד
        const text = lines.join("\n");

        // יצירת כתובת הורדה
        const dataUrl =
          "data:text/plain;charset=utf-8," +
          encodeURIComponent(text);

        // יצירת חותמת זמן לשם הקובץ
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-");

        // הוספת שם הספר לשם הקובץ אם קיים
        const bookPrefix = state.kebabTitle
          ? state.kebabTitle + "-"
          : "";

        // בניית שם קובץ הלוג
        const filename =
          "libby-logs-" +
          bookPrefix +
          timestamp +
          ".txt";

        // הורדת קובץ הלוג
        chrome.downloads.download(
          {
            url: dataUrl,
            filename,
            conflictAction: "uniquify",
          },
          () => {
            if (chrome.runtime.lastError) {
              console.error(
                "[libby-fetch] Log export failed:",
                chrome.runtime.lastError
              );
            }
          }
        );

        console.log(
          "[libby-fetch] Exported",
          entries.length,
          "log entries to",
          filename
        );

        // החזרת אישור לחלונית
        sendResponse({
          success: true,
          entries: entries.length,
        });

        return false;
      }

      case "SCRUBBING_COMPLETE": {
        // אם התהליך כבר הסתיים אין צורך לבצע שוב את הפעולה
        if (!state.isDownloading) {
          sendResponse({ success: true });
          return false;
        }

        // סימון שהסריקה של חלקי הספר הסתיימה
        state.scrubbingComplete = true;

        console.log(
          "[libby-fetch] Scrubbing complete. Waiting for pending downloads:",
          state.pendingUrls.size
        );

        // סיום רק לאחר שההורדות הפעילות יסתיימו
        maybeCompleteDownload();

        // אישור קבלת ההודעה
        sendResponse({ success: true });

        return false;
      }

      case "FILL_GAPS": {
        // אין חוסרים להשלמה
        if (state.missingFiles.length === 0) {
          console.log("[libby-fetch] No gaps to fill");

          sendResponse({
            success: true,
            filled: 0,
          });

          return false;
        }

        // אין אפשרות לשלוח הוראות בלי לשונית פעילה
        if (state.tabId === null) {
          sendResponse({
            success: false,
            error: "No active audiobook tab",
          });

          return false;
        }

        console.log(
          "[libby-fetch] Filling",
          state.missingFiles.length,
          "gaps:",
          state.missingFiles.map((file) => file.partId)
        );

        // סימון תחילת תהליך השלמת החוסרים
        state.isFillingGaps = true;
        state.gapFillComplete = false;

        // חישוב משך הספר הכולל
        const totalDuration =
          state.spineWithTimes[
            state.spineWithTimes.length - 1
          ]?.endTime || 0;

        // שליחת רשימת החלקים החסרים לסקריפט התוכן
        chrome.tabs.sendMessage(
          state.tabId,
          {
            type: "FILL_GAPS",
            missingParts: state.missingFiles,
            totalDuration,
          }
        ).catch((err) => {
          console.error(
            "[libby-fetch] Failed to send FILL_GAPS:",
            err
          );

          // ביטול מצב השלמת החוסרים במקרה של כשל בשליחת ההודעה
          state.isFillingGaps = false;
          notifyProgress();
        });

        // אישור קבלת הבקשה
        sendResponse({ success: true });

        return false;
      }

      case "GAP_FILL_COMPLETE": {
        // סימון שסקריפט התוכן סיים לעבור על החלקים החסרים
        state.gapFillComplete = true;

        console.log(
          "[libby-fetch] Gap fill scanning complete. Pending downloads:",
          state.pendingUrls.size
        );

        // המתנה להשלמת הורדות שעדיין פעילות
        maybeCompleteGapFill();

        // אישור קבלת ההודעה
        sendResponse({ success: true });

        return false;
      }

      case "SCRUBBING_PROGRESS": {
        // עדכון אחוז ההתקדמות
        state.currentPercent = message.percent;

        // העברת עדכון ההתקדמות לממשק
        notifyProgress();

        // אישור קבלת ההודעה
        sendResponse({ success: true });

        return false;
      }

      default: {
        // הודעה שאינה מוכרת לתוסף
        sendResponse({
          success: false,
          error: "Unknown message type",
        });

        return false;
      }
    }
  }
);

// עדכון סמל התוסף בהתאם לאתר שבו נמצאת הלשונית
chrome.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    // הסרת בקשות ישנות בעת ניווט לעמוד חדש
    if (changeInfo.status === "loading") {
      clearCapturedRequestsForTab(tabId);
    }

    // עדכון הסמל לאחר טעינת העמוד
    if (changeInfo.status === "complete" && tab.url) {
      // בדיקה אם העמוד שייך ל-Libby או ל-OverDrive
      const isLibbyPage =
        tab.url.includes(".listen.overdrive.com") ||
        tab.url.includes("libbyapp.com");

      // בחירת סמל מתאים
      chrome.action.setIcon({
        tabId,
        path: isLibbyPage
          ? {
            16: "/icons/icon16-active.png",
            48: "/icons/icon48-active.png",
            128: "/icons/icon128-active.png",
          }
          : {
            16: "/icons/icon16.png",
            48: "/icons/icon48.png",
            128: "/icons/icon128.png",
          },
      });
    }
  }
);

// הסרת בקשות שנשמרו עבור לשונית שנסגרה
chrome.tabs.onRemoved.addListener((tabId) => {
  clearCapturedRequestsForTab(tabId);
});

// הודעה ללוג על הפעלת Service Worker
console.log("[libby-fetch] Background service worker initialized");
