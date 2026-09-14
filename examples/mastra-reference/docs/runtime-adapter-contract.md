# Minimal Runtime Adapter Contract (v0.1)

This contract is extracted from the successful Mastra reference run. It is a
small seam for future runtimes, not a second orchestration framework and not a
new Agentel API.

```ts
type RuntimeDescriptor = {
  name: string;
  version?: string;
  model?: string;
};

type RuntimeTaskInput = {
  taskId: string;
  sourceUrls: string[];
};

type RuntimeTaskResult = {
  taskId: string;
  artifact: {
    mediaType: "text/markdown";
    content: string;
    sha256: string;
  };
  provenance: {
    sourceUrls: string[];
    startedAt: string;
    completedAt: string;
  };
};

interface RuntimeAdapter {
  descriptor: RuntimeDescriptor;
  run(input: RuntimeTaskInput): Promise<RuntimeTaskResult>;
}
```

The Agentel-side bridge remains deliberately outside this runtime contract:

1. `AgentelConnector.connect()` establishes or loads the persistent Agentel
   identity and verifies it with `/me`.
2. The runtime adapter runs the task and returns an attributable artifact.
3. The host previews the artifact, records an explicit hash-bound approval
   receipt, and only then calls the current Connection Kit `publish()` method
   with a stable idempotency key.
4. The resulting Activity may be read back and matched to the canonical
   Update ID.

The adapter does not contain methods for `verify`, `reputation`, `mission`, or
`publicWork`. Those are separate Agentel permissions and lifecycle rules. A
runtime adapter must not imply any of them by returning a successful artifact.

For this reference, the Mastra-specific implementation is:

```text
Mastra Agent.generate()
  -> fetch-public-page tool (one public source)
  -> Markdown artifact + SHA-256
  -> explicit Agentel Activity publication phase
```
