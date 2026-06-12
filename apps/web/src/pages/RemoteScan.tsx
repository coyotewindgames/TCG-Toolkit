import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";

type ImportPhase = "idle" | "parsing" | "processing" | "saving" | "complete" | "error";
type SyncPhase = "idle" | "syncing" | "complete" | "error";

type ProgressState = {
  phase: ImportPhase | SyncPhase;
  completed: number;
  total: number;
  message: string;
};

type ErrorLog = {
  id: string;
  scope: "import" | "sync" | "inventory";
  message: string;
  detail: string;
  timestamp: string;
};

type InventoryItem = {
  id: string;
  name: string;
  quantity: number;
  priceProvided: string;
  setName: string;
  cardNumber: string;
  condition: string;
  source: "import" | "synced";
  syncStatus: "not_synced" | "synced" | "sync_failed";
  syncedAt?: string;
};

const INVENTORY_STORAGE_KEY = "remote-scan.inventory.v2";
const ERROR_LOG_CAP = 50;
const REQUEST_TIMEOUT_MS = 30000;
const IMPORT_PROGRESS_EVENT = "remote-scan:import-progress";
const SYNC_PROGRESS_EVENT = "remote-scan:sync-progress";

const IMPORT_ENDPOINTS = ["/api/inventory/import", "/api/inventory/bulk", "/api/inventory"];
const INVENTORY_READ_ENDPOINTS = ["/api/inventory", "/api/inventory/list"];
const TCG_SYNC_ENDPOINTS = ["/api/tcg/sync-item", "/api/tcg/sync"];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timeoutHandle);
        resolve(value);
      })
      .catch((error: unknown) => {
        window.clearTimeout(timeoutHandle);
        reject(error);
      });
  });
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  // RFC4180-style parser for commas and escaped quotes.
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      const nextChar = line[i + 1];
      if (inQuotes && nextChar === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseCsvText(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);
}

async function parseSpreadsheet(file: File): Promise<string[][]> {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (extension === "csv") {
    const text = await file.text();
    return parseCsvText(text);
  }

  if (extension === "xlsx" || extension === "xls") {
    const workbookModule = await import("xlsx");
    const arrayBuffer = await file.arrayBuffer();
    const workbook = workbookModule.read(arrayBuffer, {
      type: "array",
      raw: false,
      cellText: true,
    });

    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return [];
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const rows = workbookModule.utils.sheet_to_json<(string | number | boolean | null)[]>(worksheet, {
      header: 1,
      raw: false,
      defval: "",
    });

    return rows
      .map((row) => row.map((cell) => String(cell ?? "").trim()))
      .filter((row) => row.some((cell) => cell.length > 0));
  }

  throw new Error("Unsupported file type. Please import a CSV or XLSX file.");
}

function pickHeaderIndex(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const index = headers.indexOf(alias);
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

function toPositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function buildItemId(name: string, setName: string, cardNumber: string, quantity: number, index: number): string {
  const key = [name, setName, cardNumber, String(quantity), String(index)].join("|").toLowerCase();
  const bytes = new TextEncoder().encode(key);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `imp_${btoa(binary).replace(/=/g, "")}`;
}

function emitProgressEvent(eventName: string, payload: ProgressState): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail: payload,
    }),
  );
}

function safeErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function toInventoryItems(
  rows: string[][],
  onProgress: (completed: number, total: number, message: string) => void,
): Promise<InventoryItem[]> {
  if (rows.length < 2) {
    throw new Error("The file does not contain any data rows.");
  }

  const headers = rows[0].map((header) => normalizeHeader(header));

  const nameIndex = pickHeaderIndex(headers, ["name", "cardname", "card", "product", "title"]);
  const quantityIndex = pickHeaderIndex(headers, ["quantity", "qty", "count"]);
  const priceIndex = pickHeaderIndex(headers, ["price", "purchaseprice", "cost", "marketprice", "tcgprice"]);
  const setIndex = pickHeaderIndex(headers, ["set", "setname", "expansion"]);
  const cardNumberIndex = pickHeaderIndex(headers, ["number", "cardnumber", "collector", "collectornumber"]);
  const conditionIndex = pickHeaderIndex(headers, ["condition", "cardcondition", "grade"]);

  if (nameIndex < 0) {
    throw new Error("Could not find a card name column. Expected headers like Name, Card Name, or Product.");
  }

  const rawRows = rows
    .slice(1)
    .map((row) => row.map((cell) => String(cell ?? "").trim()))
    .filter((row) => row.some((cell) => cell.length > 0));

  const total = rawRows.length;
  if (total === 0) {
    throw new Error("No non-empty rows were found in the file.");
  }

  const items: InventoryItem[] = [];

  for (let i = 0; i < rawRows.length; i += 1) {
    const row = rawRows[i];
    const name = row[nameIndex] ?? "";

    if (!name) {
      onProgress(i + 1, total, `Skipping row ${i + 1}: missing card name`);
      continue;
    }

    const quantityRaw = quantityIndex >= 0 ? row[quantityIndex] ?? "" : "1";
    const quantity = toPositiveInteger(quantityRaw, 1);
    const priceProvided = priceIndex >= 0 ? String(row[priceIndex] ?? "").trim() : "";
    const setName = setIndex >= 0 ? String(row[setIndex] ?? "").trim() : "";
    const cardNumber = cardNumberIndex >= 0 ? String(row[cardNumberIndex] ?? "").trim() : "";
    const condition = conditionIndex >= 0 ? String(row[conditionIndex] ?? "").trim() : "";

    items.push({
      id: buildItemId(name, setName, cardNumber, quantity, i),
      name,
      quantity,
      priceProvided,
      setName,
      cardNumber,
      condition,
      source: "import",
      syncStatus: "not_synced",
    });

    onProgress(i + 1, total, `Processed ${i + 1}/${total}`);

    if ((i + 1) % 250 === 0) {
      await delay(0);
    }
  }

  return items;
}

