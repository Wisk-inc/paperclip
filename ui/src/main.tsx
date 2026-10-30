import * as React from "react";
import { StrictMode } from "react";
import * as ReactDOM from "react-dom";
import { BrowserRouter } from "@/lib/router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { SentryGate } from "./components/SentryGate";
import { CompanyProvider, useCompany } from "./context/CompanyContext";
import { LiveUpdatesProvider } from "./context/LiveUpdatesProvider";
import { NotificationOpener } from "./components/NotificationOpener";
import { BreadcrumbProvider } from "./context/BreadcrumbContext";
import { PanelProvider } from "./context/PanelContext";
import { SidebarProvider } from "./context/SidebarContext";
import { DialogProvider } from "./context/DialogContext";
import { EditorAutocompleteProvider } from "./context/EditorAutocompleteContext";
import { ToastProvider } from "./context/ToastContext";
import { ThemeProvider } from "./context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initPluginBridge } from "./plugins/bridge-init";
import { PluginLauncherProvider } from "./plugins/launchers";
import { startPerfMeasureReaper } from "./lib/perf-measure-reaper";
import { getOrCreatePaperclipReactRoot } from "./lib/react-root";
import { startServiceWorkerUpdates } from "./lib/service-worker-updates";
import { installInputLimitHaptics } from "./lib/haptics";
import "@mdxeditor/editor/style.css";
import "./index.css";
import { queryNetworkMode } from "./lib/network-mode";

initPluginBridge(React, ReactDOM);

// React 19.2 emits an unbounded stream of performance.measure() entries for its
// DevTools performance tracks and never clears them; on a long-lived tab they
// accumulate into millions of native objects (GBs). Reap them periodically.
startPerfMeasureReaper();
installInputLimitHaptics();

// Parked SPA tabs never navigate, so beyond registering the worker this also
// re-checks /sw.js on tab focus and hourly, and applies a discovered update
// with one reload while the tab is hidden — otherwise an old worker and its
// cached shell can outlive a deploy indefinitely.
// Collaborators who open a Studio invite get only the guest page: they come
// through the collaborator gateway, which serves nothing of the board.
const isStudioGuest = window.location.pathname === "/studio-guest" || window.location.pathname.startsWith("/studio-guest/");
const StudioGuest = React.lazy(() => import("./pages/StudioGuest").then((module) => ({ default: module.StudioGuest })));

if (!isStudioGuest) {
  window.addEventListener("load", () => {
    startServiceWorkerUpdates();
  });
}

const networkMode = queryNetworkMode(window.location.hostname);
const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { networkMode },
    queries: {
      networkMode,
      staleTime: 30_000,
      // Explicit so cross-tab-published cache entries for resources this tab
      // isn't observing get collected promptly rather than lingering. Single
      // tuning point if we need to trim the cache footprint further.
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
    },
  },
});

function CompanyAwareBreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const { selectedCompany } = useCompany();
  return <BreadcrumbProvider companyName={selectedCompany?.name ?? null}>{children}</BreadcrumbProvider>;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Automa root element is missing");

getOrCreatePaperclipReactRoot(window, rootElement).render(
  isStudioGuest ? (
    <StrictMode>
      <AppErrorBoundary>
        <ThemeProvider>
          <TooltipProvider>
            <React.Suspense fallback={null}>
              <StudioGuest />
            </React.Suspense>
          </TooltipProvider>
        </ThemeProvider>
      </AppErrorBoundary>
    </StrictMode>
  ) : (
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SentryGate />
        <ThemeProvider>
          <BrowserRouter>
            <CompanyProvider>
              <EditorAutocompleteProvider>
                <ToastProvider>
                  <LiveUpdatesProvider>
                    <NotificationOpener />
                    <TooltipProvider>
                      <CompanyAwareBreadcrumbProvider>
                        <SidebarProvider>
                          <PanelProvider>
                            <PluginLauncherProvider>
                              <DialogProvider>
                                <App />
                              </DialogProvider>
                            </PluginLauncherProvider>
                          </PanelProvider>
                        </SidebarProvider>
                      </CompanyAwareBreadcrumbProvider>
                    </TooltipProvider>
                  </LiveUpdatesProvider>
                </ToastProvider>
              </EditorAutocompleteProvider>
            </CompanyProvider>
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>
  ),
);
