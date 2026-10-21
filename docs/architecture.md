# Architecture

## Explicit note excerpts

The Markdown note selection menu captures plain text and delegates to `web/note-excerpt.js` for target selection. It uses the shared dialog, paginated document index, and a fresh target version. Unsaved source notes must save successfully first. `POST note-excerpts` requires read and write permissions, and is forwarded unchanged by the remote management proxy (the remote server must support this endpoint).

`LocalKnowledgeProvider.excerptNote` creates or appends a knowledge document, establishes its stable note-ID reference, and records an idempotency receipt in one transaction. Markdown projection follows the commit and is retryable through the same request ID. Archived/finalized targets and stale versions reject without partial writes. `src/note-excerpt.ts` escapes selected text into source hyperlinks; the editor and read-only renderer preserve and open these links without authorizing arbitrary URI schemes. The source note is retained; there is no automatic content synchronization or AI extraction.

## Design goals

The plugin is a modular monolith inside one DSH process. It keeps deployment simple while preserving explicit boundaries that can later become separate packages without changing the knowledge contract.

```text
DSH events / pre-step / HTTP / Web console
              |
 extraction, catalog, retrieval tools, API
              |
       KnowledgeProvider
          /          \
 local SQLite      remote HTTPS
```

The DSH core is never patched. `src/index.ts` is the composition root; every other module is independently testable.

## Confirmed document lifecycle

`document-lifecycle.ts` builds either a version/hash-bound `finalize` candidate
change or a unique-anchor section revision from explicit user confirmation.
`document-lifecycle-tool.ts` supplies session-handle and mounted-write checks;
`extraction.ts` uses the same builder for automatic whole-subject closure and
normal revisions for individual issues. A simultaneous content edit suppresses
closure, and truncated model context cannot finalize a whole document.

Candidates retain the existing `update` action and store their new change kind
in `change_json`, so no database migration or separate status-write pipeline is
needed. Both providers retain `propose`/`write` authorization; audit approval and
direct finalization verify the original full document version/hash atomically.
Finalization preserves body text, records a conclusion/history version and
syncs the Markdown projection. The existing UI reopen action remains the only
way to resume writes. Review previews show status/conclusion rather than a fake
body diff; persisted writeback destinations distinguish applied and pending states.

## DSH client contract

The browser integration is compiled against the exact official client packages used by the supported DSH release. These packages are pinned as development-only dependencies; they are never bundled into the plugin:

- `@deepseek-ai/dsh-client-runtime` supplies the official `ClientContext` and framework-standard slot props.
- `@deepseek-ai/dsh-client-ui-layout` declares the single `conversation` slot.
- `@deepseek-ai/dsh-client-ui-sidebar` declares the list `sidebar.footer.action` slot.
- `@deepseek-ai/dsh-client-ui-settings-plugins` declares the keyed `settings.plugin.item` slot.
- `@deepseek-ai/dsh-client-ui-theme` declares the theme service and `theme/change` event.
- `@deepseek-ai/dsh-client-ui-slots` supplies `SlotMap`, `PropsRuntime` and the typed registration contract.

`src/client.tsx` must not redeclare any of these services structurally. The TypeScript build includes both `.ts` and `.tsx`, so slot cardinality is checked before packaging: list entries require `id`, keyed entries require `key`, and the knowledge workspace shadows the official single `conversation` occupant at an explicit lower priority. Closing the workspace disposes only that registration and restores the official conversation occupant; the DSH shell is never replaced or patched.

## Layers

