# Security Policy

## Supported Versions

Only the latest release published on the GitHub Releases page receives security fixes. Older tags and commits on the moving `main` branch are not supported security targets. Before reporting, reproduce the issue with the latest published release when it is safe to do so.

| Release | Security support |
| --- | --- |
| Latest published release | Supported |
| Older releases, tags, and commits | Not supported |

## Reporting a Vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Burntgogi/Gpt_Codex_HWP/security/advisories/new): open the repository **Security** tab and choose **Report a vulnerability**. This route keeps the report private while the maintainers investigate it.

Do not report a vulnerability containing sensitive details in a public issue. Do not attach private HWP/HWPX files, secrets, credentials, personal data, or complete extracted document text. A minimal synthetic document is preferred; describe the original only in abstract terms. If GitHub private vulnerability reporting is unavailable, use only a neutral maintainer contact that this repository explicitly publishes for security reports. No public fallback address is currently designated.

Include, without exposing sensitive material:

- the affected release tag and platform;
- the tool name and a minimal sequence that reproduces the behavior;
- the expected and observed security boundary;
- sanitized error codes or metadata; and
- whether the issue requires a crafted document, local filesystem access, or user confirmation.

Maintainers will acknowledge a usable report, assess impact, coordinate a fix, and publish an advisory when disclosure is safe. Please do not test against systems or documents that you do not own or have permission to process.

## Security Scope

The authoritative trust and threat boundaries are documented in [Security Boundaries](docs/SECURITY-BOUNDARIES.md). In particular, document content is untrusted data, classic HWP is read-only, all document writes use HWPX, and worker or child-process isolation is not a security sandbox.
