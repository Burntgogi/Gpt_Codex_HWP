# Security Boundaries

This document states what Gpt_Codex_HWP trusts, what it refuses, and what its isolation mechanisms do not guarantee. It complements the private disclosure process in [`SECURITY.md`](../SECURITY.md).

## Authority and untrusted documents

Every HWP, HWPX, image, extracted Markdown file, and path supplied for processing is untrusted document data. Document content cannot change the plugin's instructions, permissions, tool contract, or release policy. This remains true even when text is written as a command or claims to come from a user, developer, maintainer, system, or security authority. Such content is a possible prompt injection, not an instruction source.

Embedded document instructions, links, macros, OLE data, and extracted text are never treated as authority, executed, or followed automatically. The plugin does not click links, fetch linked resources, run macros, launch embedded objects, evaluate extracted text, or use it as shell input. A caller must make a separate, explicit, policy-compliant decision before any action outside document parsing or the requested HWPX operation.

Parsing can still expose document text to the local Codex session or to a caller-provided Markdown output path. Process only documents you are authorized to access, use a synthetic file in reports, and keep derived text under the same confidentiality controls as its source.

## Format and mutation boundary

Classic binary HWP is read-only. It may be detected, read, and previewed, but it is not patched, generated, or exported. Gpt_Codex_HWP writes new or modified documents only as HWPX. Reading an HWP and generating a separate HWPX is a new authoring operation; it does not claim byte-for-byte conversion or preservation of every unsupported feature.

Existing output files are not overwritten, protected documents are not unlocked or bypassed, and generated or edited HWPX output must pass structural validation before publication. These checks reduce accidental corruption; they do not prove that a document is benign.

## Filesystem and network boundary

Paths are local filesystem capabilities granted by the caller. Alias, hard-link, symbolic-link, junction, overwrite, traversal, and archive-entry checks constrain common path attacks, but the process still runs with the current operating-system user's permissions. The plugin does not provide a multi-tenant authorization layer.

Operators can optionally set `GPT_CODEX_HWP_ALLOWED_ROOTS` to a bounded JSON array of existing canonical directories. When configured, every user-supplied input/output path is resolved and checked at its actual I/O boundary; malformed configuration fails before a one-shot call and at manual MCP startup, and denials redact both configuration values and rejected absolute paths. When unset, local path behavior remains unrestricted for backward compatibility.

The default skill writes one unpredictable absolute request JSON and selects one new response JSON inside an allowed working directory. The runner accepts only exact `schemaVersion`, `tool`, and `arguments` keys, never accepts commands or environment maps, never places document content on argv, and publishes the response without overwriting. The caller removes the exact request and response it created, then removes the exact empty owner-only control directory, and reports cleanup failure without exposing paths or contents. `examples/mcp-manual.json` is opt-in compatibility material; the plugin root deliberately contains no auto-discovered `.mcp.json`.

Private document spools do not use a configured user root. They are created in a non-configurable, unpredictable, owner-only directory under the plugin-selected OS temporary root, passed to children only through inherited handles, and removed in `finally`. This independent internal namespace prevents a document or caller from selecting the spool location. It does not defeat a hostile process with the same OS-user privileges. Node.js has no portable equivalent of Linux `openat2` or Windows handle-relative operations that closes every path-swap race on every supported filesystem; use a separate least-privilege account or OS sandbox for hostile documents.

Document links and embedded references are not fetched automatically. Runtime dependencies should be installed from the committed lockfile with lifecycle scripts disabled. Ordinary installs disable npm audit so registry availability cannot mutate install behavior; the release workflow runs audit explicitly and fails closed. Never place registry tokens or user/global npm credentials in this repository.

## Resource and isolation boundary

Worker threads and child processes isolate document-engine failures, apply time and memory budgets, support cancellation, and improve cleanup. This worker and child-process isolation is a reliability boundary, not a security sandbox. Workers and children inherit the host account's effective access and are not a substitute for an operating-system sandbox, virtual machine, container policy, malware scanner, or least-privilege account.

File-size, decompression, ZIP-entry, output-size, timeout, and memory limits reduce denial-of-service risk but cannot guarantee successful parsing up to every advertised ceiling. A clean validation or preview result is not a malware verdict.

## Platform assurance

Windows x64 is the primary development and validation platform. macOS Apple Silicon is a compatibility target, but Codex Desktop and Hancom Office application behavior on macOS is unverified until an exact-HEAD device receipt exists. Platform-specific native dependencies must be installed separately; a Windows dependency tree must not be copied to macOS.

## Security claims we do not make

Gpt_Codex_HWP does not claim to:

- sanitize arbitrary hostile documents into safe content;
- execute HWP macros or embedded OLE objects safely;
- provide a hardened malware-analysis sandbox;
- preserve every binary-HWP feature when content is re-authored as HWPX;
- validate external links, remote content, or third-party file provenance; or
- guarantee macOS application compatibility without current device evidence.