- `domain.ts` owns stable value types, normalization, IDs and content hashing. It has no DSH dependency.
- `provider.ts` is the storage/application port. Local and remote clients implement the same asynchronous contract.
- `mount-management.ts` provides the optional host-only `dshKnowledgeMountManagement` v1 service for partner administration. It exposes safe active-base metadata, scoped mount snapshots/revisions and one-base batch configuration. It is not a global Agent tool and does not grant public HTTP access. Callers derive and authorize scopes themselves; the partner adapter supplies a final live-authorization guard before mutation. All operations use the selected provider and its existing bearer permissions, with no local fallback. Discovery is bounded to 100 scopes and eight concurrent requests. Connection revisions reject snapshots taken across local/remote switches. A disabled mount remains an explicit override rather than restoring project inheritance. Snapshot revision checks detect stale reads, but are not a distributed compare-and-swap lock against unrelated remote clients; provider batch writes retain their existing atomic transaction boundary.
- `local-provider.ts` owns schema migrations, transactions, FTS and token hashes.
- `remote-provider.ts` is an authenticated, timeout-bounded HTTPS adapter.
- `management-proxy.ts` lets the embedded console operate on the selected central service while keeping the saved remote token on the DSH server.
- `notes/domain.ts` owns stable note ids and knowledge-to-note relation types; `notes/store.ts` owns the independent directory tree, editable notes and opaque file storage.
- `note-reference-tools.ts` owns the AI-facing metadata search and structured reference mutations; `note-reference-handle.ts` keeps note selections opaque and session-bound.
- `extraction.ts` snapshots completed turns, resolves writable mounts and validates model JSON fail-closed.
- `artifacts/` is the automatic artifact path, independent of model extraction: `collect.ts` reads one turn's durable `deliverables/presented`, file-tool `tool/call` and uploaded `file`/`image` message blocks; `uploads.ts` reads attachment bytes through the Host attachment service; `archive.ts` owns the content-addressed archive, manifest, knowledge document reconciliation, category grouping and recall mount; `text.ts`, `office-text.ts` and `zip.ts` extract indexed text from plain files, PDFs and Office/ODF containers without new dependencies. Nothing here is model-facing.
- `auto-writable.ts` provisions the default writable project mount when a session has only recall-only mounts, so completed-turn write-back is not silently dropped.
- `auto-approve.ts` reviews ordinary pending candidates in the background (conflicts and credential holds excluded), removing the manual approval step.
- Web console: `web/app.js` adds a bounded 「制品文件」 view backed by `GET /knowledge-control/v1/artifacts`, with image/PDF/text/audio/video preview, arbitrary-format download and navigation into the generated knowledge document.
- `retrieval.ts` owns mounted-scope authorization, signed handles, ranking and bounded rendering shared by proactive and tool-driven retrieval.
- `recall.ts` owns the official prompt-assembly knowledge map and bounded first-step automatic retrieval. It also removes durable UI notices and prior recall snapshots before later model requests.
- `tools.ts` registers the tool-first retrieval chain: mounted-base discovery, scoped document search and paginated reading, plus explicit knowledge-base administration. Content write-back is deliberately absent from the main Agent tool surface.
- `api.ts` is a size-bounded HTTP adapter with two explicit authentication modes: same-origin administration for the embedded console and Bearer capabilities for remote clients.
- `web.ts` serves a same-origin, CSP-constrained management console from package-owned, content-versioned static assets.
- `web/app.js` is the browser composition root and owns navigation plus business view state. Transport, host integration and reusable DOM construction are deliberately outside it:
  - `web/api-client.js` owns authenticated JSON, binary download and progress-aware upload requests.
  - `web/host-theme.js` validates the parent-frame protocol and applies only the allowlisted light/dark palette.
  - `web/ui-primitives.js` owns dependency-free DOM, button, badge and toast primitives.
  - `web/styles.css` owns the management layout while `src/client.css` owns DSH-shell integrations; neither reads host component-fill or browser-default control styling.
- `service-settings.ts` atomically persists the user-controlled public API state separately from provider connection settings.
- `index.ts` validates configuration and wires lifecycle disposal.

## Data model and consistency

SQLite is authoritative in local mode. Schema version 12 contains:

- `knowledge_bases`: independently named destinations with default tags and extraction instructions.
- `knowledge_mounts`: project/session policy overlays for recall, write mode and tag constraints.
- `knowledge_entries`: current materialized entry state.
- `knowledge_versions`: immutable snapshots for every create, update, archive or restore.
- `knowledge_fts`: FTS5 index containing only active entries.
- `knowledge_candidates`: proposed create/update/conflict decisions, explicit append/revise change data, base revision metadata and review state.
- `extraction_jobs`: one idempotency record per `sessionId:turn`.
- `api_tokens`: token metadata, permissions and SHA-256 token digests.
- `knowledge_settings`: the authoritative global conservative/proactive writeback policy shared by local and remote clients.
- `knowledge_note_references`: the many-to-many relation between knowledge documents and stable note nodes, including user/agent/legacy provenance.

