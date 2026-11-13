// @ts-check
/// <reference types="chrome"/>

// Popup script for Libby audiobook downloader

const popupLogger = /** @type {any} */ (globalThis).LibbyLogger;
if (popupLogger) {
  popupLogger.install("popup", { forward: true });
}

/** @type {string} */
let currentKebabTitle = "";
/** @type {string} */
let expectedDuration = "";

/**
 * @param {string} str
 * @returns {string}
 */
function toKebabCase(str) {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function $(id) {
  return document.getElementById(id);
}

/** @returns {Promise<chrome.tabs.Tab|null>} */
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * @param {string|undefined} url
 * @returns {boolean}
 */
function isOverdrivePage(url) {
  return !!url && (url.includes(".listen.overdrive.com") || url.includes("libbyapp.com"));
}

/**
 * @param {string} message
 */
function showError(message) {
  const errorEl = $("error");
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }
}

function hideError() {
  $("error")?.classList.add("hidden");
}

/**
 * @param {string} sectionId
 */
function showSection(sectionId) {
  ["setup-section", "progress-section", "complete-section", "not-overdrive"].forEach((id) => {
    const el = $(id);
    if (el) {
      el.classList.toggle("hidden", id !== sectionId);
    }
  });
}


/**
 * אתחול חלונית התוסף וקבלת פרטי הספר מעמוד Libby.
 * במקרה של כשל בבדיקת מצב ההורדה, ממשיכים לנסות לקבל את פרטי הספר.
 */
async function init() {
  // קבלת הלשונית הפעילה בדפדפן
  const tab = await getCurrentTab();

  // בדיקה אם המשתמש נמצא בעמוד Libby או OverDrive
  if (!tab || !isOverdrivePage(tab.url)) {
    showSection("not-overdrive");
    return;
  }

  // משתנה לשמירת מצב ההורדה הנוכחי
  let status = null;

  // ניסיון לקבל את מצב ההורדה מה-Background
  try {
    status = await chrome.runtime.sendMessage({
      type: "GET_STATUS",
    });

    // תיעוד התשובה שהתקבלה
    console.log("[popup] GET_STATUS result:", status);
  } catch (error) {
    // תיעוד התקלה בלי לעצור את המשך האתחול
    console.warn("[popup] GET_STATUS failed:", error);
  }

  // אם קיימת הורדה פעילה, הצגת מסך ההתקדמות
  if (status?.isDownloading || status?.isFillingGaps) {
    showSection("progress-section");
    updateProgress(status.fileCount || 0, status.percent || 0);
    currentKebabTitle = status.kebabTitle || "";
    expectedDuration = status.expectedDuration || "";
    return;
  }

  // אם ההורדה כבר הסתיימה, הצגת מסך הסיום
  if (status?.fileCount > 0 && !status.isDownloading) {
    currentKebabTitle = status.kebabTitle || "";
    expectedDuration = status.expectedDuration || "";

    showComplete(
      status.fileCount,
      status.expectedCount,
      status.missingFiles
    );

    return;
  }

  // הצגת מסך ההגדרות בזמן קבלת פרטי הספר
  showSection("setup-section");

  try {
    // בקשת פרטי הספר מ-Content Script
    const bookInfo = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_BOOK_INFO",
    });

    // תיעוד מלא של התשובה לצורך איתור תקלות
    console.log("[popup] GET_BOOK_INFO result:", bookInfo);

    // בדיקה שהתקבלה תשובה תקינה
    if (!bookInfo || typeof bookInfo !== "object") {
      throw new Error("לא התקבלה תשובה תקינה מעמוד Libby");
    }

    // חילוץ שם הספר או הצבת ערך ברירת מחדל
    const bookTitle =
      typeof bookInfo.title === "string" && bookInfo.title.trim()
        ? bookInfo.title.trim()
        : "ספר לא ידוע";

    // קבלת רכיבי הממשק
    const titleEl = $("book-title");
    const durationEl = $("book-duration");
    const folderInput = /** @type {HTMLInputElement|null} */ ($("folder-name"));
    const startBtn = /** @type {HTMLButtonElement|null} */ ($("start-btn"));

    // הצגת שם הספר
    if (titleEl) {
      titleEl.textContent = bookTitle;
    } else {
      console.error("[popup] Element book-title was not found");
    }

    // הצגת משך הספר
    if (durationEl) {
      durationEl.textContent = bookInfo.totalDurationFormatted || "--";
      expectedDuration = bookInfo.totalDurationFormatted || "";
    }

    // הצגת מספר קובצי האודיו הצפויים
    const expectedFilesEl = $("expected-files");

    if (expectedFilesEl) {
      expectedFilesEl.textContent =
        bookInfo.expectedFiles > 0
          ? String(bookInfo.expectedFiles)
          : "--";
    }

    // מילוי אוטומטי של שם תיקיית ההורדה
    if (folderInput) {
      folderInput.value = toKebabCase(bookTitle);
      currentKebabTitle = folderInput.value;
    }

    // הפעלת כפתור תחילת ההורדה
    if (startBtn) {
      startBtn.disabled = false;
    }

    // תיעוד הצלחת טעינת פרטי הספר
    console.log("[popup] Book information loaded:", {
      title: bookTitle,
      duration: expectedDuration,
      expectedFiles: bookInfo.expectedFiles,
    });

  } catch (error) {
    // תיעוד מפורט של התקלה
    console.error("[popup] Failed to get book info:", error);

    // הצגת הודעת שגיאה למשתמש
    showError("לא ניתן לקבל את פרטי הספר. נסו לרענן את עמוד Libby ואת התוסף.");
  }
}


