// Library data storage
let library = []
let currentFilter = "all"
let currentSearch = ""
let selectedRating = 0
let currentSort = "none"

// Google Sheets integration config (fill these in when you deploy your Apps Script)
// It's okay to commit in this repo per your note, since you will use a separate sheet.
const SHEETS_ENDPOINT = "https://script.google.com/macros/s/AKfycbyJ8mckrd2RK8TsH-wL6TdvgcIoPRuYROwlpa7hpCOwVaMBS4SxBnWU4El7ziEbdffj/exec"
const SHEETS_TOKEN = "2f37de262d4be0b25c0a55d071b0c277b13942dec975e973c96d1556b6630e56"

// Debounce timer for auto-push
let pushDebounceTimer = null
function schedulePush() {
  if (!SHEETS_ENDPOINT || SHEETS_ENDPOINT.startsWith("REPLACE_")) return
  if (!SHEETS_TOKEN || SHEETS_TOKEN.startsWith("REPLACE_")) return
  clearTimeout(pushDebounceTimer)
  pushDebounceTimer = setTimeout(() => {
    pushToSheets().catch((e) => console.error("Auto push failed", e))
  }, 500)
}

// Loading indicator helper
function setLoading(visible, text = "Loading…") {
  const el = document.getElementById("loadingIndicator")
  if (!el) return
  const textEl = el.querySelector(".loading-text")
  if (textEl && typeof text === "string") textEl.textContent = text
  el.style.display = visible ? "flex" : "none"
  const container = document.querySelector(".container")
  if (container) {
    container.classList.toggle("loading", !!visible)
  }
}

// Initialize app
document.addEventListener("DOMContentLoaded", async () => {
  setLoading(true, "Loading…")
  await loadLibrary()
  initializeEventListeners()
  renderLibrary()
  updateStats()
  setLoading(false)
})

// Helpers to mirror Python slugify/normalization
function slugify(value) {
  let v = (value || "").trim().toLowerCase()
  // Normalize to NFKD and strip combining marks (diacritics)
  try {
    v = v.normalize("NFKD").replace(/\p{M}+/gu, "")
  } catch (_) {
    // Fallback for older browsers: remove common accents
    v = v.replace(/[\u0300-\u036f]/g, "")
  }
  v = v
    .replace(/’/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/&/g, "and")
  v = v.replace(/[^a-z0-9]+/g, "-")
  v = v.replace(/-+/g, "-").replace(/(^-+)|(-+$)/g, "")
  return v || "untitled"
}

function normalizeYear(yearRaw) {
  if (yearRaw == null) return null
  const s = String(yearRaw).trim()
  if (!s) return null
  const num = Number.parseInt(Number.parseFloat(s))
  if (Number.isFinite(num) && num >= 0 && num <= 2100) return String(num)
  return null
}

function deriveImagePath(title, year) {
  const base = slugify(title)
  const y = normalizeYear(year)
  const filename = y ? `${base}-${y}` : base
  // Most files are jpg; our downloader chose extension by content-type/URL.
  // We will try .jpg by default; the <img> onerror is already handled in render to hide missing images.
  return `public/movies/${filename}.jpg`
}

// Build a normalized key to detect duplicates consistently
function makeDedupeKey(it) {
  const type = (it.type || "").toLowerCase().trim()
  const title = slugify(it.title || "")
  const y = normalizeYear(it.year)
  return `${type}|${title}|${y || ""}`
}

