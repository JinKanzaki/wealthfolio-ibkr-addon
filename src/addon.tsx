import React from 'react';
import type { AddonContext, Account } from '@wealthfolio/addon-sdk';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import IBKRMultiImportPage from './pages/ibkr-multi-import-page';
import IBKRFlexSettingsPage from './pages/ibkr-flex-settings-page';
import { setHttpClient } from './lib/flex-query-fetcher';
import {
  loadConfigsSafe,
  loadToken,
  updateConfigStatus,
} from './lib/flex-config-storage';
import { generateAccountNames } from './lib/account-name-generator';
import { AsyncLock } from './lib/async-lock';
import { QUERY_STALE_TIME_MS, AUTO_FETCH_DEBOUNCE_MS } from './lib/constants';
import {
  isConfigInCooldown,
  createPendingStatus,
} from './lib/auto-fetch-helpers';
import { processFlexQueryConfig } from './lib/auto-fetch-processor';
import { getErrorMessage } from './lib/shared-utils';

const autoFetchLock = new AsyncLock();

function createDebouncedFunction<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number
): { debounced: (...args: Parameters<T>) => void; cleanup: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, delayMs);
  };

  const cleanup = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return { debounced, cleanup };
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_STALE_TIME_MS,
      refetchOnWindowFocus: false,
    },
  },
});

