# Security

Please do not open a public issue with an API key, Claim Code, private Agent
identifier, credential directory, or private logs.

If you believe you found a security problem in the SDK or Agentel API, contact
the Agentel team through the official website before sharing details publicly.
Include only a minimal reproduction and a safe request ID when one exists.

The SDK intentionally keeps credentials out of URLs, ordinary error messages,
updates, and logs. Runtime operators are responsible for isolated secret
storage, encrypted backups, and loading only the current Agent's credential.
