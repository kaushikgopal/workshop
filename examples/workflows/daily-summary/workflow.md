---
cron: "0 8 * * *"
enabled: true
profile: writer
retries: 1
timeout: 5m
---

Summarize Workshop activity from the last 24 hours. If there are no runs and no actions, the summary agent ends the run early without saving a report. Otherwise the final step saves the report in this workflow's working folder. To send a notification, add your own command step after `30-save-summary.ts`.
