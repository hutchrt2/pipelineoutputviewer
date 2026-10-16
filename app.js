/**
 * funcMap Test Viewer
 * Zero external dependencies. Safe DOM APIs. Paged rendering.
 */

// Pure state management and filter logic (exportable for unit tests)
function createViewerState() {
  return {
    manifest: null,
    currentPmcid: null,
    currentPaperData: null,
    requestSeq: 0,
    activePmcid: null,
    filters: {
      search: "",
      relationVerdict: "ALL",
      contextVerdict: "ALL",
      mergeDecision: "ALL",
    },
    pagination: {
      page: 1,
      pageSize: 15,
      totalPages: 1,
    },
    error: null,
    loading: false,
  };
}

function normalizedVerdict(value) {
  return String(value || "").trim().toUpperCase();
}

function relationVerdictCategory(record) {
  const orig = record.source_record || record || {};
  const evaluation = orig.relation_evaluation || orig.relation_support_evaluation || {};
  return normalizedVerdict(evaluation.verdict) || "UNKNOWN";
}

function contextVerdictCategory(record) {
  const orig = record.source_record || record || {};
  const evaluation = orig.context_evaluation || {};
  return normalizedVerdict(evaluation.verdict) || "BASELINE";
}

function mergeDecisionCategory(record) {
  const orig = record.source_record || record || {};
  const raw = normalizedVerdict(orig.merge_decision || (orig.context_evaluation || {}).merge_decision);
  if (raw.includes("DROPPED")) return "DROPPED";
  if (raw.includes("CORRECTED")) return "RETAINED_CORRECTED";
  if (raw === "610_SUPPORTED" || raw === "SUPPORTED") return "RETAINED_SUPPORTED";
  if (raw.includes("510_NO_NEW_CONTEXT") || raw.includes("BASELINE")) return "BASELINE";
  if (raw.includes("RETAINED") || raw.includes("MERGED")) return "RETAINED_SUPPORTED";
  return raw || "UNKNOWN";
}