Each active `knowledge_entries` row represents one topic document and is materialized as one real Markdown file under `documents/base-<stable-id>/`. Related findings are Markdown sections or incremental content inside that row/file, rather than sibling one-fact documents. `knowledge_documents` indexes those files for the management console; the entry ID is the document ID, and the human-readable filename is derived from the title plus a stable ID suffix. Mutations complete only after the corresponding file synchronization finishes. Normal entry mutations update exactly one derived file and index row; the full-base reconciliation is reserved for startup repair. Knowledge-base metadata changes update only the manifest. SQLite remains authoritative so FTS, version history, direct-write reconciliation and remote providers keep one consistency model.

Notes form a separate hierarchical workspace beside the knowledge database:

```text
<knowledge data directory>/
├── knowledge.sqlite
├── documents/
└── notes/
    ├── notes.sqlite
    └── objects/
        └── note_<32 lowercase hexadecimal characters>
```

`notes.sqlite` stores an adjacency-list tree of folders, editable Markdown documents and uploaded files. Every node has a stable id and parent id; files additionally store media type, size and SHA-256. Text-based uploads expose an explicit editable capability and use the same atomic content update boundary as native note documents; binary uploads remain opaque. `note_shares` separately owns high-entropy read-only bearer links and cascades with the shared root node; a directory token is authorized against its live descendant tree, so moves into or out of that tree take effect immediately without copying content. Public rendering is script-free, bounded to 500 listed nodes and a 512 KiB text preview, while downloads require the same subtree authorization check. Share import first validates a bounded manifest and then copies into a new local tree. Remote HTTP reads pin a DNS-validated address and reject loopback/private/link-local targets by default. Private DNS hairpin targets are permitted only for an exact trusted HTTP(S) origin and a valid DSH share resource path; every redirect repeats the origin, path and DNS checks. Requests cap individual files at 64 MiB and the complete import at 256 MiB, verify sizes and SHA-256 hashes, and remove the newly created root if any later step fails. Importing a share owned by the same store takes the local recursive-copy path without a network round trip. `objects/` stores document and file bytes under the stable id, so user-visible names never participate in physical paths. Moving and renaming are metadata-only operations. Folder copies recursively create new stable ids, and folder deletion is recursive. File operations use the shared cross-platform atomic writer and are capped at 64 MiB.

Knowledge-to-note references are explicit many-to-many rows in `knowledge_note_references`; knowledge Markdown contains only knowledge content. Moving or renaming a note does not break a relation because it targets the stable note id. Normal deletion of a node or ancestor folder is rejected while any descendant is referenced; explicit administrator force-deletion remains an API-only recovery operation. Schema 9 upgrades scan valid legacy `note://note_<id>` markers once and backfill `source=legacy` rows without rewriting user-authored Markdown, so old prose remains byte-safe while new mutations use only the relation table. Note content is not parsed, indexed, embedded, recalled or written back by the AI.

The management console never loads the complete document corpus during startup. `/document-index` returns a keyset-paginated metadata projection without `content`; its browse order has a matching SQLite index. The browser requests one page only for the initially selected knowledge base, loads other bases when their tree nodes expand, and fetches a document body only after selection. Search uses the same bounded index endpoint across the currently visible mounted bases. The original `/documents` endpoint remains available for compatibility, but is not part of console bootstrap, partner-source discovery or normal reference inspection.

Entry writes, version creation and FTS changes share one `BEGIN IMMEDIATE` transaction. Candidate approval and its resulting entry mutation are also one transaction. WAL mode permits readers during a writer, `busy_timeout` absorbs short contention, and foreign keys prevent orphan versions.

An active content hash unique index blocks byte-equivalent duplicate knowledge. Candidate proposals additionally deduplicate by source turn plus proposal hash.

## Extraction flow

