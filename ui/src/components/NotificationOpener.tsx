import { useEffect } from "react";
import { handleServiceWorkerMessage, setNotificationPathOpener } from "@/lib/background-notify";
import { useNavigate } from "@/lib/router";

/**
 * A clicked notification (an AI reply that finished while the board was out
 * of sight) opens its screen in this tab through the router, without a
 * reload. In a browser the service worker asks the tab to go there.
 */
export function NotificationOpener() {
  const navigate = useNavigate();
  useEffect(() => {
    setNotificationPathOpener((path) => navigate(path));
    const worker = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    const onMessage = (event: MessageEvent) => {
      handleServiceWorkerMessage(event.data);
    };
    worker?.addEventListener("message", onMessage);
    return () => {
      setNotificationPathOpener(null);
      worker?.removeEventListener("message", onMessage);
    };
  }, [navigate]);
  return null;
}
