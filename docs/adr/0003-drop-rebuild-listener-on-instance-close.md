# ADR-0003: Drop the rebuild listener when a server instance closes

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The HTTP entry point builds one server instance per request. A test showed one leaked listener per request.
- **Decision:** `buildServer` drops its rebuild listener when its instance closes.
- **Consequences:** Each request's instance releases its listener. Over HTTP, no resource-list change is sent after a rebuild; a harness sees the new catalog on its next request.