// Return a new array with only the first occurrence for each dedupe key
function uniqueByKey(items) {
  const seen = new Set()
  const out = []
  for (const it of items || []) {
    const key = makeDedupeKey(it)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

// ===== Duplicate suggestions (live while typing) =====
function normalizeTitleForMatch(s) {
  return slugify(s || "")
}

function computeDuplicateSuggestions(queryTitle, queryType, queryYear, limit = 5) {
  const qTitle = normalizeTitleForMatch(queryTitle)
  const qYear = normalizeYear(queryYear)
  if (!qTitle || qTitle.length < 2) return []
  // Find items whose normalized title contains the query (or vice versa)
  const matches = []
  for (const it of library) {
    const itTitle = normalizeTitleForMatch(it.title)
    if (!itTitle) continue
    const contains = itTitle.includes(qTitle) || qTitle.includes(itTitle)
    if (!contains) continue
    // score: prioritize same type and same year, then startsWith
    let score = 0
    if ((it.type || "").toLowerCase() === (queryType || "").toLowerCase()) score += 2
    if (qYear != null && qYear !== "" && String(it.year) === String(qYear)) score += 1
    if (itTitle.startsWith(qTitle)) score += 1
    matches.push({ it, score })
  }
  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, limit).map(m => m.it)
}

function renderDuplicateSuggestions() {
  const box = document.getElementById("duplicateSuggestions")
  if (!box) return
  const titleEl = document.getElementById("itemTitle")
  const typeEl = document.getElementById("itemType")
  const yearEl = document.getElementById("itemYear")
  const title = titleEl ? titleEl.value : ""
  const type = typeEl ? typeEl.value : ""
  const year = yearEl ? yearEl.value : ""
  const suggestions = computeDuplicateSuggestions(title, type, year)
  if (!suggestions.length) {
    box.innerHTML = ""
    box.style.display = "none"
    return
  }
  const itemsHtml = suggestions
    .map((it) => {
      const ratingHtml = (() => {
        const r = Number(it.rating)
        if (!Number.isFinite(r) || r <= 0) return ""
        if (it.type === "movie") {
          const numeric = Number.isInteger(r) ? `${r}.0` : `${r}`
          return `<span class=\"sugg-rating\">${numeric}/10</span>`
        } else {
          const filled = Math.max(0, Math.min(5, Math.round(r)))
          const stars = Array(5).fill(0).map((_, i) => (i < filled ? "★" : "☆")).join("")
          return `<span class=\"sugg-rating\">${stars}</span>`
        }
      })()
      return `<div class=\"sugg-item\">
        <span class=\"sugg-type\">${it.type}</span>
        <span class=\"sugg-title\">${it.title}</span>
        <span class=\"sugg-creator\">${it.creator || ""}</span>
        <span class=\"sugg-year\">${it.year || ""}</span>
        ${ratingHtml}
      </div>`
    })
    .join("")
  box.innerHTML = `<div class=\"sugg-header\">Possible duplicates in your library:</div>${itemsHtml}`
  box.style.display = "block"
}

function clearDuplicateSuggestions() {
  const box = document.getElementById("duplicateSuggestions")
  if (box) {
    box.innerHTML = ""
    box.style.display = "none"
  }
}

// Minimal CSV parser for our 3-column file supporting quotes and commas
function parseCSV(text) {
  const rows = []
  let i = 0
  const n = text.length
  const current = []
  let field = ""
  let inQuotes = false
  let row = []

  function pushField() {
    row.push(field)
    field = ""
  }
  function pushRow() {
    // Skip empty trailing lines
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== "")) rows.push(row)
    row = []
  }

  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        // Handle escaped quotes ""
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        } else {
          inQuotes = false
          i += 1
          continue
        }
      } else {
        field += ch
        i += 1
        continue
      }
    } else {
      if (ch === '"') {
        inQuotes = true
        i += 1
        continue
      }
      if (ch === ',') {
        pushField()
        i += 1
        continue
      }
      if (ch === '\n') {
        pushField()
        pushRow()
        i += 1
        continue
      }
      if (ch === '\r') {
        // CRLF support
        pushField()
        if (i + 1 < n && text[i + 1] === '\n') i += 2
        else i += 1
        pushRow()
        continue
      }
      field += ch
      i += 1
    }
  }
  // Last field/row
  pushField()
  pushRow()
  return rows
}

async function loadLibrary() {
  // Prefer Google Sheets; fallback to CSV
  setLoading(true, "Fetching latest…")
  const fromSheets = await fetchFromSheets().catch((e) => {
    console.warn("Sheets pull failed, falling back to CSV.", e)
    return null
  })
  if (Array.isArray(fromSheets)) {
    library = uniqueByKey(fromSheets)
    return
  }

  try {
    const res = await fetch("data/movies_list.csv", { cache: "no-cache" })
    if (!res.ok) throw new Error(`Failed to load CSV: ${res.status}`)
    const text = await res.text()
    const rows = parseCSV(text)
    if (!rows.length) {
      library = []
      return
    }
    // First row is header: Title,Year,Director
    const header = rows[0].map((h) => h.trim())
    const idxTitle = header.indexOf("Title")
    const idxYear = header.indexOf("Year")
    const idxDirector = header.indexOf("Director")
    library = rows
      .slice(1)
      .map((cols, idx) => {
        const title = (cols[idxTitle] || "").trim()
        const year = (cols[idxYear] || "").trim()
        const creator = (cols[idxDirector] || "").trim()
        const image = title ? deriveImagePath(title, year) : null
        return {
          id: Date.now() + idx + 1,
          type: "movie",
          title,
          creator,
          year: normalizeYear(year) ? Number.parseInt(normalizeYear(year)) : "",
          rating: 0,
          notes: "",
          image,
        }
      })
      .filter((item) => item.title)
    library = uniqueByKey(library)
  } catch (e) {
    console.error(e)
    library = []
  }
}

