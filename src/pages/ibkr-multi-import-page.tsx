import { Card, Page, PageContent, PageHeader } from "@wealthfolio/ui";
import type { Account, AddonContext, ActivityImport } from "@wealthfolio/addon-sdk";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { debug } from "../lib/debug-logger";
import { getErrorMessage } from "../lib/shared-utils";
import { detectCurrenciesFromIBKR } from "../lib/currency-detector";
import { generateAccountNames } from "../lib/account-name-generator";
import { fetchFlexQuery, setHttpClient, validateFlexToken, validateQueryId } from "../lib/flex-query-fetcher";
import { parseFlexQueryCSV } from "../lib/flex-csv-parser";
import {
  refreshAndUpdateAccountPreviews,
  processAndResolveData,
  fetchExistingActivitiesForDedup,
  deduplicateActivities,
  groupActivitiesByCurrency,
  createTransactionGroups,
} from "../lib/import-orchestrator";
import StepIndicator from "../components/step-indicator";
import { useMultiCsvParser } from "../hooks/use-multi-csv-parser";
import { IBKRSourceSelectionStep, DataSource } from "../components/ibkr-source-selection-step";
import { IBKRCurrencyPreviewStep } from "../components/ibkr-currency-preview-step";
import { IBKRTickerPreviewStep } from "../components/ibkr-ticker-preview-step";
import { IBKRImportResultsStep } from "../components/ibkr-import-results-step";
import { CsvRowData } from "../presets/types";
import type { AccountPreview, TransactionGroup, ImportResult, ProgressInfo } from "../types";

// Secret keys for stored credentials
const SECRET_FLEX_TOKEN = "flex_token";
const SECRET_QUERY_ID = "flex_query_id";

const STEPS = [
  { id: 1, title: "Source & Group" },
  { id: 2, title: "Currency Accounts" },
  { id: 3, title: "Transaction Preview" },
  { id: 4, title: "Import Results" },
];

interface IBKRMultiImportPageProps {
  ctx?: AddonContext;
}