1. `agent/turn-stopping` synchronously persists an immutable turn snapshot in the local writeback outbox before `turn/end`. The worker starts across a macrotask boundary; network/model work never blocks turn completion or channel replies.
2. Project mounts are resolved and then overlaid by explicit session mounts; a disabled session mount blocks inheritance.
3. Without a writable mount, no extraction model call occurs; a no-op status is retained.
4. The snapshot contains direct user input, the final non-empty assistant message, its model route and source ids. The destination connection is pinned; changing it cannot redirect old queued work.
5. `extraction_jobs` atomically claims `sessionId:turn`. A running claim has a 15-minute lease. Failed claims permit three attempts before an explicit reset; the durable worker resets exhausted failed claims within its own bounded retry policy. Expired running claims remain recoverable even if the last attempt crashed. Active claims are never forcibly reset.
6. The authoritative writeback policy is loaded and writable mounts are grouped by their configured extraction model route.
7. Each route group searches its mounted bases for related existing documents, globally ranks the results and caps the comparison set.
8. One bounded model call decides destination relevance and extracts strict document-mutation JSON together. It returns a stable `documentTitle`, optional `sectionTitle`, Markdown body and an existing `targetId` whenever relevant. This avoids a second routing-model call and prevents an overly conservative first gate from discarding valid destination-specific knowledge. Model selection is explicit and deterministic: a client-local override wins first, then a knowledge-base-specific route, then the completed assistant turn's actual model, and finally the legacy static extraction route.
9. Runtime validation rejects unknown destinations, non-durable retention, types, targets, arbitrary project IDs and malformed output. It then coalesces same-base, same-scope and same-title mutations into one document proposal, merging sections, tags and provenance. Ambiguous proposals that point at different existing documents become conflicts instead of silently choosing a target.
10. Audit mounts keep valid proposals pending. Direct mounts automatically write high-confidence non-conflicting candidates; lower-confidence and conflicting candidates go to audit instead. Additions use the lossless append path. Revisions carry exact single-match old-text anchors plus the target version/hash and are replayed against the complete current document. Unrelated concurrent additions survive that replay; missing or ambiguous anchors become a conflict. Both paths create an immutable previous version before committing the new entry.
11. Per-base direct and pending counts are written to the service log and exposed through the completed-turn UI extension. The plugin never appends a synthetic `user/message`, so write-back cannot change model context, the conversation tail, or branching semantics.
12. Before every later model request, legacy plugin notices and prior recall snapshots are removed from the final request message list. Extraction snapshots accept only direct user messages.

The extractor explicitly refuses secrets and ephemeral output in its system policy. Conflicts always remain behind human review, including on direct-write mounts.

### Durable outbox and retry boundaries

- `writeback/queue.ts` owns a separate SQLite WAL database (`synchronous=FULL`, file mode 0600). `writebackQueuePath` overrides the default next to the database/connection configuration. Use a separate path per DSH profile. `:memory:` is for isolated tests, not durable production storage.
- Enqueue and retry only persist state, then schedule a worker. One leased worker runs per outbox; unfinished jobs in the same session stay ordered. A failed predecessor blocks that session and the UI explains why; other sessions continue. Queue capacity is 1,000 unfinished jobs. It never evicts pending/failed jobs. Capacity/disk failures show an explicit enqueue error; if disk persistence failed, only the current process can retain a retry snapshot.
- `extraction.ts` persists the entire validated mutation plan and its direct/audit decisions before the first write. Retries reuse it without another model call. Current mounts are rechecked before delivery; removed permissions fail visibly instead of rerouting or bypassing review.
- Direct-write receipts are saved in the knowledge server's SQL transaction alongside entry changes and approval. They are keyed by source and a bounded SHA-256 digest of the original proposal. Lost acknowledgment and Markdown projection failure retry the same receipt/projection without appending again or creating another version. Remote direct writes negotiate this capability; old servers must upgrade before retrying.
- Transient failures use 5/15/60/180-second backoff, with at most five attempted executions before manual retry. Configuration/permission failures require manual correction and retry. Shutdown and waiting for an active claim do not consume the retry budget. Restart resumes queued work; recovery may wait up to the existing server's 15-minute claim lease. Completed jobs retain status/destinations but release their snapshots/plans; failed jobs retain both.
- `writeback/status-client.ts` owns cancellable status requests. Retry immediately disables repeat clicks, invalidates older GET responses and restarts polling. Hidden/off-screen turns pause polling; focus/network recovery refreshes status. Status is keyed to the original session/turn, never to the current conversation tail. Legacy failed records without an outbox snapshot remain visible but cannot be safely reconstructed for retry.
- This is at-least-once execution with idempotent write effects, not a distributed transaction across channel delivery and knowledge writes. Channel delivery can succeed while writeback fails. Storage loss, revoked credentials and an unavailable server cannot be guaranteed away; failures remain explicit and recoverable once their cause is corrected.

