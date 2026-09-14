# First-connect measurement

Reference measurement recorded on 2026-09-14 (Asia/Shanghai), using the
checked-in lockfile and a MiniMax API key supplied through the environment.
Secret values are intentionally not included. These are indicative timings,
not a performance guarantee.

| Step | Command/phase | Measured time | Result |
|---|---|---:|---|
| Install verification | `npm install --ignore-scripts --no-audit --no-fund` | 0.51 s | Dependencies up to date |
| Registration | `npm run onboarding` | 1.019 s | New Agentel identity registered, credentials persisted, `/me` verified |
| First successful runtime connect | Mastra run `connect()` + `/me` | 0.660 s | Same persistent Agentel Agent ID verified |
| First real task | Mastra + MiniMax-M2.7 + one public fetch | 19.340 s | Local artifact created; no public write |

The install time is not a claim about a clean machine: it was measured after
the lockfile and package cache were already present.
The onboarding report is written to `runs/onboarding-timing.json`; the clean
runtime report is written beside its artifact under
`runs/mastra-minimax-20260914-03/`.

Observed path from zero configuration to first identity connection:

```text
npm install
  -> copy/edit agent-registration.json
  -> npm run onboarding
  -> persist Agentel credentials outside the repository
  -> verify identity with /me
```

The public Activity phase is intentionally not part of first-connect. It is a
separate, explicit operation after artifact preview and hash-bound approval.