const IBKRMultiImportPage: React.FC<IBKRMultiImportPageProps> = ({ ctx }) => {
  const [currentStep, setCurrentStep] = useState(1);
  const [accounts, setAccounts] = useState<Account[]>([]);

  // Step 1: Source selection state
  const [groupName, setGroupName] = useState("");
  const [dataSource, setDataSource] = useState<DataSource>("manual");
  const [flexToken, setFlexToken] = useState("");
  const [flexQueryId, setFlexQueryId] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [rememberCredentials, setRememberCredentials] = useState(true);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");

  // Parsed data (unified from both sources)
  const [parsedData, setParsedData] = useState<CsvRowData[]>([]);

  // CSV Parser hook (for manual uploads)
  const {
    data: manualParsedData,
    errors: parsingErrors,
    isParsing,
    parseMultipleCsvFiles,
    resetParserStates,
  } = useMultiCsvParser();

  // Step 2 state
  const [accountPreviews, setAccountPreviews] = useState<AccountPreview[]>([]);

  // Step 3 state
  const [isResolving, setIsResolving] = useState(false);
  const [resolutionProgress, setResolutionProgress] = useState<ProgressInfo | undefined>();
  const [transactionGroups, setTransactionGroups] = useState<TransactionGroup[]>([]);

  // Step 4 state
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ProgressInfo | undefined>();
  const [importResults, setImportResults] = useState<ImportResult[]>([]);

  // Track if component is mounted (for async operation cleanup)
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // AbortController for cancelling in-progress operations on reset
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize HTTP client
  useEffect(() => {
    if (ctx?.api?.http) {
      setHttpClient(ctx.api.network);
    }
  }, [ctx]);

  // Load accounts and saved credentials
  useEffect(() => {
    const loadData = async () => {
      if (!ctx?.api) return;

      // Load accounts
      if (ctx.api.accounts) {
        try {
          const allAccounts = await ctx.api.accounts.getAll();
          if (!isMountedRef.current) return;
          setAccounts(allAccounts);
        } catch (e) {
          debug.error("Failed to load accounts:", e);
        }
      }

      // Load saved credentials
      if (ctx.api.secrets) {
        try {
          const [savedToken, savedQueryId] = await Promise.all([
            ctx.api.secrets.get(SECRET_FLEX_TOKEN),
            ctx.api.secrets.get(SECRET_QUERY_ID),
          ]);
          if (!isMountedRef.current) return;
          if (savedToken) setFlexToken(savedToken);
          if (savedQueryId) setFlexQueryId(savedQueryId);
        } catch (e) {
          debug.error("Failed to load saved credentials:", e);
        }
      }
    };

    loadData();
  }, [ctx]);

  // Get unique groups from accounts (memoized to avoid recalculation on every render)
  const existingGroups = useMemo(
    () => [...new Set(accounts.map((a) => a.group).filter(Boolean))] as string[],
    [accounts]
  );

  // Refresh accounts list from API
  const refreshAccounts = async () => {
    if (ctx?.api?.accounts) {
      try {
        const allAccounts = await ctx.api.accounts.getAll();
        if (!isMountedRef.current) return;
        setAccounts(allAccounts);
      } catch (e) {
        debug.error("Failed to refresh accounts:", e);
      }
    }
  };

  // Reset the entire import process
  const resetImportProcess = async () => {
    // Cancel any in-progress async operations
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Reset loading states first
    setIsLoadingData(false);
    setIsResolving(false);
    setIsImporting(false);

    // Refresh accounts to pick up any newly created accounts from previous import
    await refreshAccounts();

    setCurrentStep(1);
    setGroupName("");
    setSelectedFiles([]);
    setParsedData([]);
    setAccountPreviews([]);
    setTransactionGroups([]);
    setImportResults([]);
    setLoadingMessage("");
    setResolutionProgress(undefined);
    setImportProgress(undefined);
    resetParserStates();
  };

  // Process parsed data and advance to step 2 (memoized to prevent stale closures)
  const processDataToStep2 = useCallback((data: CsvRowData[]) => {
    const currencies = detectCurrenciesFromIBKR(data);
    const accountNames = generateAccountNames(groupName, currencies);

    const transactionCounts = new Map<string, number>();
    data.forEach((row) => {
      const currency = row.CurrencyPrimary;
      if (currency) {
        transactionCounts.set(currency, (transactionCounts.get(currency) || 0) + 1);
      }
    });

    const previews = accountNames.map((acc) => {
      const existingAccount = accounts.find(
        (a) => a.name === acc.name && a.currency === acc.currency
      );
      return {
        ...acc,
        transactionCount: transactionCounts.get(acc.currency) || 0,
        existingAccount,
      };
    });

    setAccountPreviews(previews);
    setIsLoadingData(false);
    setLoadingMessage("");
    setCurrentStep(2);
  }, [groupName, accounts]);

  // Step 1: Load data from selected source (memoized to ensure stable reference)
  const handleLoadData = useCallback(async () => {
    setIsLoadingData(true);

    try {
      if (dataSource === "flexquery") {
        // Fetch from Flex Query API
        setLoadingMessage("Connecting to IBKR...");

        const result = await fetchFlexQuery(
          { token: flexToken, queryId: flexQueryId },
          {
            onProgress: (msg) => {
              if (isMountedRef.current) setLoadingMessage(msg);
            },
          }
        );

        // Check if still mounted after async operation
        if (!isMountedRef.current) return;

        if (!result.success || !result.csv) {
          throw new Error(result.error || "Failed to fetch data from IBKR");
        }

        // Save credentials if requested (with validation)
        if (rememberCredentials && ctx?.api?.secrets) {
          const tokenValidation = validateFlexToken(flexToken);
          const queryIdValidation = validateQueryId(flexQueryId);

          if (tokenValidation.valid && queryIdValidation.valid) {
            await Promise.all([
              ctx.api.secrets.set(SECRET_FLEX_TOKEN, flexToken.trim()),
              ctx.api.secrets.set(SECRET_QUERY_ID, flexQueryId.trim()),
            ]);
          } else {
            // Log validation failures but don't block the import
            debug.warn("Credential validation failed, not saving:", {
              tokenError: tokenValidation.error,
              queryIdError: queryIdValidation.error,
            });
          }
        }

        // Check if still mounted before state updates
        if (!isMountedRef.current) return;

        // Parse the fetched CSV
        setLoadingMessage("Parsing transactions...");
        const parsed = parseFlexQueryCSV(result.csv);

        if (parsed.errors.length > 0) {
          debug.warn("Parse warnings:", parsed.errors);
        }

        setParsedData(parsed.rows);
        setLoadingMessage("");
        processDataToStep2(parsed.rows);

      } else {
        // Parse manual CSV files
        setLoadingMessage("Parsing CSV files...");
        await parseMultipleCsvFiles(selectedFiles);
        // The useEffect below will handle advancing to step 2
      }
    } catch (error) {
      debug.error("Error loading data:", error);
      // Only update state if still mounted
      if (!isMountedRef.current) return;
      const errorMessage = error instanceof Error ? error.message : "Failed to load data";
      // Reset loading state first, then set error message to prevent race condition
      setIsLoadingData(false);
      setLoadingMessage(`Error: ${errorMessage}`);
    }
  }, [dataSource, flexToken, flexQueryId, rememberCredentials, ctx, selectedFiles, processDataToStep2, parseMultipleCsvFiles]);

  // Process manual CSV data when it's ready
  useEffect(() => {
    if (manualParsedData && manualParsedData.length > 0 && currentStep === 1 && !isParsing && dataSource === "manual") {
      setParsedData(manualParsedData);
      processDataToStep2(manualParsedData);
    }
  }, [manualParsedData, isParsing, currentStep, dataSource, processDataToStep2]);

  // Step 2: Update account preview (memoized to prevent child re-renders)
  const handleAccountPreviewChange = useCallback((index: number, name: string) => {
    setAccountPreviews((prevPreviews) => {
      const newPreviews = [...prevPreviews];
      newPreviews[index].name = name;
      return newPreviews;
    });
  }, []);

  // Step 2 → Step 3: Process and resolve tickers
  const handleProceedToStep3 = async () => {
    setIsResolving(true);
    setCurrentStep(3);

    const errors: string[] = [];
    let updatedPreviews = accountPreviews;
    let activitiesWithFX: ActivityImport[] = [];

    // 1. Refresh accounts and update previews
    try {
      const result = await refreshAndUpdateAccountPreviews(
        ctx?.api?.accounts,
        accountPreviews,
        accounts
      );
      // Check if still mounted after async operation
      if (!isMountedRef.current) return;
      setAccounts(result.freshAccounts);
      updatedPreviews = result.updatedPreviews;
      setAccountPreviews(updatedPreviews);
    } catch (error) {
      if (!isMountedRef.current) return;
      const msg = `Failed to refresh accounts: ${getErrorMessage(error)}`;
      debug.error(msg);
      errors.push(msg);
      // Continue with existing accounts - non-fatal
    }

    // 2. Process data, resolve tickers, convert to activities
    try {
      const processResult = await processAndResolveData(
        parsedData,
        updatedPreviews,
        ctx?.api?.market?.searchTicker,
        (current, total) => {
          if (isMountedRef.current) setResolutionProgress({ current, total });
        }
      );
      // Check if still mounted after async operation
      if (!isMountedRef.current) return;
      activitiesWithFX = processResult.activities;

      // Log conversion errors for user visibility
      if (processResult.conversionErrors.length > 0) {
        const errorSummary = `${processResult.conversionErrors.length} transaction(s) failed to convert`;
        debug.warn(errorSummary, processResult.conversionErrors);
        errors.push(errorSummary);
      }
      if (processResult.skippedCount > 0) {
        debug.log(`Skipped ${processResult.skippedCount} unrecognized transaction types`);
      }
      // Warn user about skipped FX conversions (missing accounts, invalid format, etc.)
      if (processResult.skippedFXConversions.length > 0) {
        const fxSummary = `${processResult.skippedFXConversions.length} FX conversion(s) skipped`;
        debug.warn(fxSummary, processResult.skippedFXConversions);
        errors.push(fxSummary);
      }
    } catch (error) {
      if (!isMountedRef.current) return;
      const msg = `Failed to process transactions: ${getErrorMessage(error)}`;
      debug.error(msg);
      errors.push(msg);
      // This is fatal - cannot continue without activities
      setResolutionProgress(undefined);
      setIsResolving(false);
      return;
    }

    // 3. Fetch existing activities for deduplication
    let existingActivities: import("../types").ActivityFingerprint[] = [];
    try {
      const fetchResult = await fetchExistingActivitiesForDedup(
        ctx?.api?.activities,
        updatedPreviews
      );
      // Check if still mounted after async operation
      if (!isMountedRef.current) return;
      existingActivities = fetchResult.activities;
      if (!fetchResult.complete) {
        const msg = `Could not load activities from ${fetchResult.failedAccounts.length} account(s): ${fetchResult.failedAccounts.join(", ")}. Duplicates may occur for these accounts.`;
        debug.warn(msg);
        errors.push(msg);
      }
    } catch (error) {
      if (!isMountedRef.current) return;
      const msg = `Failed to fetch existing activities for deduplication: ${getErrorMessage(error)}`;
      debug.warn(msg);
      errors.push(msg);
      // Continue without deduplication - non-fatal but may create duplicates
    }

    // Check mounted state before final state updates
    if (!isMountedRef.current) return;

    // 4. Deduplicate activities
    let dedupedActivities = activitiesWithFX;
    try {
      dedupedActivities = deduplicateActivities(activitiesWithFX, existingActivities);
    } catch (error) {
      const msg = `Deduplication failed, proceeding without: ${getErrorMessage(error)}`;
      debug.warn(msg);
      errors.push(msg);
      // Continue with original activities - non-fatal but may create duplicates
    }

    // 5. Group by currency and create transaction groups
    try {
      const groupedByCurrency = groupActivitiesByCurrency(dedupedActivities);
      const groups = createTransactionGroups(updatedPreviews, groupedByCurrency);
      setTransactionGroups(groups);
    } catch (error) {
      const msg = `Failed to group transactions: ${getErrorMessage(error)}`;
      debug.error(msg);
      errors.push(msg);
    }

    // Log any accumulated warnings
    if (errors.length > 0) {
      debug.warn(`Import preparation completed with ${errors.length} warning(s):`, errors);
    }

    setResolutionProgress(undefined);
    setIsResolving(false);
  };

  // Step 3 → Step 4: Import transactions
  const handleStartImport = async () => {
    if (!ctx?.api) {
      debug.error("No ctx.api available - cannot import!");
      return;
    }

    setIsImporting(true);
    setCurrentStep(4);

    const results: ImportResult[] = [];
    let currentProgress = 0;
    const totalSteps = accountPreviews.length + transactionGroups.length;

    // Track created/existing accounts by currency (avoid mutating state directly)
    const accountsByCurrency = new Map<string, Account>();

    // Initialize with existing accounts from previews
    for (const preview of accountPreviews) {
      if (preview.existingAccount) {
        accountsByCurrency.set(preview.currency, preview.existingAccount);
      }
    }

    try {
      // Create accounts that don't exist yet
      for (const preview of accountPreviews) {
        // Check if still mounted before each iteration
        if (!isMountedRef.current) return;

        if (!preview.existingAccount) {
          setImportProgress({
            current: ++currentProgress,
            total: totalSteps,
            message: `Creating account: ${preview.name}`,
          });

          try {
            const newAccount = await ctx.api.accounts.create({
              name: preview.name,
              currency: preview.currency,
              group: preview.group,
              accountType: "SECURITIES",
              isDefault: false,
              isActive: true,
            });
            // Track in local map instead of mutating state
            accountsByCurrency.set(preview.currency, newAccount);
          } catch (error) {
            debug.error(`Failed to create account ${preview.name}:`, error);
          }
        } else {
          currentProgress++;
        }
      }

      // Pre-create any additional accounts needed for transaction currencies
      // This prevents race conditions during the import phase
      const allCurrenciesNeeded = new Set<string>();
      for (const group of transactionGroups) {
        for (const txn of group.transactions) {
          const txnCurrency = txn.currency || group.currency;
          allCurrenciesNeeded.add(txnCurrency);
        }
      }

      // Create any missing accounts before starting imports
      for (const currency of allCurrenciesNeeded) {
        if (!isMountedRef.current) return;
        if (!accountsByCurrency.has(currency)) {
          try {
            const newAccountName = `${groupName} - ${currency}`;
            const newAccount = await ctx.api.accounts.create({
              name: newAccountName,
              currency: currency,
              group: groupName,
              accountType: "SECURITIES",
              isDefault: false,
              isActive: true,
            });
            accountsByCurrency.set(currency, newAccount);
            debug.log(`Pre-created account for currency: ${currency}`);
          } catch (error) {
            debug.error(`Failed to pre-create account for ${currency}:`, error);
            // Continue - will fail during import if account truly doesn't exist
          }
        }
      }

      // Import transactions (all accounts should now exist)
      for (const group of transactionGroups) {
        // Check if still mounted before each iteration
        if (!isMountedRef.current) return;

        setImportProgress({
          current: ++currentProgress,
          total: totalSteps,
          message: `Importing ${group.transactions.length} transactions to ${group.accountName}`,
        });

        // Track totals for this group (including partial success)
        let groupTotalImported = 0;
        let groupTotalFailed = 0;
        const groupErrors: string[] = [];

        try {
          // Group transactions by their actual currency
          const transactionsByCurrency = new Map<string, ActivityImport[]>();
          for (const txn of group.transactions) {
            const txnCurrency = txn.currency || group.currency;
            let currencyGroup = transactionsByCurrency.get(txnCurrency);
            if (!currencyGroup) {
              currencyGroup = [];
              transactionsByCurrency.set(txnCurrency, currencyGroup);
            }
            currencyGroup.push(txn);
          }

          // Import transactions grouped by their actual currency
          for (const [txnCurrency, transactions] of transactionsByCurrency) {
            const targetAccount = accountsByCurrency.get(txnCurrency);

            if (!targetAccount) {
              // Account creation failed earlier - skip these transactions
              groupTotalFailed += transactions.length;
              groupErrors.push(`No account available for currency ${txnCurrency}`);
              continue;
            }

            // Set accountId on each transaction and import directly
            // (deduplication already happened in Step 3)
            const accountId = targetAccount.id;
            const transactionsWithAccountId = transactions.map((txn) => ({
              ...txn,
              accountId,
            }));

            if (transactionsWithAccountId.length > 0) {
              try {
                const activitiesApi = ctx.api.activities;
                const importResult = await activitiesApi["import"](transactionsWithAccountId);
                groupTotalImported += transactionsWithAccountId.length;

                // Link FOREX transfer pairs using trade ID from comment
                // Comment format: FX:EUR.USD:20260930:1599209942
                try {
                  const importedActivities = importResult?.activities || [];
                  ctx.api.logger.info(`[IBKR DEBUG] importedActivities count: ${importedActivities.length}, sample: ${JSON.stringify(importedActivities.slice(0,2))}`);
                  const fxActivities = importedActivities.filter((a: any) =>
                    a?.comment?.startsWith("FX:") && a?.id &&
                    (a?.activityType === "TRANSFER_IN" || a?.activityType === "TRANSFER_OUT")
                  );

                  // Group by trade ID (last segment of comment)
                  const byTradeId = new Map<string, any[]>();
                  for (const activity of fxActivities) {
                    const parts = activity.comment.split(":");
                    const tradeId = parts[parts.length - 1];
                    if (!byTradeId.has(tradeId)) byTradeId.set(tradeId, []);
                    byTradeId.get(tradeId)!.push(activity);
                  }

                  // Link pairs
                  for (const [tradeId, pair] of byTradeId) {
                    if (pair.length === 2 && pair[0].id && pair[1].id) {
                      try {
                        await ctx.api.activities.linkTransfer(pair[0].id, pair[1].id);
                        ctx.api.logger.info(`[IBKR] Linked FX transfer pair: ${tradeId}`);
                      } catch (linkError) {
                        ctx.api.logger.warn(`[IBKR] Failed to link FX pair ${tradeId}: ${linkError}`);
                      }
                    }
                  }
                } catch (linkingError) {
                  ctx.api.logger.warn(`[IBKR] Transfer linking failed: ${linkingError}`);
                }
              } catch (importError) {
                groupTotalFailed += transactionsWithAccountId.length;
                groupErrors.push(`Import failed for ${txnCurrency}: ${getErrorMessage(importError)}`);
              }
            }
          }

          results.push({
            accountId: accountsByCurrency.get(group.currency)?.id || "",
            accountName: group.accountName,
            currency: group.currency,
            success: groupTotalImported,
            failed: groupTotalFailed,
            skipped: 0, // Duplicates already removed in Step 3
            errors: groupErrors,
          });
        } catch (error) {
          const errorMessage = getErrorMessage(error);

          results.push({
            accountId: accountsByCurrency.get(group.currency)?.id || "",
            accountName: group.accountName,
            currency: group.currency,
            success: groupTotalImported, // Reflect partial success
            failed: group.transactions.length - groupTotalImported,
            skipped: 0,
            errors: [...groupErrors, errorMessage],
          });
        }
      }

      // Check if still mounted before final state updates
      if (!isMountedRef.current) return;
      
          // Link FOREX transfer pairs after all imports complete
          try {
            ctx.api.logger.info("[IBKR] Starting FOREX transfer linking...");
            const allAccounts = await ctx.api.accounts.getAll();
            const ibkrAccounts = allAccounts.filter((a: any) => a.group === groupName);
            
            // Fetch all transfer activities from all IBKR accounts
            const allTransfers: any[] = [];
            for (const account of ibkrAccounts) {
              try {
                const activities = await ctx.api.activities.getAll(account.id);
                const transfers = activities.filter((a: any) => 
                  (a.activityType === "TRANSFER_IN" || a.activityType === "TRANSFER_OUT") &&
                  a.comment?.startsWith("FX:") &&
                  a.id
                );
                allTransfers.push(...transfers);
              } catch (e) {
                ctx.api.logger.warn(`[IBKR] Could not fetch activities for account ${account.id}: ${e}`);
              }
            }

            ctx.api.logger.info(`[IBKR] Found ${allTransfers.length} FX transfer activities to link`);

            // Group by trade ID (last segment of comment: FX:EUR.USD:20260930:1599209942)
            const byTradeId = new Map<string, any[]>();
            for (const activity of allTransfers) {
              const parts = activity.comment.split(":");
              const tradeId = parts[parts.length - 1];
              if (!byTradeId.has(tradeId)) byTradeId.set(tradeId, []);
              byTradeId.get(tradeId)!.push(activity);
            }

            // Link pairs
            let linkedCount = 0;
            let skippedCount = 0;
            for (const [tradeId, pair] of byTradeId) {
              if (pair.length === 2 && pair[0].id && pair[1].id) {
                // Skip if already linked
                if (pair[0].linkedTransferId || pair[1].linkedTransferId) {
                  skippedCount++;
                  continue;
                }
                try {
                  await ctx.api.activities.linkTransfer(pair[0].id, pair[1].id);
                  linkedCount++;
                } catch (linkError) {
                  ctx.api.logger.warn(`[IBKR] Failed to link FX pair ${tradeId}: ${linkError}`);
                }
              }
            }
            ctx.api.logger.info(`[IBKR] Linked ${linkedCount} FX transfer pairs, skipped ${skippedCount} already linked`);
          } catch (linkingError) {
            ctx.api.logger.warn(`[IBKR] Transfer linking failed: ${linkingError}`);
          }

        setImportResults(results);
      setImportProgress(undefined);
      setIsImporting(false);
    } catch (error) {
      debug.error("Import failed:", error);
      if (!isMountedRef.current) return;
      setImportProgress(undefined);
      setIsImporting(false);
    }
  };

  // Navigation (memoized to prevent child re-renders)
  const goToPreviousStep = useCallback(() => {
    setCurrentStep((prev) => (prev > 1 ? prev - 1 : prev));
  }, []);

  // Render current step
  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <IBKRSourceSelectionStep
            accountGroup={{
              groupName,
              setGroupName,
              existingGroups,
            }}
            dataSource={dataSource}
            setDataSource={setDataSource}
            flexQuery={{
              token: flexToken,
              setToken: setFlexToken,
              queryId: flexQueryId,
              setQueryId: setFlexQueryId,
              showToken,
              setShowToken,
              rememberCredentials,
              setRememberCredentials,
            }}
            csvFiles={{
              files: selectedFiles,
              setFiles: setSelectedFiles,
            }}
            isLoading={isLoadingData || isParsing}
            onNext={handleLoadData}
          />
        );
      case 2:
        return (
          <IBKRCurrencyPreviewStep
            accountPreviews={accountPreviews}
            onAccountPreviewChange={handleAccountPreviewChange}
            onBack={goToPreviousStep}
            onNext={handleProceedToStep3}
          />
        );
      case 3:
        return (
          <IBKRTickerPreviewStep
            isResolving={isResolving}
            resolutionProgress={resolutionProgress}
            transactionGroups={transactionGroups}
            onBack={goToPreviousStep}
            onNext={handleStartImport}
          />
        );
      case 4:
        return (
          <IBKRImportResultsStep
            isImporting={isImporting}
            importProgress={importProgress}
            results={importResults}
            onReset={resetImportProcess}
          />
        );
      default:
        return null;
    }
  };

  return (
    <Page>
      <PageHeader heading="IBKR Multi-Currency Import" />
      <PageContent withPadding={false}>
        <div className="px-2 pt-2 pb-6 sm:px-4 sm:pt-4 md:px-6 md:pt-6">
          <Card className="w-full">
            <div className="border-b px-3 py-3 sm:px-6 sm:py-4">
              <StepIndicator steps={STEPS} currentStep={currentStep} />
            </div>
            <div className="p-3 sm:p-6">
              {loadingMessage && currentStep === 1 && (
                <div className="mb-4 p-3 rounded-md bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 text-sm">
                  {loadingMessage}
                </div>
              )}
              {parsingErrors.length > 0 && currentStep === 1 && (
                <div className="mb-4 p-3 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-sm">
                  {parsingErrors.map((err, i) => (
                    <div key={i}>{err.message}</div>
                  ))}
                </div>
              )}
              {renderStep()}
            </div>
          </Card>
        </div>
      </PageContent>
    </Page>
  );
};

export default IBKRMultiImportPage;