## Artifact archiving flow

Artifact capture is event-sourced, not a filesystem watcher and not another model call:

1. `agent/turn-stopping` reads the completed turn's own event slice and collects every file the task touched: `deliverables/presented` declarations, every tool call's path-shaped arguments (`read`, `read_image`, `str_replace_editor view`, `write`, `edit`, conversion tools), path tokens in `bash`/`pwsh` commands, `@path` references in the user message, uploaded `file`/`image` blocks, and additionally the `workspace/changes` summary for files the shell changed. The optional `workspaceChanges` service is read lazily; when it is absent the other signals still apply.
2. Path candidates are resolved against the Session working directory, de-duplicated per turn (up to 128) and validated by the archiver: archive-root containment, exclusions, regular file, size. The extension allowlist defaults to `*`, so every format is captured; a configured list still narrows ordinary file-tool writes while referenced/changed/delivered/uploaded files stay included. Uploaded attachments are read through the Host `attachments` service (`readFileStream`/`readImage`, falling back to `fileHostPath`). Nothing is read until a candidate passes the non-content checks.
3. Capture passes are serialized per plugin instance. Each changed file is copied into the archive (`artifacts/blobs/<sha256[0:2]>/<sha256>.<ext>`) and recorded in an atomically replaced `index.json`; identical bytes reuse the same blob and leave the knowledge document untouched. Upload records are keyed by attachment id, so resending the same attachment is a no-op.
4. One knowledge document per artifact is created in the `制品归档` base (auto-created on first use) or updated in place with the current version as the expected version. PDFs that look like papers are instead filed in the single `论文库` base (`paper.ts`: title, abstract, keywords, arXiv/DOI, year and category from arXiv codes or deterministic topic rules), grouped as `论文 · <category>`; no per-paper base is ever created. By default the document stores metadata, the paper abstract, extracted keywords, the absolute archive-file path and a `read` hint; extracted text is used solely for metadata/keywords and is embedded only when `artifactArchiveStoreContent` is enabled. Keyword lines and abstracts participate in full-text search and `bodyKeywords()` relations, so files sharing terms link in the graph without duplicating the full paper in SQLite. A lost manifest recovers by adopting the single byte-equivalent document instead of creating a duplicate; finalized documents are left untouched and a new document is created.
5. Text extraction is local and bounded: plain text decoding, the existing PDF parser, and Open XML/ODF container XML for Word, PowerPoint, spreadsheet and ODF files. Paper metadata is deterministic (no model call); images and other binaries keep metadata only. New knowledge bases from conversation extraction are capped per turn and per day (`autoCreateKnowledgeBasesMaxPerDay`) and reuse existing names, so automatic classification cannot explode the base list.
6. The base is mounted on the producing project with `recallEnabled: true` and `writeMode: none`. The mount is created only when absent, so a user-disabled recall setting and the extraction write path stay untouched; the artifact mount never receives conversation write-back.
7. Artifact documents use `type: fact`, `scope: project(cwd)` (or global without a workspace), a file-category document group (`制品 · <category>`), tags `artifact`, `deliverable`/`upload`, the extension and the capture source, and evidence `verified`. They participate in FTS, `knowledge_search`, bounded automatic recall and document version history exactly like reviewed knowledge. No candidate or review row is created, so the capture never enters the audit queue.

The archive is deliberately separate from the provider: it stays useful in remote mode, requires only ordinary provider `write` capability for the knowledge document, and a failure is logged and isolated to that file. `GET /knowledge-control/v1/artifacts` exposes a bounded, same-origin read-only index and download route; the management console's 「制品文件」 view uses it for preview, download and "open the generated document" navigation, where the existing editor supplies rename, edit, group change and cross-base move. The route never authorizes the public Bearer API.

## Automatic classification and columns

Extraction already reused supplied `documentGroups` names and created a new topic group when needed. `extraction.ts` now also accepts an optional `newKnowledgeBase {name, description}` on a `create` candidate when no mounted destination fits. Parsing validates it against a transient virtual mount, so the normal policy, sensitivity and coalescing stages still apply. After model extraction, `resolveAutoDestinations` reuses an active base with the same normalized name or creates one, mounts it on the project (or session when there is no project) with `writeMode: direct` and `recallEnabled: true`, and repoints every proposal at the durable base id. One new column per model response is enforced; the new base's description becomes its routing description for later turns.

