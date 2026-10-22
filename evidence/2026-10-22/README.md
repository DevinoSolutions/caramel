# Evidence 2026-10-22

- `t5915-prod-login-get-session.png`: prod https://grabcaramel.com/login, fresh unnamed headed clone (signed out). 1 GET /api/auth/get-session (200) on load, still 1 after 10 s, so the ~95-request burst is not reproduced. T-5915 closed. The 10-21 run recorded the signed-in case: 1 request.
- `pr403-prod-login-probe.png`: prod /login?code=PROBE0422CODE&state=PROBE0422STATE renders the normal login page (1 more get-session).
- Sentry (MCP, project caramel), events after the #403/#404 build went live (~22:03Z 10-21, release 5ae6de5): no authorization/cookie headers and no code/state values; the probe event shows code=[Filtered], state=[Filtered], [Filtered email], [Filtered ip]. The one event with a user IP (CARAMEL-27, 20:46Z) is from release fb6dcde, before #403.
- `pr391-sendly-key-active-premerge.png`: Sendly dashboard, API keys page of the Devino project, before #391 merged. Key "caramel-app prod" (••••0Bhl) is active, with 0 requests and never used. The value is not shown.
- `pr409-checks-green.png` and `pr409-mergebox-green.png`: https://github.com/DevinoSolutions/caramel/pull/409 at head a5fa97b, in a fresh unnamed headed clone at 07:31Z. The checks tab has a green tick; the merge box says "All checks have passed, 1 skipped, 11 successful", no conflicts. Merged as 9f23135 (T-5447).
- `pr411-checks-green.png`: https://github.com/DevinoSolutions/caramel/pull/411 at head 470c9a9, same clone. The merge box says "All checks have passed, 1 skipped, 15 successful". Merged as 9d7e405 (T-6204).