function readStoredInventory(): InventoryItem[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(INVENTORY_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as InventoryItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredInventory(items: InventoryItem[]): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(items));
}

function mergeInventory(existing: InventoryItem[], imported: InventoryItem[]): InventoryItem[] {
  const byId = new Map<string, InventoryItem>();

  for (const item of existing) {
    byId.set(item.id, item);
  }

  for (const item of imported) {
    byId.set(item.id, item);
  }

  return Array.from(byId.values());
}

async function postJsonWithFallback(endpoints: string[], payload: unknown): Promise<Response> {
  let lastError: unknown = new Error("No endpoints configured");

  for (const endpoint of endpoints) {
    try {
      const response = await withTimeout(
        fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
        REQUEST_TIMEOUT_MS,
        `POST ${endpoint}`,
      );

      if (!response.ok) {
        lastError = new Error(`POST ${endpoint} failed: HTTP ${response.status}`);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function fetchInventoryWithFallback(): Promise<InventoryItem[] | null> {
  let lastError: unknown = null;

  for (const endpoint of INVENTORY_READ_ENDPOINTS) {
    try {
      const response = await withTimeout(fetch(endpoint), REQUEST_TIMEOUT_MS, `GET ${endpoint}`);
      if (!response.ok) {
        lastError = new Error(`GET ${endpoint} failed: HTTP ${response.status}`);
        continue;
      }

      const body = (await response.json()) as unknown;
      const candidates = Array.isArray(body)
        ? body
        : body && typeof body === "object" && Array.isArray((body as { items?: unknown[] }).items)
          ? ((body as { items: unknown[] }).items as unknown[])
          : [];

      const normalized = candidates
        .map((value, index) => {
          if (!value || typeof value !== "object") {
            return null;
          }

          const item = value as Record<string, unknown>;
          const name = String(item.name ?? item.cardName ?? "").trim();
          if (!name) {
            return null;
          }

          const quantity = toPositiveInteger(String(item.quantity ?? "1"), 1);
          const priceProvided = String(item.priceProvided ?? item.price ?? "").trim();

          return {
            id: String(item.id ?? buildItemId(name, String(item.setName ?? ""), String(item.cardNumber ?? ""), quantity, index)),
            name,
            quantity,
            priceProvided,
            setName: String(item.setName ?? "").trim(),
            cardNumber: String(item.cardNumber ?? "").trim(),
            condition: String(item.condition ?? "").trim(),
            source: (item.source === "synced" ? "synced" : "import") as "import" | "synced",
            syncStatus: (["not_synced", "synced", "sync_failed"].includes(String(item.syncStatus))
              ? String(item.syncStatus)
              : "not_synced") as "not_synced" | "synced" | "sync_failed",
            syncedAt: item.syncedAt ? String(item.syncedAt) : undefined,
          } as InventoryItem;
        })
        .filter((item): item is InventoryItem => item !== null);

      return normalized;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

function percent(completed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

export default function RemoteScan() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [isInventoryLoading, setIsInventoryLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [importProgress, setImportProgress] = useState<ProgressState>({
    phase: "idle",
    completed: 0,
    total: 0,
    message: "",
  });
  const [syncProgress, setSyncProgress] = useState<ProgressState>({
    phase: "idle",
    completed: 0,
    total: 0,
    message: "",
  });
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorLogs, setErrorLogs] = useState<ErrorLog[]>([]);

  const updateImportProgress = useCallback((next: ProgressState) => {
    setImportProgress(next);
    emitProgressEvent(IMPORT_PROGRESS_EVENT, next);
  }, []);

  const updateSyncProgress = useCallback((next: ProgressState) => {
    setSyncProgress(next);
    emitProgressEvent(SYNC_PROGRESS_EVENT, next);
  }, []);

  const pushError = useCallback((scope: ErrorLog["scope"], message: string, error: unknown) => {
    const entry: ErrorLog = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      scope,
      message,
      detail: safeErrorDetail(error),
      timestamp: new Date().toISOString(),
    };

    console.error(`[${scope}] ${message}`, error);

    setErrorLogs((previous) => [entry, ...previous].slice(0, ERROR_LOG_CAP));
    setStatusMessage(`${scope.toUpperCase()} ERROR: ${message}`);
  }, []);

  useEffect(() => {
    let isMounted = true;

    const hydrateInventory = async () => {
      setIsInventoryLoading(true);

      try {
        const fromStorage = readStoredInventory();
        if (isMounted && fromStorage.length > 0) {
          setInventory(fromStorage);
        }

        const fromApi = await fetchInventoryWithFallback();
        if (isMounted && fromApi && fromApi.length > 0) {
          setInventory(fromApi);
          writeStoredInventory(fromApi);
        }
      } catch (error) {
        if (isMounted) {
          pushError("inventory", "Failed to refresh inventory from API. Local cache is being used.", error);
        }
      } finally {
        if (isMounted) {
          setIsInventoryLoading(false);
        }
      }
    };

    void hydrateInventory();

    return () => {
      isMounted = false;
    };
  }, [pushError]);

  const handleFileSelection = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setStatusMessage("");
  }, []);

  const importPercent = useMemo(
    () => percent(importProgress.completed, importProgress.total),
    [importProgress.completed, importProgress.total],
  );

  const syncPercent = useMemo(
    () => percent(syncProgress.completed, syncProgress.total),
    [syncProgress.completed, syncProgress.total],
  );

  const handleImport = useCallback(async () => {
    if (!selectedFile) {
      setStatusMessage("Please choose a CSV or XLSX file before importing.");
      return;
    }

    const extension = selectedFile.name.split(".").pop()?.toLowerCase();
    if (!["csv", "xlsx", "xls"].includes(extension ?? "")) {
      setStatusMessage("Unsupported file type. Please choose a CSV or XLSX file.");
      return;
    }

    setIsImporting(true);
    setStatusMessage("");
    updateImportProgress({
      phase: "parsing",
      completed: 0,
      total: 1,
      message: "Parsing file...",
    });

    try {
      const rows = await parseSpreadsheet(selectedFile);

      updateImportProgress({
        phase: "processing",
        completed: 0,
        total: Math.max(rows.length - 1, 1),
        message: "Processing rows...",
      });

      const importedItems = await toInventoryItems(rows, (completed, total, message) => {
        updateImportProgress({
          phase: "processing",
          completed,
          total,
          message,
        });
      });

      updateImportProgress({
        phase: "saving",
        completed: importedItems.length,
        total: importedItems.length,
        message: "Saving inventory...",
      });

      const merged = mergeInventory(readStoredInventory(), importedItems);
      writeStoredInventory(merged);
      setInventory(merged);

      try {
        await postJsonWithFallback(IMPORT_ENDPOINTS, {
          items: importedItems,
          options: {
            skipTcgSync: true,
            preserveProvidedPrices: true,
          },
        });
      } catch (error) {
        pushError(
          "import",
          "Import finished locally but API persistence failed. Data is still available from local storage.",
          error,
        );
      }

      updateImportProgress({
        phase: "complete",
        completed: importedItems.length,
        total: importedItems.length,
        message: `Import complete: ${importedItems.length} rows processed.`,
      });
      setStatusMessage(`Imported ${importedItems.length} rows successfully.`);
    } catch (error) {
      pushError("import", "Import failed. Please verify the file format and required columns.", error);
      updateImportProgress({
        phase: "error",
        completed: 0,
        total: 0,
        message: "Import failed.",
      });
    } finally {
      setIsImporting(false);
    }
  }, [selectedFile, pushError, updateImportProgress]);

  const handleManualSync = useCallback(async () => {
    if (inventory.length === 0) {
      setStatusMessage("Nothing to sync. Import inventory first.");
      return;
    }

    setIsSyncing(true);
    setStatusMessage("");
    updateSyncProgress({
      phase: "syncing",
      completed: 0,
      total: inventory.length,
      message: "Starting TCG sync...",
    });

    const updated = [...inventory];
    let failures = 0;

    try {
      for (let i = 0; i < updated.length; i += 1) {
        const item = updated[i];

        updateSyncProgress({
          phase: "syncing",
          completed: i,
          total: updated.length,
          message: `Syncing ${i + 1}/${updated.length}: ${item.name}`,
        });

        try {
          await postJsonWithFallback(TCG_SYNC_ENDPOINTS, {
            item,
            options: {
              source: "manual",
            },
          });

          updated[i] = {
            ...item,
            source: "synced",
            syncStatus: "synced",
            syncedAt: new Date().toISOString(),
          };
        } catch (error) {
          failures += 1;
          updated[i] = {
            ...item,
            syncStatus: "sync_failed",
          };
          pushError("sync", `Failed to sync \"${item.name}\"`, error);
        }
      }

      setInventory(updated);
      writeStoredInventory(updated);

      updateSyncProgress({
        phase: failures > 0 ? "error" : "complete",
        completed: updated.length,
        total: updated.length,
        message:
          failures > 0
            ? `Sync complete with ${failures} failed item(s).`
            : `Sync complete: ${updated.length} item(s) synced successfully.`,
      });

      if (failures > 0) {
        setStatusMessage(`Manual TCG sync finished with ${failures} failure(s). Check error logs below.`);
      } else {
        setStatusMessage(`Manual TCG sync completed for ${updated.length} item(s).`);
      }
    } finally {
      setIsSyncing(false);
    }
  }, [inventory, pushError, updateSyncProgress]);

  return (
    <div className="remote-scan-page" style={{ padding: 16, display: "grid", gap: 16 }}>
      <section style={{ display: "grid", gap: 8 }}>
        <h1>Remote Import</h1>
        <p>Import CSV/XLSX inventory with file-provided prices, then run manual TCG sync only when needed.</p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFileSelection}
            disabled={isImporting || isSyncing}
            aria-label="Choose CSV or XLSX file"
          />

          <button type="button" onClick={handleImport} disabled={!selectedFile || isImporting || isSyncing}>
            {isImporting ? "Importing..." : "Import CSV/XLSX"}
          </button>

          <button type="button" onClick={handleManualSync} disabled={inventory.length === 0 || isImporting || isSyncing}>
            {isSyncing ? "Syncing..." : "Manual TCG Sync"}
          </button>
        </div>

        {statusMessage ? (
          <div role="status" aria-live="polite" style={{ padding: 8, border: "1px solid #999", borderRadius: 4 }}>
            {statusMessage}
          </div>
        ) : null}
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Import Progress</h2>
        <div>{importProgress.message || "Idle"}</div>
        <progress value={importProgress.completed} max={Math.max(importProgress.total, 1)} style={{ width: "100%" }} />
        <div>
          {importProgress.completed}/{importProgress.total} ({importPercent}%)
        </div>
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Manual TCG Sync Progress</h2>
        <div>{syncProgress.message || "Idle"}</div>
        <progress value={syncProgress.completed} max={Math.max(syncProgress.total, 1)} style={{ width: "100%" }} />
        <div>
          {syncProgress.completed}/{syncProgress.total} ({syncPercent}%)
        </div>
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Inventory ({inventory.length})</h2>
        {isInventoryLoading ? <div>Loading inventory...</div> : null}

        {inventory.length === 0 ? (
          <div>No inventory loaded.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Card</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Set</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>No.</th>
                  <th style={{ textAlign: "right", borderBottom: "1px solid #ccc" }}>Qty</th>
                  <th style={{ textAlign: "right", borderBottom: "1px solid #ccc" }}>Price (from file)</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Sync</th>
                </tr>
              </thead>
              <tbody>
                {inventory.map((item) => (
                  <tr key={item.id}>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0" }}>{item.name}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0" }}>{item.setName || "-"}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0" }}>{item.cardNumber || "-"}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0", textAlign: "right" }}>{item.quantity}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0", textAlign: "right" }}>
                      {item.priceProvided || "-"}
                    </td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0" }}>
                      {item.syncStatus}
                      {item.syncedAt ? ` (${new Date(item.syncedAt).toLocaleString()})` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Error Logs</h2>
        {errorLogs.length === 0 ? (
          <div>No errors logged.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Time</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Scope</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Message</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {errorLogs.map((log) => (
                  <tr key={log.id}>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0" }}>{new Date(log.timestamp).toLocaleString()}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0" }}>{log.scope}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0" }}>{log.message}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: "4px 0", whiteSpace: "pre-wrap" }}>{log.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}