/**
 * @param {number} fileCount
 * @param {number} percent
 */
function updateProgress(fileCount, percent) {
  const fileCountEl = $("file-count");
  const progressEl = $("book-progress");

  if (fileCountEl) {
    fileCountEl.textContent = String(fileCount);
  }

  if (progressEl) {
    progressEl.textContent = Math.round(percent * 100) + "%";
  }
}

/** @type {Array<{filename: string, partId: string}>} */
let currentMissingFiles = [];

/**
 * @param {number} totalFiles
 * @param {number} [expectedCount]
 * @param {Array<{filename: string, partId: string}>} [missingFiles]
 */
function showComplete(totalFiles, expectedCount, missingFiles) {
  showSection("complete-section");

  currentMissingFiles = missingFiles || [];
  
  const totalFilesEl = $("total-files");
  if (totalFilesEl) {
    if (expectedCount && missingFiles && missingFiles.length > 0) {
      totalFilesEl.textContent = `${totalFiles} / ${expectedCount}`;
    } else {
      totalFilesEl.textContent = String(totalFiles);
    }
  }

  // Show/hide gap-fill UI
  const gapSection = $("gap-section");
  const missingFilesList = $("missing-files-list");
  const fillGapsBtn = $("fill-gaps-btn");

  if (gapSection && missingFiles && missingFiles.length > 0) {
    gapSection.classList.remove("hidden");
    if (missingFilesList) {
      missingFilesList.textContent = missingFiles.map(f => f.filename).join("\n");
    }
    if (fillGapsBtn) {
      fillGapsBtn.disabled = false;
      fillGapsBtn.textContent = `השלמת ${missingFiles.length} קבצים חסרים`;
    }
  } else if (gapSection) {
    gapSection.classList.add("hidden");
  }
  const commandEl = $("validation-command");
  const expectedEl = $("expected-duration");
  
  if (commandEl && currentKebabTitle) {
    // Command that shows both file count and total duration
    const cmd = `cd ~/Downloads/${currentKebabTitle} && echo "Files: $(ls -1 *.mp3 | wc -l)" && for f in *.mp3; do afinfo "$f" 2>/dev/null | grep duration; done | awk '{s+=$3} END {h=int(s/3600); m=int((s%3600)/60); print "Duration: " h "h " m "m"}'`;
    commandEl.textContent = cmd;
  }
  
  // Add dedup command
  const dedupEl = $("dedup-command");
  if (dedupEl && currentKebabTitle) {
    const dedupCmd = `cd ~/Downloads/${currentKebabTitle} && md5 -r *.mp3 | sort | awk '{h=$1;f=$2;if(seen[h]){print "rm \\"" f "\\"";c++}else{seen[h]=1}} END{print "# "c" duplicates"}' | sh && echo "Files: $(ls -1 *.mp3 | wc -l)" && for f in *.mp3; do afinfo "$f" 2>/dev/null | grep duration; done | awk '{s+=$3} END {h=int(s/3600); m=int((s%3600)/60); print "Duration: " h "h " m "m"}'`;
    dedupEl.textContent = dedupCmd;
  }

  if (expectedEl) {
    expectedEl.textContent = expectedDuration || "--";
  }
}