function filterRecords(records, filters) {
  if (!Array.isArray(records)) return [];
  const q = (filters.search || "").trim().toLowerCase();
  const relVerdict = filters.relationVerdict || "ALL";
  const ctxVerdict = filters.contextVerdict || "ALL";
  const mergeDec = filters.mergeDecision || "ALL";

  return records.filter((rec) => {
    const orig = rec.source_record || {};
    const relObj = orig.relation || {};
    const relEval = orig.relation_evaluation || orig.relation_support_evaluation || {};
    const ctxEval = orig.context_evaluation || {};
    // Filter by relation verdict
    if (relVerdict !== "ALL") {
      if (relationVerdictCategory(rec) !== normalizedVerdict(relVerdict)) return false;
    }

    // Filter by context verdict
    if (ctxVerdict !== "ALL") {
      if (contextVerdictCategory(rec) !== normalizedVerdict(ctxVerdict)) return false;
    }

    // Filter by merge decision
    if (mergeDec !== "ALL") {
      if (mergeDecisionCategory(rec) !== normalizedVerdict(mergeDec)) return false;
    }

    // Search query match
    if (q) {
      const sub = String(orig.subject || relObj.subject || "");
      const pred = String(orig.predicate || relObj.predicate || "");
      const obj = String(orig.object || relObj.object || "");
      const passage = String(orig.passage_text || orig.current_passage_id || "");
      const notes = String(relEval.notes || relEval.assertion_modifier || "");
      const origCtx = JSON.stringify(orig.original_context || ctxEval.original_context || "");
      const assignedCtx = JSON.stringify(orig.step5_assigned_context || ctxEval.assigned_context || "");
      const finalCtx = JSON.stringify(orig.final_assigned_context || orig.context || ctxEval.final_context || "");
      const haystack = `${sub} ${pred} ${obj} ${passage} ${notes} ${origCtx} ${assignedCtx} ${finalCtx}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

function paginateRecords(records, page, pageSize) {
  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const validPage = Math.min(Math.max(1, page), totalPages);
  const start = (validPage - 1) * pageSize;
  const end = start + pageSize;
  return {
    items: records.slice(start, end),
    page: validPage,
    totalPages: totalPages,
    totalRecords: total,
  };
}

// Asynchronous paper loading with race-condition protection (Ticket #4)
async function loadPaper(state, pmcid, fetchFn) {
  state.requestSeq += 1;
  const currentSeq = state.requestSeq;
  state.activePmcid = pmcid;
  state.loading = true;
  state.error = null;

  try {
    const data = await fetchFn(`data/papers/${pmcid}.json`);
    // Check if a newer request was dispatched while this was resolving
    if (state.requestSeq !== currentSeq) {
      return { ignored: true, resolvedSeq: currentSeq, latestSeq: state.requestSeq };
    }
    state.currentPmcid = pmcid;
    state.currentPaperData = data;
    state.pagination.page = 1;
    state.loading = false;
    return { success: true, data: data };
  } catch (err) {
    if (state.requestSeq !== currentSeq) {
      return { ignored: true, error: err };
    }
    state.error = err.message || "Failed to load paper data";
    state.currentPaperData = null;
    state.loading = false;
    return { success: false, error: state.error };
  }
}

function formatContextKey(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatContextValues(val) {
  if (Array.isArray(val)) {
    return val.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
  }
  if (typeof val === "object" && val !== null) {
    return JSON.stringify(val);
  }
  return String(val);
}

const REVIEW_STORAGE_PREFIX = "funcmap-outputviewer-reviews-v1";

function sourceRecordId(record) {
  const orig = record.source_record || {};
  return String(orig.record_id || record.record_id || "");
}

function sourceTripleId(record) {
  const orig = record.source_record || {};
  const relation = orig.relation || {};
  return String(
    orig.source_relation_id || relation.relation_id || orig.relation_id ||
    orig.record_id || record.record_id || ""
  );
}

function reviewKey(pmcid, record) {
  return `${String(pmcid)}::${sourceRecordId(record)}`;
}

function reviewStorageKey(manifest) {
  const run = ((manifest || {}).runs || [])[0] || {};
  return `${REVIEW_STORAGE_PREFIX}:${run.id || "candidate_b"}:${run.revision || "unknown"}`;
}

function normalizeReviewEntry(value) {
  const entry = value && typeof value === "object" ? value : {};
  const tripleReviewed = entry.triple_reviewed === true;
  const contextReviewed = entry.context_reviewed === true;
  return {
    paper_id: String(entry.paper_id || ""),
    triple_id: String(entry.triple_id || ""),
    source_record_id: String(entry.source_record_id || ""),
    triple_reviewed: tripleReviewed,
    triple_correct: tripleReviewed && entry.triple_correct === true,
    context_reviewed: contextReviewed,
    context_correct: contextReviewed && entry.context_correct === true,
    updated_at: String(entry.updated_at || ""),
  };
}

function reviewStats(judgments) {
  const entries = Object.values(judgments || {}).map(normalizeReviewEntry);
  return {
    reviewedTriples: entries.filter((entry) => entry.triple_reviewed).length,
    correctTriples: entries.filter((entry) => entry.triple_reviewed && entry.triple_correct).length,
    reviewedContexts: entries.filter((entry) => entry.context_reviewed).length,
    correctContexts: entries.filter((entry) => entry.context_reviewed && entry.context_correct).length,
  };
}

function judgmentLabel(reviewed, correct) {
  if (!reviewed) return "not_reviewed";
  return correct ? "correct" : "incorrect";
}

function tsvCell(value) {
  const text = String(value === null || value === undefined ? "" : value);
  if (!/[\t\r\n"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function reviewsToTsv(judgments) {
  const columns = [
    "paper_id", "triple_id", "source_record_id", "triple_judgment",
    "context_judgment", "triple_reviewed", "context_reviewed", "updated_at",
  ];
  const entries = Object.values(judgments || {})
    .map(normalizeReviewEntry)
    .filter((entry) => entry.triple_reviewed || entry.context_reviewed)
    .sort((a, b) =>
      a.paper_id.localeCompare(b.paper_id) ||
      a.triple_id.localeCompare(b.triple_id) ||
      a.source_record_id.localeCompare(b.source_record_id)
    );
  const rows = entries.map((entry) => [
    entry.paper_id,
    entry.triple_id,
    entry.source_record_id,
    judgmentLabel(entry.triple_reviewed, entry.triple_correct),
    judgmentLabel(entry.context_reviewed, entry.context_correct),
    String(entry.triple_reviewed),
    String(entry.context_reviewed),
    entry.updated_at,
  ].map(tsvCell).join("\t"));
  return `${columns.join("\t")}\n${rows.length ? `${rows.join("\n")}\n` : ""}`;
}

// Browser DOM rendering implementation
if (typeof window !== "undefined") {
  const state = createViewerState();
  state.judgments = {};
  state.reviewStorageKey = null;

  const el = {
    statPapersCount: document.getElementById("stat-papers-count"),
    statRunLabel: document.getElementById("stat-run-label"),
    statRecordsCount: document.getElementById("stat-records-count"),
    datasetRevisionText: document.getElementById("dataset-revision-text"),
    paperList: document.getElementById("paper-list"),
    searchInput: document.getElementById("search-input"),
    filterRelVerdict: document.getElementById("filter-relation-verdict"),
    filterCtxVerdict: document.getElementById("filter-context-verdict"),
    filterMergeDec: document.getElementById("filter-merge-decision"),
    btnResetFilters: document.getElementById("btn-reset-filters"),
    btnExportJson: document.getElementById("btn-export-json"),
    btnExportReviews: document.getElementById("btn-export-reviews"),
    statReviewedTriples: document.getElementById("stat-reviewed-triples"),
    statCorrectTriples: document.getElementById("stat-correct-triples"),
    statReviewedContexts: document.getElementById("stat-reviewed-contexts"),
    statCorrectContexts: document.getElementById("stat-correct-contexts"),
    reviewSaveStatus: document.getElementById("review-save-status"),
    currentPaperPmcid: document.getElementById("current-paper-pmcid"),
    displayedRecordsCount: document.getElementById("displayed-records-count"),
    paperTotalRecords: document.getElementById("paper-total-records"),
    paperMissingEvidenceCount: document.getElementById("paper-missing-evidence-count"),
    recordsContainer: document.getElementById("records-container"),
    btnPrevPage: document.getElementById("btn-prev-page"),
    btnNextPage: document.getElementById("btn-next-page"),
    paginationInfo: document.getElementById("pagination-info"),
  };

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  }

  function initApp() {
    fetchJson("data/manifest.json")
      .then((manifest) => {
        state.manifest = manifest;
        loadSavedReviews();
        renderHeaderStats(manifest);
        renderReviewStats();
        renderPaperSidebar(manifest.papers);
        if (manifest.papers.length > 0) {
          selectAndRenderPaper(manifest.papers[0].pmcid);
        }
      })
      .catch((err) => {
        el.recordsContainer.textContent = `Error loading manifest: ${err.message}`;
      });

    // Event listeners
    el.searchInput.addEventListener("input", (e) => {
      state.filters.search = e.target.value;
      state.pagination.page = 1;
      renderCurrentRecords();
    });

    el.filterRelVerdict.addEventListener("change", (e) => {
      state.filters.relationVerdict = e.target.value;
      state.pagination.page = 1;
      renderCurrentRecords();
    });

    el.filterCtxVerdict.addEventListener("change", (e) => {
      state.filters.contextVerdict = e.target.value;
      state.pagination.page = 1;
      renderCurrentRecords();
    });

    el.filterMergeDec.addEventListener("change", (e) => {
      state.filters.mergeDecision = e.target.value;
      state.pagination.page = 1;
      renderCurrentRecords();
    });

    el.btnResetFilters.addEventListener("click", () => {
      state.filters.search = "";
      state.filters.relationVerdict = "ALL";
      state.filters.contextVerdict = "ALL";
      state.filters.mergeDecision = "ALL";
      el.searchInput.value = "";
      el.filterRelVerdict.value = "ALL";
      el.filterCtxVerdict.value = "ALL";
      el.filterMergeDec.value = "ALL";
      state.pagination.page = 1;
      renderCurrentRecords();
    });

    el.btnExportJson.addEventListener("click", () => {
      if (!state.currentPaperData) return;
      const jsonStr = JSON.stringify(state.currentPaperData, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${state.currentPmcid || "paper"}_step620_records.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    el.btnExportReviews.addEventListener("click", () => {
      const tsv = reviewsToTsv(state.judgments);
      downloadBlob(tsv, "funcmap_manual_review.tsv", "text/tab-separated-values;charset=utf-8");
    });

    el.btnPrevPage.addEventListener("click", () => {
      if (state.pagination.page > 1) {
        state.pagination.page -= 1;
        renderCurrentRecords();
      }
    });

    el.btnNextPage.addEventListener("click", () => {
      if (state.pagination.page < state.pagination.totalPages) {
        state.pagination.page += 1;
        renderCurrentRecords();
      }
    });
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function loadSavedReviews() {
    state.reviewStorageKey = reviewStorageKey(state.manifest);
    try {
      const parsed = JSON.parse(window.localStorage.getItem(state.reviewStorageKey) || "{}");
      const source = parsed && typeof parsed.judgments === "object" ? parsed.judgments : {};
      state.judgments = Object.fromEntries(
        Object.entries(source).map(([key, value]) => [key, normalizeReviewEntry(value)])
      );
      el.reviewSaveStatus.textContent = "Reviews are saved in this browser.";
    } catch (error) {
      state.judgments = {};
      el.reviewSaveStatus.textContent = "Browser storage is unavailable; download the TSV before leaving.";
    }
  }

  function saveReviews() {
    try {
      window.localStorage.setItem(state.reviewStorageKey, JSON.stringify({
        schema_version: 1,
        judgments: state.judgments,
      }));
      el.reviewSaveStatus.textContent = "Saved in this browser.";
    } catch (error) {
      el.reviewSaveStatus.textContent = "Could not save locally; download the TSV now.";
    }
    renderReviewStats();
  }

  function renderReviewStats() {
    const stats = reviewStats(state.judgments);
    el.statReviewedTriples.textContent = String(stats.reviewedTriples);
    el.statCorrectTriples.textContent = String(stats.correctTriples);
    el.statReviewedContexts.textContent = String(stats.reviewedContexts);
    el.statCorrectContexts.textContent = String(stats.correctContexts);
  }

  function renderHeaderStats(manifest) {
    el.statPapersCount.textContent = String(manifest.papers.length);
    const runInfo = (manifest.runs && manifest.runs[0]) || {};
    el.statRunLabel.textContent = runInfo.label || runInfo.id || "Unknown";
    if (runInfo.revision) {
      el.datasetRevisionText.textContent = `Revision: ${runInfo.revision} (Step 620 Lossless Records)`;
    }
    const totalRecords = (manifest.sources || []).reduce((acc, s) => acc + (s.record_count || 0), 0);
    el.statRecordsCount.textContent = String(totalRecords);
  }

  function renderPaperSidebar(papers) {
    el.paperList.textContent = "";
    papers.forEach((p) => {
      const li = document.createElement("li");
      li.className = "paper-item";
      li.id = `paper-nav-${p.pmcid}`;
      li.setAttribute("role", "tab");
      li.setAttribute("tabindex", "0");
      li.setAttribute("aria-selected", "false");

      const spanId = document.createElement("span");
      spanId.className = "pmcid";
      spanId.textContent = p.pmcid;

      const sourceInfo = (state.manifest.sources || []).find((s) => s.pmcid === p.pmcid);
      const spanCount = document.createElement("span");
      spanCount.className = "rec-count";
      spanCount.textContent = `${sourceInfo ? sourceInfo.record_count : 0} recs`;

      li.appendChild(spanId);
      li.appendChild(spanCount);

      li.addEventListener("click", () => {
        selectAndRenderPaper(p.pmcid);
      });
      li.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectAndRenderPaper(p.pmcid);
        }
      });

      el.paperList.appendChild(li);
    });
  }

  async function selectAndRenderPaper(pmcid) {
    // Update active class in sidebar
    const allItems = el.paperList.querySelectorAll(".paper-item");
    allItems.forEach((item) => {
      item.classList.remove("active");
      item.setAttribute("aria-selected", "false");
    });
    const activeItem = document.getElementById(`paper-nav-${pmcid}`);
    if (activeItem) {
      activeItem.classList.add("active");
      activeItem.setAttribute("aria-selected", "true");
    }

    el.recordsContainer.textContent = "";
    const loader = document.createElement("div");
    loader.className = "loading-indicator";
    loader.textContent = `Loading extraction records for ${pmcid}...`;
    el.recordsContainer.appendChild(loader);

    const result = await loadPaper(state, pmcid, fetchJson);
    if (result.ignored) return; // Discard superseded request

    if (!result.success) {
      el.recordsContainer.textContent = "";
      const errBox = document.createElement("div");
      errBox.className = "empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "Error Loading Paper";
      const p = document.createElement("p");
      p.textContent = result.error;
      errBox.appendChild(h3);
      errBox.appendChild(p);
      el.recordsContainer.appendChild(errBox);
      return;
    }

    renderCurrentRecords();
  }

  function renderCurrentRecords() {
    el.currentPaperPmcid.textContent = state.currentPmcid || "None";
    if (!state.currentPaperData) return;

    const runs = (state.currentPaperData && state.currentPaperData.runs) || {};
    const runData = runs.candidate_b || Object.values(runs)[0] || {};
    const rawRecords = runData.records || [];
    const evidenceMap = runData.evidence || {};
    const passagesMap = runData.passages || {};

    const totalInPaper = rawRecords.length;
    el.paperTotalRecords.textContent = String(totalInPaper);

    // Count missing evidence references
    if (el.paperMissingEvidenceCount) {
      let missingEvidenceCount = 0;
      rawRecords.forEach((r) => {
        missingEvidenceCount += (r.missing_evidence_ids || []).length;
      });
      el.paperMissingEvidenceCount.textContent = String(missingEvidenceCount);
    }

    const filtered = filterRecords(rawRecords, state.filters);
    el.displayedRecordsCount.textContent = String(filtered.length);

    // Paginate
    const pageResult = paginateRecords(filtered, state.pagination.page, state.pagination.pageSize);
    state.pagination.page = pageResult.page;
    state.pagination.totalPages = pageResult.totalPages;

    el.paginationInfo.textContent = `Page ${pageResult.page} of ${pageResult.totalPages} (${filtered.length} total filtered)`;
    el.btnPrevPage.disabled = pageResult.page <= 1;
    el.btnNextPage.disabled = pageResult.page >= pageResult.totalPages;

    el.recordsContainer.textContent = "";

    // Empty state handling
    if (totalInPaper === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No Records in this Paper";
      const p = document.createElement("p");
      p.textContent = "No extraction records were generated for this paper in Step 620.";
      emptyDiv.appendChild(h3);
      emptyDiv.appendChild(p);
      el.recordsContainer.appendChild(emptyDiv);
      return;
    }

    if (filtered.length === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = "No Matching Records";
      const p = document.createElement("p");
      p.textContent = "No extraction records match your active filter and search criteria.";
      emptyDiv.appendChild(h3);
      emptyDiv.appendChild(p);
      el.recordsContainer.appendChild(emptyDiv);
      return;
    }

    // Render cards using textContent to guarantee complete XSS safety
    pageResult.items.forEach((rec, idx) => {
      const card = createRecordCard(rec, evidenceMap, passagesMap);
      el.recordsContainer.appendChild(card);
    });
  }

  function createRecordCard(rec, evidenceMap, passagesMap) {
    const orig = rec.source_record || {};
    const relObj = orig.relation || {};
    const relEval = orig.relation_evaluation || orig.relation_support_evaluation || {};
    const ctxEval = orig.context_evaluation || {};

    const card = document.createElement("article");
    card.className = "record-card";
    card.id = `card-${rec.record_id}`;

    // Header with Triple
    const header = document.createElement("div");
    header.className = "record-header";

    const tripleBox = document.createElement("div");
    tripleBox.className = "triple-box";

    // Subject
    const subNode = document.createElement("div");
    subNode.className = "triple-node";
    const subName = document.createElement("span");
    subName.className = "node-name";
    subName.textContent = orig.subject || relObj.subject || (orig.subject_entity && orig.subject_entity.name) || "Unknown Subject";
    const subType = document.createElement("span");
    subType.className = "node-type";
    subType.textContent = (orig.subject_entity && orig.subject_entity.type) || relObj.subject_type || "Entity";
    subNode.appendChild(subName);
    subNode.appendChild(subType);

    // Predicate
    const predSpan = document.createElement("span");
    predSpan.className = "triple-predicate";
    predSpan.textContent = orig.predicate || relObj.predicate || "related to";

    // Object
    const objNode = document.createElement("div");
    objNode.className = "triple-node";
    const objName = document.createElement("span");
    objName.className = "node-name";
    objName.textContent = orig.object || relObj.object || (orig.object_entity && orig.object_entity.name) || "Unknown Object";
    const objType = document.createElement("span");
    objType.className = "node-type";
    objType.textContent = (orig.object_entity && orig.object_entity.type) || relObj.object_type || "Entity";
    objNode.appendChild(objName);
    objNode.appendChild(objType);

    tripleBox.appendChild(subNode);
    tripleBox.appendChild(predSpan);
    tripleBox.appendChild(objNode);

    // Badges
    const badgesDiv = document.createElement("div");
    badgesDiv.className = "verdict-badges";

    // 1. Relation verdict badge
    const relVerdictRaw = String(relEval.verdict || "UNKNOWN").toLowerCase();
    const relBadge = document.createElement("span");
    const isRelSupp = relVerdictRaw.includes("support");
    const isRelContr = relVerdictRaw.includes("contradict");
    relBadge.className = `badge ${isRelSupp ? "badge-green" : isRelContr ? "badge-red" : "badge-yellow"}`;
    
    const relCat = document.createElement("span");
    relCat.className = "badge-category";
    relCat.textContent = "Relation:";
    const relVal = document.createElement("strong");
    relVal.className = "badge-value";
    relVal.textContent = isRelSupp ? (relVerdictRaw.includes("partially") ? "Partially Supported" : "Supported") : relVerdictRaw.toUpperCase();
    relBadge.appendChild(relCat);
    relBadge.appendChild(relVal);
    relBadge.title = isRelSupp
      ? "Relation Support: The paper evidence sentence directly validates this Subject-Predicate-Object statement."
      : "Relation Support: Evaluates whether paper text supports this relation triple.";
    badgesDiv.appendChild(relBadge);

    // 2. Context verdict badge
    const ctxVerdictRaw = String(ctxEval.verdict || "").toLowerCase();
    const ctxBadge = document.createElement("span");
    const ctxCat = document.createElement("span");
    ctxCat.className = "badge-category";
    ctxCat.textContent = "Context:";
    const ctxVal = document.createElement("strong");
    ctxVal.className = "badge-value";

    if (ctxVerdictRaw === "not_enough_evidence") {
      ctxBadge.className = "badge badge-red";
      ctxVal.textContent = "Not Enough Evidence";
      ctxBadge.title = "Context Evaluation: Insufficient evidence in the sentence text to validate proposed context attributes.";
    } else if (ctxVerdictRaw === "valid" || ctxVerdictRaw === "supported") {
      ctxBadge.className = "badge badge-green";
      ctxVal.textContent = "Valid";
      ctxBadge.title = "Context Evaluation: Sentence text directly validates the assigned context attributes.";
    } else if (ctxVerdictRaw === "partially_supported") {
      ctxBadge.className = "badge badge-purple";
      ctxVal.textContent = "Partially Supported";
      ctxBadge.title = "Context Evaluation: Some proposed context values were supported and the merge decision records whether they were corrected or dropped.";
    } else if (ctxVerdictRaw === "unsupported") {
      ctxBadge.className = "badge badge-red";
      ctxVal.textContent = "Unsupported";
      ctxBadge.title = "Context Evaluation: The proposed context was not supported by the evaluated evidence.";
    } else if (ctxVerdictRaw === "invalid" || ctxVerdictRaw === "contradicted") {
      ctxBadge.className = "badge badge-red";
      ctxVal.textContent = "Invalid";
      ctxBadge.title = "Context Evaluation: Proposed context contradicts or fails sentence evidence.";
    } else {
      ctxBadge.className = "badge badge-gray";
      ctxVal.textContent = "N/A (Baseline)";
      ctxBadge.title = "Context Evaluation: No new candidate context was assigned in Step 510; baseline preserved.";
    }
    ctxBadge.appendChild(ctxCat);
    ctxBadge.appendChild(ctxVal);
    badgesDiv.appendChild(ctxBadge);

    // 3. Merge decision badge
    const mergeDecRaw = String(orig.merge_decision || ctxEval.merge_decision || "").toLowerCase();
    const mergeBadge = document.createElement("span");
    const mergeCat = document.createElement("span");
    mergeCat.className = "badge-category";
    mergeCat.textContent = "Decision:";
    const mergeVal = document.createElement("strong");
    mergeVal.className = "badge-value";

    if (mergeDecRaw.includes("corrected")) {
      mergeBadge.className = "badge badge-purple";
      mergeVal.textContent = "Retained (Corrected)";
      mergeBadge.title = "Merge Decision: Candidate context was partially supported, corrected by evaluator, and retained.";
    } else if (mergeDecRaw === "610_supported" || (mergeDecRaw.includes("supported") && !mergeDecRaw.includes("dropped"))) {
      mergeBadge.className = "badge badge-green";
      mergeVal.textContent = "Retained (Supported)";
      mergeBadge.title = "Merge Decision: Candidate context was verified as supported by text evidence and retained.";
    } else if (mergeDecRaw.includes("dropped")) {
      mergeBadge.className = "badge badge-yellow";
      mergeVal.textContent = "Dropped New Context";
      mergeBadge.title = "Merge Decision: Step 610 dropped the unverified candidate context and preserved baseline context.";
    } else if (mergeDecRaw.includes("510_no_new_context") || mergeDecRaw.includes("baseline")) {
      mergeBadge.className = "badge badge-gray";
      mergeVal.textContent = "Baseline Retained";
      mergeBadge.title = "Merge Decision: Step 510 proposed no new context; baseline context remained unchanged.";
    } else if (mergeDecRaw.includes("retained") || mergeDecRaw.includes("merged")) {
      mergeBadge.className = "badge badge-green";
      mergeVal.textContent = "Retained";
      mergeBadge.title = "Merge Decision: Context passed evaluation and was retained/merged.";
    } else {
      mergeBadge.className = "badge badge-yellow";
      mergeVal.textContent = mergeDecRaw || "Retained";
      mergeBadge.title = `Merge Decision: ${mergeDecRaw}`;
    }
    mergeBadge.appendChild(mergeCat);
    mergeBadge.appendChild(mergeVal);
    badgesDiv.appendChild(mergeBadge);

    header.appendChild(tripleBox);
    header.appendChild(badgesDiv);
    card.appendChild(header);

    // Manual review controls are local annotations. They never alter the
    // pipeline output or its automated verdicts.
    const key = reviewKey(state.currentPmcid, rec);
    const saved = normalizeReviewEntry(state.judgments[key]);
    const reviewPanel = document.createElement("fieldset");
    reviewPanel.className = "manual-review-panel";
    const reviewLegend = document.createElement("legend");
    reviewLegend.textContent = "Manual confirmation";
    reviewPanel.appendChild(reviewLegend);

    const makeCheckbox = (name, labelText, checked) => {
      const label = document.createElement("label");
      label.className = "review-checkbox";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = `${name}-${rec.record_id}`;
      input.checked = checked;
      const textNode = document.createElement("span");
      textNode.textContent = labelText;
      label.appendChild(input);
      label.appendChild(textNode);
      return { label, input };
    };

    const tripleGroup = document.createElement("div");
    tripleGroup.className = "review-group";
    const tripleTitle = document.createElement("strong");
    tripleTitle.textContent = "Triple";
    const tripleReviewed = makeCheckbox("triple-reviewed", "Reviewed", saved.triple_reviewed);
    const tripleCorrect = makeCheckbox("triple-correct", "Correct", saved.triple_correct);
    tripleGroup.appendChild(tripleTitle);
    tripleGroup.appendChild(tripleReviewed.label);
    tripleGroup.appendChild(tripleCorrect.label);

    const contextGroup = document.createElement("div");
    contextGroup.className = "review-group";
    const contextTitle = document.createElement("strong");
    contextTitle.textContent = "Context";
    const contextReviewed = makeCheckbox("context-reviewed", "Reviewed", saved.context_reviewed);
    const contextCorrect = makeCheckbox("context-correct", "Correct", saved.context_correct);
    contextGroup.appendChild(contextTitle);
    contextGroup.appendChild(contextReviewed.label);
    contextGroup.appendChild(contextCorrect.label);

    const commitReview = () => {
      if (tripleCorrect.input.checked) tripleReviewed.input.checked = true;
      if (contextCorrect.input.checked) contextReviewed.input.checked = true;
      if (!tripleReviewed.input.checked) tripleCorrect.input.checked = false;
      if (!contextReviewed.input.checked) contextCorrect.input.checked = false;

      if (!tripleReviewed.input.checked && !contextReviewed.input.checked) {
        delete state.judgments[key];
      } else {
        state.judgments[key] = normalizeReviewEntry({
          paper_id: state.currentPmcid,
          triple_id: sourceTripleId(rec),
          source_record_id: sourceRecordId(rec),
          triple_reviewed: tripleReviewed.input.checked,
          triple_correct: tripleCorrect.input.checked,
          context_reviewed: contextReviewed.input.checked,
          context_correct: contextCorrect.input.checked,
          updated_at: new Date().toISOString(),
        });
      }
      card.classList.toggle("reviewed", tripleReviewed.input.checked || contextReviewed.input.checked);
      saveReviews();
    };

    [tripleReviewed.input, tripleCorrect.input, contextReviewed.input, contextCorrect.input]
      .forEach((input) => input.addEventListener("change", commitReview));
    card.classList.toggle("reviewed", saved.triple_reviewed || saved.context_reviewed);
    reviewPanel.appendChild(tripleGroup);
    reviewPanel.appendChild(contextGroup);
    card.appendChild(reviewPanel);

    // Context Section on Card
    const ctxCard = document.createElement("div");
    ctxCard.className = "record-context-card";

    // Row 1: Active Context (prioritize final_assigned_context, fallback to context)
    const activeRow = document.createElement("div");
    activeRow.className = "context-row";

    const activeHdr = document.createElement("span");
    activeHdr.className = "context-row-label";
    activeHdr.textContent = "Assigned Context:";
    activeRow.appendChild(activeHdr);

    const activeCtx = (orig.final_assigned_context && Object.keys(orig.final_assigned_context).length > 0)
      ? orig.final_assigned_context
      : (orig.context || {});
    const activeKeys = Object.keys(activeCtx);

    if (activeKeys.length > 0) {
      const chipsDiv = document.createElement("div");
      chipsDiv.className = "context-chips";
      activeKeys.forEach((k) => {
        const chip = document.createElement("span");
        chip.className = "context-chip";
        const kSpan = document.createElement("span");
        kSpan.className = "chip-key";
        kSpan.textContent = `${formatContextKey(k)}:`;
        const vSpan = document.createElement("span");
        vSpan.className = "chip-val";
        vSpan.textContent = formatContextValues(activeCtx[k]);
        chip.appendChild(kSpan);
        chip.appendChild(vSpan);
        chipsDiv.appendChild(chip);
      });
      activeRow.appendChild(chipsDiv);
    } else {
      const emptySpan = document.createElement("span");
      emptySpan.className = "context-empty";
      emptySpan.textContent = "None (no active biological context)";
      activeRow.appendChild(emptySpan);
    }
    ctxCard.appendChild(activeRow);

    // Row 2: Candidate Context (from Step 510, if present)
    const step5Ctx = orig.step5_assigned_context || {};
    const step5Keys = Object.keys(step5Ctx);

    if (step5Keys.length > 0) {
      const candRow = document.createElement("div");
      candRow.className = "context-row context-candidate-row";

      const candHdr = document.createElement("span");
      candHdr.className = "context-row-label context-candidate-label";
      candHdr.textContent = "Step 510 Candidate:";
      candRow.appendChild(candHdr);

      const candChips = document.createElement("div");
      candChips.className = "context-chips";
      step5Keys.forEach((k) => {
        const chip = document.createElement("span");
        chip.className = "context-chip chip-candidate";
        const kSpan = document.createElement("span");
        kSpan.className = "chip-key";
        kSpan.textContent = `${formatContextKey(k)}:`;
        const vSpan = document.createElement("span");
        vSpan.className = "chip-val";
        vSpan.textContent = formatContextValues(step5Ctx[k]);
        chip.appendChild(kSpan);
        chip.appendChild(vSpan);
        candChips.appendChild(chip);
      });
      candRow.appendChild(candChips);

      const statusTag = document.createElement("span");
      statusTag.className = "candidate-status-tag";
      if (mergeDecRaw.includes("drop")) {
        statusTag.textContent = "(Dropped in Step 610: unsupported / insufficient evidence)";
      } else if (mergeDecRaw.includes("correct")) {
        statusTag.textContent = "(Corrected and Retained in Step 620)";
      } else {
        statusTag.textContent = "(Retained in Step 620: supported)";
      }
      candRow.appendChild(statusTag);

      ctxCard.appendChild(candRow);
    }

    card.appendChild(ctxCard);

    // Evidence Block
    const evidenceIds = rec.evidence_ids || [];

    evidenceIds.forEach((eid) => {
      const sentObj = evidenceMap[eid] || {};
      const sentText = sentObj.text;

      const evidBox = document.createElement("div");
      evidBox.className = "evidence-block";

      const evidHdr = document.createElement("div");
      evidHdr.className = "evidence-header";
      evidHdr.textContent = `Evidence Reference: ${eid}`;
      evidBox.appendChild(evidHdr);

      if (sentText) {
        const evidTxt = document.createElement("div");
        evidTxt.className = "evidence-text";
        evidTxt.textContent = `“${sentText}”`;
        evidBox.appendChild(evidTxt);
      } else {
        const missingTxt = document.createElement("div");
        missingTxt.className = "evidence-missing";
        missingTxt.textContent = "Sentence text is not included in this bundle; this evidence reference is retained for traceability.";
        evidBox.appendChild(missingTxt);
      }

      card.appendChild(evidBox);
    });

    // Full source text is intentionally tucked into a collapsed drawer. It is
    // distinct from the pipeline's biological context assignment above.
    const passageId = rec.passage_id || orig.current_passage_id || orig.passage_id;
    const passage = passageId ? passagesMap[passageId] : null;
    if (passage) {
      const evidenceDetails = document.createElement("details");
      evidenceDetails.className = "details-drawer evidence-context-drawer";

      const evidenceSummary = document.createElement("summary");
      const passageSentenceIds = Array.isArray(passage.sentence_ids) ? passage.sentence_ids : [];
      evidenceSummary.textContent = `Source Context Passage (${passageId}; ${passageSentenceIds.length} sentences)`;
      evidenceDetails.appendChild(evidenceSummary);

      const passageMeta = document.createElement("div");
      passageMeta.className = "passage-meta";
      const metaParts = [];
      if (passage.section_type) metaParts.push(`Section: ${passage.section_type}`);
      if (passage.offset !== null && passage.offset !== undefined) metaParts.push(`Offset: ${passage.offset}`);
      passageMeta.textContent = metaParts.join(" · ");
      evidenceDetails.appendChild(passageMeta);

      const passageText = document.createElement("p");
      passageText.className = "passage-full-text";
      passageText.textContent = passage.text || "";
      evidenceDetails.appendChild(passageText);

      const sentenceHeading = document.createElement("div");
      sentenceHeading.className = "context-stage-title";
      sentenceHeading.textContent = "Ordered Source Sentences";
      evidenceDetails.appendChild(sentenceHeading);

      const sentenceList = document.createElement("ol");
      sentenceList.className = "passage-sentence-list";
      passageSentenceIds.forEach((sentenceId) => {
        const sentence = evidenceMap[sentenceId] || {};
        const item = document.createElement("li");
        const idNode = document.createElement("strong");
        idNode.textContent = sentenceId;
        const textNode = document.createElement("p");
        textNode.textContent = sentence.text || "(Sentence text unavailable)";
        item.appendChild(idNode);
        item.appendChild(textNode);
        sentenceList.appendChild(item);
      });
      evidenceDetails.appendChild(sentenceList);
      card.appendChild(evidenceDetails);
    }

    // Expandable details (Context stages and raw record)
    const details = document.createElement("details");
    details.className = "details-drawer";

    const summary = document.createElement("summary");
    summary.textContent = `Context Lineage & Raw Source Record (${orig.record_id || rec.record_id})`;
    details.appendChild(summary);

    // Context stages grid
    const ctxGrid = document.createElement("div");
    ctxGrid.className = "context-grid";

    const addStage = (title, data) => {
      const stageCard = document.createElement("div");
      stageCard.className = "context-stage-card";
      const stageHdr = document.createElement("div");
      stageHdr.className = "context-stage-title";
      stageHdr.textContent = title;
      const stageContent = document.createElement("pre");
      stageContent.style.whiteSpace = "pre-wrap";
      stageContent.style.fontSize = "0.75rem";
      stageContent.textContent = data ? JSON.stringify(data, null, 2) : "(None)";
      stageCard.appendChild(stageHdr);
      stageCard.appendChild(stageContent);
      ctxGrid.appendChild(stageCard);
    };

    addStage("1. Original Context", orig.original_context || ctxEval.original_context);
    addStage("2. Step 510 Assigned Context", orig.step5_assigned_context || ctxEval.assigned_context);
    addStage("3. Final Retained Context", orig.final_assigned_context || orig.context || ctxEval.final_context);
    if (orig.dropped_context || ctxEval.dropped_context) {
      addStage("4. Dropped Context", orig.dropped_context || ctxEval.dropped_context);
    }

    details.appendChild(ctxGrid);

    // Raw JSON representation
    const rawHdr = document.createElement("div");
    rawHdr.className = "context-stage-title";
    rawHdr.style.marginTop = "0.75rem";
    rawHdr.textContent = "Exact Step 620 Source Record";
    details.appendChild(rawHdr);

    const rawPre = document.createElement("pre");
    rawPre.className = "raw-json-block";
    rawPre.textContent = JSON.stringify(orig, null, 2);
    details.appendChild(rawPre);

    card.appendChild(details);

    return card;
  }

  // Initialize once DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
}

// Export for Node.js unit tests
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    createViewerState,
    filterRecords,
    paginateRecords,
    loadPaper,
    relationVerdictCategory,
    contextVerdictCategory,
    mergeDecisionCategory,
    sourceRecordId,
    sourceTripleId,
    reviewKey,
    reviewStorageKey,
    normalizeReviewEntry,
    reviewStats,
    judgmentLabel,
    reviewsToTsv,
  };
}
