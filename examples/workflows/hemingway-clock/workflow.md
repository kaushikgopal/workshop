---
cron: "*/3 * * * *"
max_runs: 6
enabled: true
profile: writer
retries: 1
timeout: 10m
---

Generate an original sentence, check it, and save the accepted result in this workflow's working folder.