async function startDownload() {
  hideError();

  const tab = await getCurrentTab();
  if (!tab?.id) {
    showError("לא נמצאה לשונית פעילה.");
    return;
  }

  const folderInput = /** @type {HTMLInputElement|null} */ ($("folder-name"));
  
  const bookTitle = folderInput?.value || "audiobook";
  
  currentKebabTitle = bookTitle;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_DOWNLOAD",
      bookTitle,
      tabId: tab.id,
      expectedDuration,
    });

    if (response.success) {
      showSection("progress-section");
      updateProgress(0, 0);
    } else {
      showError("הפעלת ההורדה נכשלה.");
    }
  } catch (error) {
    console.error("Start download error:", error);
    showError("הפעלת ההורדה נכשלה.");
  }
}

async function stopDownload() {
  try {
    await chrome.runtime.sendMessage({ type: "STOP_DOWNLOAD" });
    showSection("setup-section");
  } catch (error) {
    console.error("Stop download error:", error);
  }
}

/** Trigger a log export via the background worker. */
async function downloadLogs() {
  const btn = /** @type {HTMLButtonElement|null} */ ($("download-logs-btn"));
  if (btn) {
    btn.disabled = true;
    btn.textContent = "מייצא...";
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "EXPORT_LOGS" });
    console.log("[popup] Log export requested:", response);
  } catch (error) {
    console.error("Log export error:", error);
    showError("ייצוא יומן הפעילות נכשל. נסו שוב.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "הורדת יומן פעילות";
    }
  }
}

// Listen for progress updates from background
chrome.runtime.onMessage.addListener((message) => {
  // Ignore forwarded log entries; logging/echoing them would duplicate entries
  // in the background's master log buffer.
  if (message && message.type === "LOG_ENTRY") {
    return;
  }

  console.log("[popup] Received message:", message);

  if (message.type === "DOWNLOAD_PROGRESS" || message.type === "PROGRESS_UPDATE") {
    if (!message.isDownloading && message.fileCount > 0) {
      // DOWNLOAD_PROGRESS with isDownloading=false is the older signal.
      // DOWNLOAD_COMPLETE is the newer, richer one. Both may fire, so
      // DOWNLOAD_COMPLETE takes precedence for the final state.
      if (!message.missingFiles) {
        showComplete(message.fileCount);
      }
    } else if (message.isDownloading || message.fileCount >= 0) {
      updateProgress(message.fileCount, message.percent || 0);
    }
  }

  if (message.type === "DOWNLOAD_COMPLETE") {
    showComplete(message.fileCount, message.expectedCount, message.missingFiles);
  }
});

// Set up event listeners
document.addEventListener("DOMContentLoaded", () => {
  init();

  $("start-btn")?.addEventListener("click", startDownload);
  $("stop-btn")?.addEventListener("click", stopDownload);
  $("download-logs-btn")?.addEventListener("click", downloadLogs);
  $("new-download-btn")?.addEventListener("click", () => {
    currentMissingFiles = [];
    showSection("setup-section");
  });

  // Fill gaps button
  $("fill-gaps-btn")?.addEventListener("click", async () => {
    const btn = /** @type {HTMLButtonElement} */ ($("fill-gaps-btn"));
    if (btn) {
      btn.disabled = true;
      btn.textContent = "משלים קבצים חסרים...";
    }

    try {
      await chrome.runtime.sendMessage({ type: "FILL_GAPS" });
    } catch (error) {
      console.error("Fill gaps error:", error);
      showError("השלמת הקבצים נכשלה. ודאו שעמוד Libby עדיין פתוח.");
      if (btn) {
        btn.disabled = false;
        btn.textContent = currentMissingFiles.length > 0
          ? `השלמת ${currentMissingFiles.length} קבצים חסרים`
          : "השלמת קבצים חסרים";
      }
    }
  });

  // Update kebab title when folder name changes
  $("folder-name")?.addEventListener("input", (e) => {
    currentKebabTitle = /** @type {HTMLInputElement} */ (e.target).value;
  });
});
