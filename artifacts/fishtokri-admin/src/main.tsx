import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setAuthTokenGetter } from "@workspace/api-client-react";

// QR links contain a temporary signed parameter so the delivery-panel
// scanner can identify the order. Remove it before the app renders so a
// normal phone-camera visit leaves only the clean application URL visible.
(function cleanPublicQrUrl() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("order_qr")) {
      window.history.replaceState({}, document.title, `${url.pathname || "/"}${url.hash}`);
    }
  } catch {}
})();

// "Remember me" support: when the user logs in WITHOUT checking remember-me,
// the token is stored in sessionStorage AND mirrored into localStorage so all
// existing call sites keep working. We then clear localStorage on tab close
// so the token does not survive across sessions.
(function bootSessionAuth() {
  try {
    const sToken = sessionStorage.getItem("fishtokri_token");
    const sAdmin = sessionStorage.getItem("fishtokri_admin");
    if (sToken) {
      localStorage.setItem("fishtokri_token", sToken);
      if (sAdmin) localStorage.setItem("fishtokri_admin", sAdmin);
      window.addEventListener("beforeunload", () => {
        try {
          localStorage.removeItem("fishtokri_token");
          localStorage.removeItem("fishtokri_admin");
        } catch {}
      });
    }
  } catch {}
})();

setAuthTokenGetter(() => localStorage.getItem("fishtokri_token"));

createRoot(document.getElementById("root")!).render(<App />);
