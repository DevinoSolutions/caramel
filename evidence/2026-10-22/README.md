# Evidence 2026-10-22

- `t5915-prod-login-get-session.png`: prod https://grabcaramel.com/login, fresh unnamed headed clone (signed out). 1 GET /api/auth/get-session (200) on load, still 1 after 10 s, so the ~95-request burst is not reproduced. T-5915 closed. The 10-21 run recorded the signed-in case: 1 request.
- `pr403-prod-login-probe.png`: prod /login?code=PROBE0422CODE&state=PROBE0422STATE renders the normal login page (1 more get-session).
- Sentry (MCP, project caramel), events after the #403/#404 build went live (~22:03Z 10-21, release 5ae6de5): no authorization/cookie headers and no code/state values; the probe event shows code=[Filtered], state=[Filtered], [Filtered email], [Filtered ip]. The one event with a user IP (CARAMEL-27, 20:46Z) is from release fb6dcde, before #403.