// No-op: localStorage disabled per requirements
function saveLibrary() {}

// Initialize event listeners
function initializeEventListeners() {
  // Filter tabs
  document.querySelectorAll(".filter-tab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      document.querySelectorAll(".filter-tab").forEach((t) => t.classList.remove("active"))
      e.target.classList.add("active")
      currentFilter = e.target.dataset.filter
      renderLibrary()
    })
  })

  // Search
  document.getElementById("searchInput").addEventListener("input", (e) => {
    currentSearch = e.target.value.toLowerCase()
    renderLibrary()
  })

  // Sort
  const sortEl = document.getElementById("sortSelect")
  if (sortEl) {
    // Initialize state from current selection
    currentSort = sortEl.value || "none"
    sortEl.addEventListener("change", (e) => {
      currentSort = e.target.value || "none"
      renderLibrary()
    })
  }

  // Add item button
  document.getElementById("addItemBtn").addEventListener("click", openModal)

  // Manual Pull/Push removed: syncing is automatic now

  // Close modal
  document.getElementById("closeModalBtn").addEventListener("click", closeModal)
  document.getElementById("cancelBtn").addEventListener("click", closeModal)

  // Modal backdrop click
  document.getElementById("addItemModal").addEventListener("click", (e) => {
    if (e.target.id === "addItemModal") {
      closeModal()
    }
  })

  // Rating stars
  document.querySelectorAll(".rating-input .star").forEach((star) => {
    star.addEventListener("click", (e) => {
      selectedRating = Number.parseInt(e.target.dataset.rating)
      document.getElementById("itemRating").value = selectedRating
      updateRatingStars()
    })
  })

  // Item type change toggles rating inputs
  const typeSelect = document.getElementById("itemType")
  if (typeSelect) {
    typeSelect.addEventListener("change", updateRatingGroups)
  }

  // Form submit
  document.getElementById("addItemForm").addEventListener("submit", handleAddItem)

  // Live duplicate suggestions while typing/changing fields
  const titleEl = document.getElementById("itemTitle")
  const typeEl = document.getElementById("itemType")
  const yearEl = document.getElementById("itemYear")
  if (titleEl) titleEl.addEventListener("input", renderDuplicateSuggestions)
  if (typeEl) typeEl.addEventListener("change", () => {
    updateRatingGroups()
    renderDuplicateSuggestions()
  })
  if (yearEl) yearEl.addEventListener("input", renderDuplicateSuggestions)
}

// Open modal
function openModal() {
  document.getElementById("addItemModal").classList.add("active")
  document.body.style.overflow = "hidden"
  // Reset ratings visual state
  selectedRating = 0
  const hiddenBookRating = document.getElementById("itemRating")
  if (hiddenBookRating) hiddenBookRating.value = 0
  const movieRatingInput = document.getElementById("itemRatingMovie")
  if (movieRatingInput) movieRatingInput.value = ""
  updateRatingStars()
  updateRatingGroups()
  clearDuplicateSuggestions()
}

// Close modal
function closeModal() {
  document.getElementById("addItemModal").classList.remove("active")
  document.body.style.overflow = ""
  document.getElementById("addItemForm").reset()
  selectedRating = 0
  updateRatingStars()
  const movieRatingInput = document.getElementById("itemRatingMovie")
  if (movieRatingInput) movieRatingInput.value = ""
  const hiddenBookRating = document.getElementById("itemRating")
  if (hiddenBookRating) hiddenBookRating.value = 0
  updateRatingGroups()
  clearDuplicateSuggestions()
}

// Update rating stars display
function updateRatingStars() {
  document.querySelectorAll(".rating-input .star").forEach((star, index) => {
    if (index < selectedRating) {
      star.textContent = "★"
      star.classList.add("active")
    } else {
      star.textContent = "☆"
      star.classList.remove("active")
    }
  })
}