## Review-free delivery

`auto-approve.ts` runs a bounded approver every `autoApprovePendingIntervalMinutes` (default 2) and at each turn stop. It lists pending candidates, excludes conflicts and credential-like holds from the exclusion-free batch, and calls `approvePendingBatch`, which already skips conflicts. Ordinary audit-mode proposals therefore become documents without a click, while ambiguous conflicts and secrets stay pending. `noteOrganizeAutoApprove` applies the same policy to the note organizer: the generated proposal is approved into the note workspace immediately instead of waiting in the draft queue.

## Document links

`document-links.ts` derives bidirectional links when a document is read; it never rewrites bodies, so opening a document cannot create versions, disturb in-flight extraction or overwrite manual edits. For the active document in one base it scans a bounded page (100 active entries, same base only):

- explicit `[[Title]]` references are resolved by normalized title (NFKC, collapsed whitespace, case-insensitive) and returned as `references` for clickable preview anchors;
- shared non-generic tags, the same document group and title-token overlap form a symmetric relation, so both documents list each other under 关联文档;
- explicit incoming references appear as 反向链接 on the target;
- a fallback picks one same-group (or first) document so a non-empty base never renders an empty panel.

The management API adds `GET /entries/:id/links` under the existing read permission; the remote console proxy forwards it unchanged, so a central server on this version serves it too. `web/app.js` renders the panel under the document, converts `[[Title]]` text nodes outside code blocks into in-page anchors, and opens the target through the existing document loader (cross-base targets switch to the document workspace). Links are read-only: editing or moving a document re-resolves them on the next open.

## Background status and link graph

`background-status.ts` registers a same-origin `GET /knowledge-control/v1/background-status` surface. It reads only in-memory counters: `ArtifactArchiver.status()` (queued passes, active batch total/done/current file, last summary), `WritebackQueue.counts()` (`queued`/`running`/`failed` from SQLite), and `JournalRuntime.isRunning()` for report generation. The console polls it every three seconds and swaps a fixed status card; the endpoint never exposes file contents, payloads or session text. `registerBackgroundStatusControl` is installed with the other HTTP surfaces and disposed with them.

`document-graph.ts` builds the graph for one knowledge base from up to 100 active entries. Bodies are parsed once into `LinkInput` sets, every unordered pair is scored with the same `relationBetween` rules as the document-link panel, and edges keep their dominant reason. `GET /graph?knowledgeBaseId=...&limit=...` returns `{knowledgeBase, nodes, edges, truncated}` under the normal read permission. The console renders it in a canvas force simulation: group-colored glowing nodes, curved edges with travelling particles, drag/zoom/hover/click, a reduced-motion static fallback, and a keyboard-operable node chip list. Clicking a node routes through the existing document loader, so the graph stays read-only.

## Folder import and plugin integration

`folder-import.ts` walks a user-selected directory with bounded breadth/depth, never follows symlinks, skips dependency/VCS/build folders and the archive/data roots, and returns absolute file paths. The management route pair is `GET /knowledge-control/v1/folders` (directories only) and `POST /knowledge-control/v1/artifacts/import` (`{path, projectId?}`): the latter validates the path, scans up to 800 files, queues candidates with source `folder`, and returns immediately; the existing serialized archive pass then applies the same exclusions, paper detection, grouping, links and indexing as turn-produced files.

`integration.ts` provides the optional Cordis service `dshKnowledge` and the write bus. `KnowledgeWriteBus` fans one `KnowledgeWriteEvent` out to in-process listeners and to the Cordis event `knowledge/write`; archive callbacks, the extraction coordinator and the knowledge watcher all publish through it. `ingestRecord` writes a normal knowledge document, `ingestFiles` feeds the archive queue, `search`/`listBases`/`introduceBase` reuse provider contracts, and `onWrite` subscribes. Consumers must treat the service as optional and degrade when absent.

## Conversation knowledge-base introduction

`knowledge-base-mention-source.ts` registers a second `@` input-trigger source. Its candidates come from the same-origin conversation activity surface: `GET /knowledge-control/v1/activity/knowledge-bases?sessionId=...&q=...` returns active bases with a `mounted` flag. Picking a candidate inserts a normal reference chip, so editing, undo and copy behave like a file mention.