export function enable(ctx: AddonContext) {
if (ctx.api.network) {
  setHttpClient(ctx.api.network);
}

  const cleanupFunctions: (() => void)[] = [];
  let isDisabled = false;

  const LazyImportPage = React.lazy(() =>
    Promise.resolve({
      default: () => <IBKRMultiImportPage ctx={ctx} />,
    })
  );

  const LazySettingsPage = React.lazy(() =>
    Promise.resolve({
      default: () => (
        <QueryClientProvider client={queryClient}>
          <IBKRFlexSettingsPage ctx={ctx} />
        </QueryClientProvider>
      ),
    })
  );

  // SDK 3.x route registration — id must match contributes.routes in manifest.json
  ctx.router.add({
    id: 'ibkr-multi-import',
   component: LazyImportPage,
  });

  ctx.router.add({
    id: 'ibkr-flex-settings',
   path: '/addons/ibkr-multi-import/settings',
   component: LazySettingsPage,
  });

  // Sidebar is now handled by contributes.links in manifest.json — no ctx.sidebar.addItem needed

  async function getOrCreateAccountsForGroup(
    accountGroup: string,
    currencies: string[]
  ): Promise<Map<string, Account>> {
    const accountsByCurrency = new Map<string, Account>();

    const allAccounts = await ctx.api.accounts?.getAll() || [];
    const groupAccounts = allAccounts.filter((a) => a.group === accountGroup);

    const expectedNames = generateAccountNames(accountGroup, currencies);

    for (const expected of expectedNames) {
      const existing = groupAccounts.find(
        (a) => a.name === expected.name && a.currency === expected.currency
      );

      if (existing) {
        accountsByCurrency.set(expected.currency, existing);
      } else {
        try {
          const newAccount = await ctx.api.accounts?.create({
            name: expected.name,
            currency: expected.currency,
            group: accountGroup,
            accountType: 'SECURITIES',
            isDefault: false,
            isActive: true,
          });
          if (newAccount) {
            accountsByCurrency.set(expected.currency, newAccount);
            ctx.api.logger?.info(`Created account: ${expected.name}`);
          } else {
            ctx.api.logger?.error(`Failed to create account ${expected.name}: API returned null`);
          }
        } catch (e) {
          ctx.api.logger?.error(`Failed to create account ${expected.name}: ${e}`);
        }
      }
    }

    return accountsByCurrency;
  }

  const performAutoFetch = async () => {
    const release = autoFetchLock.tryAcquire();
    if (!release) {
      ctx.api.logger?.trace("IBKR auto-fetch skipped: fetch already in progress");
      return;
    }

    try {
      const token = await loadToken(ctx.api.secrets);
      if (!token) {
        ctx.api.logger?.trace("IBKR auto-fetch skipped: no token configured");
        return;
      }

      const loadResult = await loadConfigsSafe(ctx.api.secrets);
      if (!loadResult.success) {
        ctx.api.logger?.error(`IBKR auto-fetch: Failed to load configs - ${loadResult.error}`);
        return;
      }
      const configs = loadResult.configs ?? [];
      const enabledConfigs = configs.filter((c) => c.autoFetchEnabled);

      if (enabledConfigs.length === 0) {
        ctx.api.logger?.trace("IBKR auto-fetch skipped: no auto-fetch configs enabled");
        return;
      }

      ctx.api.logger?.info(`IBKR auto-fetch: Processing ${enabledConfigs.length} configs...`);

      for (const config of enabledConfigs) {
        const cooldownCheck = isConfigInCooldown(config.lastFetchTime);
        if (cooldownCheck.inCooldown) {
          ctx.api.logger?.trace(`IBKR auto-fetch [${config.name}]: cooldown active (${cooldownCheck.hoursRemaining}h remaining)`);
          continue;
        }

        const freshLoadResult = await loadConfigsSafe(ctx.api.secrets);
        if (freshLoadResult.success) {
          const freshConfig = freshLoadResult.configs?.find(c => c.id === config.id);
          if (freshConfig) {
            const freshCooldownCheck = isConfigInCooldown(freshConfig.lastFetchTime);
            if (freshCooldownCheck.inCooldown) {
              ctx.api.logger?.trace(`IBKR auto-fetch [${config.name}]: cooldown became active (${freshCooldownCheck.hoursRemaining}h remaining)`);
              continue;
            }
          }
        }

        ctx.api.logger?.info(`IBKR auto-fetch [${config.name}]: Starting...`);

        try {
          await updateConfigStatus(ctx.api.secrets, config.id, createPendingStatus());
        } catch (claimError) {
          ctx.api.logger?.warn(`IBKR auto-fetch [${config.name}]: Failed to claim config, skipping`);
          continue;
        }

        await processFlexQueryConfig(config, {
          ctx,
          token,
          getOrCreateAccountsForGroup,
        });
      }

    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      ctx.api.logger?.error(`IBKR auto-fetch error: ${msg}`);
    } finally {
      release();
    }
  };

  if (ctx.api.events?.portfolio?.onUpdateComplete) {
    const { debounced: debouncedAutoFetch, cleanup: cleanupDebounce } = createDebouncedFunction(
      performAutoFetch,
      AUTO_FETCH_DEBOUNCE_MS
    );

    cleanupFunctions.push(cleanupDebounce);

    void ctx.api.events.portfolio.onUpdateComplete(debouncedAutoFetch)
      .then((unlisten) => {
        if (isDisabled) {
          try {
            unlisten();
          } catch (error) {
            ctx.api.logger?.warn(`IBKR addon: Failed to unregister event listener (late cleanup): ${getErrorMessage(error)}`);
          }
          return;
        }

        cleanupFunctions.push(() => {
          try {
            unlisten();
          } catch (error) {
            ctx.api.logger?.warn(`IBKR addon: Failed to unregister event listener: ${getErrorMessage(error)}`);
          }
        });
        ctx.api.logger?.trace(`IBKR addon: Registered portfolio update listener (${AUTO_FETCH_DEBOUNCE_MS}ms debounce)`);
      })
      .catch((error) => {
        ctx.api.logger?.warn(`IBKR addon: Failed to register event listener: ${getErrorMessage(error)}`);
      });
  }

  return {
    disable: () => {
      isDisabled = true;

      for (const cleanup of cleanupFunctions) {
        try {
          cleanup();
        } catch (e) {
          ctx.api.logger?.warn(`IBKR addon cleanup error: ${String(e)}`);
        }
      }
      ctx.api.logger?.info("IBKR addon disabled");
    },
  };
}

export default enable;