// Toggle rating groups based on selected type
function updateRatingGroups() {
  const typeSelect = document.getElementById("itemType")
  const type = typeSelect ? typeSelect.value : "book"
  const bookGroup = document.getElementById("bookRatingGroup")
  const movieGroup = document.getElementById("movieRatingGroup")
  if (bookGroup && movieGroup) {
    if (type === "movie") {
      bookGroup.style.display = "none"
      movieGroup.style.display = "block"
    } else {
      bookGroup.style.display = "block"
      movieGroup.style.display = "none"
    }
  }
}

// Handle add item form submission
function handleAddItem(e) {
  e.preventDefault()

  const type = document.getElementById("itemType").value
  // Determine rating based on type
  let rating = 0
  if (type === "movie") {
    const raw = parseFloat(document.getElementById("itemRatingMovie").value)
    if (Number.isFinite(raw)) {
      rating = Math.min(10, Math.max(0, raw))
    } else {
      rating = 0
    }
  } else {
    rating = Math.min(5, Math.max(0, Number(selectedRating) || 0))
  }

  const newItem = {
    id: Date.now(),
    type,
    title: document.getElementById("itemTitle").value,
    creator: document.getElementById("itemCreator").value,
    year: Number.parseInt(document.getElementById("itemYear").value),
    rating,
    notes: document.getElementById("itemNotes").value,
    image: document.getElementById("itemImage").value || null,
  }
  // Block duplicates on add
  const key = makeDedupeKey(newItem)
  const exists = library.some((it) => makeDedupeKey(it) === key)
  if (exists) {
    alert("This item already exists.")
    return
  }
  library.unshift(newItem)
  renderLibrary()
  updateStats()
  schedulePush()
  closeModal()
}

// Remove item
function removeItem(id) {
  if (confirm("Are you sure you want to remove this item from your library?")) {
    // Normalize both to strings to handle mixed ID types (string vs number)
    const target = String(id)
    library = library.filter((item) => String(item.id) !== target)
    renderLibrary()
    updateStats()
    schedulePush()
  }
}

// Filter and search library
function getFilteredLibrary() {
  return library.filter((item) => {
    const matchesFilter = currentFilter === "all" || item.type === currentFilter
    const matchesSearch =
      currentSearch === "" ||
      item.title.toLowerCase().includes(currentSearch) ||
      item.creator.toLowerCase().includes(currentSearch)
    return matchesFilter && matchesSearch
  })
}