At submit time the codec calls `POST .../knowledge-bases/:id/introduce?sessionId=...`, which upserts a **session mount** with `recallEnabled: true` and `writeMode: none` (reusing an already-enabled session mount). Serialization then returns a short instruction block naming the base. Because the mount exists before the next `agent/pre-step`, the existing recall path searches it, `knowledge_search` can address it, and `knowledge_read` accepts its handles; conversation extraction still writes only to writable mounts. A read-only remote token without mount permission fails the submit instead of silently sending without the base.

## Work journal integration

Knowledge writes feed the built-in worklog. `KnowledgeWriteEvent` (from `src/knowledge-events.ts`) is emitted by the completed-turn extractor after a direct document write and by the artifact archiver after a new document version; code-category artifacts are archived and linked but intentionally do not emit a worklog event, so routine source reads cannot flood the daily report. `src/index.ts` forwards it to `journalRuntime.recordKnowledge` unless `worklogAutoUpdateEnabled` is false.

Inside the bundled worklog runtime, `worklog/knowledge.js` builds a normal source record (`captureKind: 'knowledge'`, project, document, action, session/turn, model route) so existing source paging, exclusion, history, central sync and report generation work unchanged. `JournalService.recordKnowledge` provisions the journal on first use: capture is enabled, the affected project is added to the selected scope, and daily generation is switched on; an already enabled journal only gains the project. Remote connections queue the record through the existing outbox.

`createRefreshScheduler` coalesces bursts with an 8-second timer and enqueues the day's report job; the worker's 1.5-second tick then generates it with the configured or last-seen model route. While a generation is running, new material is retried until it is covered by a later report version. A report whose body was manually edited is never replaced automatically — the scheduler logs and skips, leaving the existing manual `allowReplace` flow in control. This reuses the durable job queue, revision validation and retry policy rather than adding a second generation path.

`knowledge-watcher.ts` is the safety net for writes that bypass the two callbacks (management-console edits, background approvals, other clients of a local base). It baselines current versions on startup, then compares a bounded page ordered by `updatedAt` about once a minute. Content hashes decide whether a version bump is a real content change, so finalize/reopen/archive status changes emit nothing; generated events reuse `<documentId>:<version>` ids, which the journal deduplicates against direct events. Remote providers are excluded from polling because their write path already queues records through the callbacks.

## Writable mount provisioning

A recall-only artifact mount cannot receive completed-turn write-back, so a project with no writable mount reports “未挂载可写知识库” and silently drops extracted knowledge. `auto-writable.ts` closes that gap with a cached, revision-aware guard: on the first `agent/pre-step` of a turn (and again at `agent/turn-stopping`), it resolves the session's mounts; when none is enabled with `writeMode !== 'none'`, it mounts the built-in default base on the project with `autoWritableMountWriteMode` (`direct` by default, `audit` optional). A disabled row, or a recall-only row for the default base, is treated as an explicit override and left unchanged. Cache keys are `project + base` and are cleared when the provider connection revision changes, so a local/remote switch re-runs the check against the authoritative provider. The guard never creates a knowledge base: the default base ships with the schema and cannot be archived.

## Recall flow

Recall combines bounded automatic retrieval with model-driven tools:

- the official `system-prompt/assemble` waterfall contributes a bounded map containing mounted-base names, ids, descriptions and tags, but no document body;
- on the first step of each direct user turn, the plugin searches mounted bases, applies a configurable relevance floor and injects at most `autoRecallLimit` partial snippets with signed handles;
- `knowledge_base_search` matches the current information need against the names, routing descriptions and tags of recall-enabled mounted bases, returning metadata only;
- `knowledge_search` requires one exact base returned by the discovery tool and returns ranked snippets with signed handles;
- `knowledge_read` opens an exact result through a signed, session-bound handle and paginates long documents;
- `knowledge_note_list` browses one note folder or searches all note-node names, returning signed session-bound handles;
- `knowledge_note_search` searches non-folder note metadata without returning bodies;
- `knowledge_note_read` reads bounded UTF-8 chunks only after an explicit note request;
- `knowledge_note_create`, `knowledge_note_update`, `knowledge_note_move`, and `knowledge_note_delete` mutate the active local or remote note workspace only after a matching direct user request; remote permissions and referenced-note deletion protection remain server-enforced;
- `knowledge_note_references` lists, adds or removes relation rows using exact knowledge and note handles, re-resolving live mounts and rejecting writes through read-only mounts or finalized documents;
- content write-back, including an explicit user request to save knowledge, runs only in the separate completed-turn extractor and never in the main Agent loop;
- remote retrieval is awaited, cancellation propagates through the current turn signal, and independent per-mount requests run through a shared four-worker bound rather than an unbounded `Promise.all` fan-out;
- greetings and empty input skip automatic retrieval, and search failures fail open so the normal answer can continue.

