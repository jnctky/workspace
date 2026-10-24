import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import Icon from "../Icon";
import type { IconId } from "../Icon.types";
import Tooltip from "../Tooltip";
import { t } from "~/i18n";

/**
 * Status indicators for the local Workspace stack (self-hosted deployments):
 * - OpenBB Platform API  (6900) — controllable via backend-api (8000)
 * - Copilot adapter      (7777) — controllable via backend-api (8000)
 * - backend-api          (8000) — controllable via its self-restart endpoint
 *
 * UI: a compact strip of icon badges with a status dot in the corner
 * (scheme C). Clicking a badge opens a small menu with Start / Stop /
 * Restart actions.
 */

const SERVICES_API = "http://127.0.0.1:8000/services";

export type LocalServiceId = "openbb" | "adapter" | "backend";
export type ServiceState = "running" | "stopped" | "busy" | "unknown";

type ServiceStatus = {
  service: string;
  label: string;
  port: number;
  running: boolean;
  healthy: boolean;
  pid: number | null;
};

type StatusResponse = { services: Record<string, ServiceStatus> };

async function fetchStatus(): Promise<StatusResponse | null> {
  try {
    const resp = await fetch(`${SERVICES_API}/status`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function control(sid: LocalServiceId, action: "start" | "stop" | "restart") {
  // backend-api restarts itself through a dedicated endpoint (it is the
  // control plane — it cannot be stopped/started "from outside" itself).
  const url =
    sid === "backend" && action === "restart"
      ? `${SERVICES_API}/backend/restart`
      : `${SERVICES_API}/${sid}/${action}`;
  const resp = await fetch(url, { method: "POST" });
  if (!resp.ok) {
    const detail = await resp.json().catch(() => null);
    throw new Error(detail?.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

function useServiceStatuses(pollMs = 15000) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    const result = await fetchStatus();
    setBackendUp(result !== null);
    if (result) setData(result);
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    const tick = () => {
      void refresh();
    };
    tick();
    interval = setInterval(tick, pollMs);
    return () => clearInterval(interval);
  }, [pollMs, refresh]);

  return { data, backendUp, refresh };
}

function stateTone(state: ServiceState) {
  switch (state) {
    case "running":
      return "bg-green-500";
    case "busy":
      return "bg-yellow-500 animate-pulse";
    case "stopped":
      return "bg-red-500";
    default:
      return "bg-gray-400 dark:bg-gray-600";
  }
}

function stateLabel(state: ServiceState) {
  switch (state) {
    case "running":
      return t("Running");
    case "busy":
      return t("Working…");
    case "stopped":
      return t("Stopped");
    default:
      return t("Unknown");
  }
}

type ServiceAction = "start" | "stop" | "restart";

function ServiceMenu({
  label,
  port,
  state,
  onAction,
  onClose,
}: {
  label: string;
  port?: number;
  state: ServiceState;
  onAction: (action: ServiceAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  const items: { action: ServiceAction; label: string; danger?: boolean }[] =
    state === "stopped"
      ? [{ action: "start", label: t("Start") }]
      : [
          { action: "restart", label: t("Restart") },
          { action: "stop", label: t("Stop"), danger: true },
        ];

  return (
    <div
      role="menu"
      ref={ref}
      className="absolute bottom-full right-0 z-50 mb-1.5 min-w-36 rounded border
        border-general-border-primary bg-general-bg-primary py-1 shadow-lg"
    >
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-2xs text-light-400 dark:text-light-300">
        <span className={cn("size-1.5 shrink-0 rounded-full", stateTone(state))} />
        <span className="truncate">
          {label}
          {port ? ` :${port}` : ""}
        </span>
        <span className="ml-auto shrink-0 opacity-70">{stateLabel(state)}</span>
      </div>
      {items.map((item) => (
        <button
          key={item.action}
          role="menuitem"
          disabled={state === "busy"}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
            onAction(item.action);
          }}
          className={cn(
            "block w-full px-3 py-1.5 text-left text-2xs hover:bg-light-100 dark:hover:bg-dark-800",
            item.danger && "text-red-600 dark:text-red-400",
            state === "busy" && "cursor-default opacity-40",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Icon badge with a status dot in the corner; click opens the control menu. */
function ServiceBadge({
  icon,
  label,
  state,
  tip,
  onAction,
}: {
  icon: IconId;
  label: string;
  state: ServiceState;
  tip: string;
  onAction: (action: ServiceAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const busy = state === "busy";

  return (
    <Tooltip message={tip} position="top">
      <div className="tooltip-wrapper relative">
        {open && (
          <ServiceMenu
            label={label}
            state={state}
            onAction={onAction}
            onClose={() => setOpen(false)}
          />
        )}
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${label} — ${t("Service actions")}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={cn(
            "flex size-6 items-center justify-center rounded-md border transition-colors",
            open
              ? "border-primary-500 bg-primary-50 dark:bg-dark-700"
              : "border-general-border-primary bg-surface-card hover:bg-light-100 dark:hover:bg-dark-800",
            busy && "opacity-70",
          )}
        >
          <Icon id={icon} className={cn("h-3.5 w-3.5", busy && "animate-pulse")} />
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 size-2 rounded-full border border-surface-card",
              stateTone(state),
            )}
          />
        </button>
      </div>
    </Tooltip>
  );
}

function deriveState(
  sid: LocalServiceId,
  status: ServiceStatus | undefined,
  busySid: LocalServiceId | null,
  backendUp: boolean | null,
): ServiceState {
  if (busySid === sid) return "busy";
  if (sid === "backend" && !status) {
    // older backend without the "backend" entry in /services/status
    return backendUp === null ? "unknown" : backendUp ? "running" : "stopped";
  }
  if (status?.running) return status.healthy ? "running" : "busy";
  return "stopped";
}

function useServiceActions(refresh: () => void) {
  const [busySid, setBusySid] = useState<LocalServiceId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onAction = useCallback(
    async (sid: LocalServiceId, action: ServiceAction) => {
      setBusySid(sid);
      setError(null);
      try {
        await control(sid, action);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusySid(null);
        // long-poll right away, then again after a beat (services take time to bind)
        setTimeout(() => void refresh(), 2500);
        void refresh();
      }
    },
    [refresh],
  );

  return { busySid, error, onAction };
}

/** Sidebar footer: icon badge strip for the three local services.
 *  Compact variant designed to sit inline in the version row; hides on
 *  narrow (collapsed) sidebars via the 185px container breakpoint. */
export function SidebarServicesStatus() {
  const { data, backendUp, refresh } = useServiceStatuses();
  const { busySid, error, onAction } = useServiceActions(refresh);

  const badges: {
    sid: LocalServiceId;
    icon: IconId;
    label: string;
    port?: number;
  }[] = [
    { sid: "openbb", icon: "database-01", label: t("OpenBB Data API"), port: 6900 },
    { sid: "backend", icon: "server-01", label: t("Backend API"), port: 8000 },
    { sid: "adapter", icon: "material-symbols-chat-bubble", label: t("Copilot Adapter"), port: 7777 },
  ];

  return (
    <div className="flex items-center gap-1 @max-[185px]:hidden">
      {badges.map(({ sid, icon, label, port }) => {
        const state = deriveState(sid, data?.services[sid], busySid, backendUp);
        const tip = `${label}${port ? ` (:${port})` : ""}: ${stateLabel(state)}${error && busySid === sid ? ` — ${error}` : ""}`;
        return (
          <ServiceBadge
            key={sid}
            icon={icon}
            label={label}
            state={state}
            tip={tip}
            onAction={(action) => void onAction(sid, action)}
          />
        );
      })}
    </div>
  );
}