// Render library grid
function renderLibrary() {
  const grid = document.getElementById("libraryGrid")
  const emptyState = document.getElementById("emptyState")
  const filteredLibrary = getFilteredLibrary()

  // Apply sorting
  const items = [...filteredLibrary]
  const byTitle = (a, b) => a.title.localeCompare(b.title)
  switch (currentSort) {
    case "year_desc": {
      items.sort((a, b) => {
        const ay = Number.isFinite(Number(a.year)) ? Number(a.year) : -Infinity
        const by = Number.isFinite(Number(b.year)) ? Number(b.year) : -Infinity
        if (by !== ay) return by - ay
        return byTitle(a, b)
      })
      break
    }
    case "year_asc": {
      items.sort((a, b) => {
        const ay = Number.isFinite(Number(a.year)) ? Number(a.year) : Infinity
        const by = Number.isFinite(Number(b.year)) ? Number(b.year) : Infinity
        if (ay !== by) return ay - by
        return byTitle(a, b)
      })
      break
    }
    case "rating_desc": {
      items.sort((a, b) => {
        const ar = Number.isFinite(Number(a.rating)) ? Number(a.rating) : -Infinity
        const br = Number.isFinite(Number(b.rating)) ? Number(b.rating) : -Infinity
        if (br !== ar) return br - ar
        return byTitle(a, b)
      })
      break
    }
    case "rating_asc": {
      items.sort((a, b) => {
        const ar = Number.isFinite(Number(a.rating)) ? Number(a.rating) : Infinity
        const br = Number.isFinite(Number(b.rating)) ? Number(b.rating) : Infinity
        if (ar !== br) return ar - br
        return byTitle(a, b)
      })
      break
    }
    default:
      // keep current order (newest added first)
      break
  }

  if (filteredLibrary.length === 0) {
    grid.style.display = "none"
    emptyState.style.display = "block"
    return
  }

  grid.style.display = "grid"
  emptyState.style.display = "none"

  grid.innerHTML = items
    .map(
      (item) => `
    <div class="library-card">
      ${
        item.image
          ? `<img src="${item.image}" alt="${item.title}" class="card-image" onerror="this.style.display='none'">`
          : `<div class="card-image" style="display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            </svg>
          </div>`
      }
      <div class="card-content">
        <span class="card-type">${item.type}</span>
        <h3 class="card-title">${item.title}</h3>
        <p class="card-creator">${item.creator}</p>
        <p class="card-year">${item.year}</p>
        ${(() => {
          const r = Number(item.rating)
          if (!Number.isFinite(r) || r <= 0) return ""
          if (item.type === "movie") {
            const numeric = Number.isInteger(r) ? `${r}.0` : `${r}`
            return `
              <div class=\"card-rating\">
                <span class=\"card-rating-score\">${numeric}/10</span>
              </div>
            `
          } else {
            const filled = Math.max(0, Math.min(5, Math.round(r)))
            const stars = Array(5)
              .fill(0)
              .map((_, i) => `<span class=\"star\">${i < filled ? "★" : "☆"}</span>`)
              .join("")
            return `
              <div class=\"card-rating\">
                <span class=\"card-rating-stars\">${stars}</span>
              </div>
            `
          }
        })()}
        ${item.notes ? `<p class="card-notes">${item.notes}</p>` : ""}
      </div>
    </div>
  `,
    )
    .join("")
}

// Update statistics
function updateStats() {
  const bookCount = library.filter((item) => item.type === "book").length
  const movieCount = library.filter((item) => item.type === "movie").length

  document.getElementById("totalCount").textContent = library.length
  document.getElementById("bookCount").textContent = bookCount
  document.getElementById("movieCount").textContent = movieCount
}

// ===== Google Sheets Sync Helpers =====
// Convert current library into plain objects for Sheets
function toPlainItems() {
  return library.map((it) => ({
    id: String(it.id),
    type: it.type,
    title: it.title,
    creator: it.creator,
    year: it.year ?? "",
    rating: it.rating ?? "",
    notes: it.notes ?? "",
    image: it.image ?? "",
  }))
}

// Internal helper to fetch items from Sheets
async function fetchFromSheets() {
  if (!SHEETS_ENDPOINT || SHEETS_ENDPOINT.startsWith("REPLACE_")) {
    return null
  }
  const res = await fetch(SHEETS_ENDPOINT, { method: "GET" })
  if (!res.ok) throw new Error(`GET failed: ${res.status}`)
  const items = await res.json()
  if (!Array.isArray(items)) throw new Error("Invalid response from Sheets")
  return items.map((it) => ({
    id: it.id || Date.now(),
    type: it.type || "movie",
    title: it.title || "",
    creator: it.creator || "",
    year: it.year !== "" ? Number(it.year) : "",
    rating: it.rating !== "" ? Number(it.rating) : 0,
    notes: it.notes || "",
    image: it.image || null,
  }))
}

// Pull from Google Sheets (GET) - not used by UI now, but kept for dev
async function pullFromSheets() {
  try {
    setLoading(true, "Fetching latest…")
    const items = await fetchFromSheets()
    if (items) {
      library = items
      renderLibrary()
      updateStats()
      console.log("Pulled from Google Sheets.")
    }
  } catch (e) {
    console.error("Failed to pull from Google Sheets.", e)
  } finally {
    setLoading(false)
  }
}

// Push to Google Sheets (POST)
async function pushToSheets() {
  if (!SHEETS_ENDPOINT || SHEETS_ENDPOINT.startsWith("REPLACE_")) return
  if (!SHEETS_TOKEN || SHEETS_TOKEN.startsWith("REPLACE_")) return
  setLoading(true, "Synchronizing…")
  try {
    // Deduplicate before pushing to server
    const items = uniqueByKey(library).map((it) => ({
      id: String(it.id),
      type: it.type,
      title: it.title,
      creator: it.creator,
      year: it.year ?? "",
      rating: it.rating ?? "",
      notes: it.notes ?? "",
      image: it.image ?? "",
    }))
    const payload = { token: SHEETS_TOKEN, items }
    const res = await fetch(SHEETS_ENDPOINT, {
      method: "POST",
      // Use text/plain to avoid preflight on Apps Script
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error((data && data.error) || `POST failed: ${res.status}`)
    }
    console.log(`Pushed ${(data && data.count) || library.length} items to Google Sheets.`)
  } finally {
    setLoading(false)
  }
}