Only active entries from recall-enabled resolved mounts are searchable. Each stage re-resolves live mounts, and search/read enforce include/exclude tags and project scope. Exact project entries rank before global entries. Automatic snapshots are partial reference data and are removed before later steps; full document content enters the request only through `knowledge_read`.

The prompt catalog states a strict response-isolation contract: the main model must never narrate persistence attempts, refusals or results. Every answer, including one that explicitly requests persistence, is handled by the bounded completed-turn extractor, which receives canonical source URLs present in the final answer but never raw tool output or prior plugin notices.

## Local and remote topology

Local and remote modes are mutually exclusive for one plugin instance. There is deliberately no transparent cache or two-way synchronization: that would create conflict semantics at a second layer and obscure which database is authoritative.

A local provider always supports its same-origin management console unless `exposeWeb` is explicitly disabled. Local runtime calls and the management console borrow the same provider instance, avoiding duplicate SQLite connections and startup projection passes; the provider router tracks borrowed ownership so switching to remote never closes the management store. This internal surface is distinct from the public API: enabling the public route is an explicit, persistent action in “访问管理”, and enabling it prevents the same instance from switching to a remote provider. In remote mode the same embedded console uses a bounded same-origin server proxy to the configured central API; the browser never receives the saved remote token, and central access-management controls remain hidden. Remote clients use the same provider contract, so extraction candidates and recall work identically. Network timeouts and DSH turn cancellation bound remote requests.

## Security boundaries

Automatic writeback builds a deterministic, bounded retrieval hint from the question, Markdown headings and code identifiers (`search-query.ts`); the extractor still receives the original conversation. This adds no model calls. Search failures remain fatal to writeback so unavailable duplicate detection cannot silently create new documents. Remote search keeps GET for URLs up to 6,000 encoded bytes and uses authenticated POST JSON beyond that. Only explicit unsupported-route responses (404/405/501) fall back to a compact keyword GET for older servers; project, base, tag and type filters are retained. Search errors report status and endpoint without echoing conversation queries or proxy error bodies.

- Stored connection secrets are never returned by plugin control APIs or written to logs.
- Server tokens are stored as SHA-256 digests; generated client tokens are shown once.
- Permissions are capability-oriented: `read`, `propose`, `write`, `admin`. `write` is currently instance-wide and also covers knowledge-base, mount, and note mutations; ordinary remote clients should use `read + propose` unless they explicitly need that broader authority.
- JSON request bodies are capped at 1 MiB and every domain value has size/range validation. Only note content upload/download routes use the separate 64 MiB bound; the remote management proxy preserves the same distinction.
- Hard deletion and token management require admin.
- Remote URLs require HTTPS except explicit loopback testing.
- Knowledge and note tool handles are HMAC-signed and bound to the calling session. Reference mutations re-authorize the knowledge document against live mount, project, tag and write policy; note metadata search never returns file content.
- The embedded DSH web server has no TLS; LAN/public exposure requires an HTTPS reverse proxy.
- The management console uses a dedicated same-origin API guarded by Fetch Metadata, origin checks and a non-simple client header; it never makes the public Bearer API implicitly available.
- Public API routes always require Bearer capabilities. Any user who can access the DSH Web origin can administer the local knowledge base, so public DSH deployments must protect the whole origin with authentication at the reverse proxy.

## Deferred modules

- Explicit export/import jobs.
- Optional embeddings/reranking behind a retrieval port.
- Retry controls for failed extraction jobs.
- Multi-user tenant isolation.

These are additions around existing boundaries; none requires changing the entry, candidate or provider semantics.
