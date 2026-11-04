---
name: Sub-hub menu shortcut
description: Distinguishes a Sub Hub row's Dashboard action from the global menu shortcut.
---

Keep the Dashboard action on a Sub Hub row or card opening that selected sub-hub's menu admin page. The global sidebar should have a separate Menu Management shortcut that opens the last-selected sub-hub's menu and falls back to an available active sub-hub. The main Dashboard also needs a direct shortcut to Airoli's menu admin; resolve Airoli by name rather than hard-coding its database ID.

**Why:** The user clarified that the Sub Hub Dashboard button already opens the products/categories admin page; they also want a direct Airoli shortcut on the main Dashboard.

**How to apply:** Preserve the row/card route to the selected sub-hub menu. When using that route, store the selected sub-hub so the sidebar shortcut can reopen the same menu. Keep the main Dashboard's Airoli shortcut separate and navigate to the matching sub-hub menu page.
