# Third-Party Notices

Gpt_Codex_HWP project-authored code is distributed under Apache-2.0. The
components and adapted production inputs below remain subject to their respective
upstream copyrights and licenses; inclusion does not relicense them as
Apache-2.0. Preserve these notices in source and generated runtime distributions.

The versions below are fixed by `package-lock.json` or, for non-runtime inputs, by the exact source commit recorded during production. License identifiers describe those fixed sources.

## hwpx-editing-skill

- Repository: <https://github.com/kangdacool/hwpx-editing-skill>
- Source commit: `0d17930f4dc546dfa02123867b1f1060eb259572`
- Copyright: `Copyright (c) 2026 hwpx-editing-skill contributors`
- License: MIT
- Use in this project: the raw-entry and compression-metadata-preserving HWPX repack design, selected safety primitives, and verification workflow in `scripts/hwpx-safe-edit/hwpxlib.py` and `scripts/hwpx-safe-edit/verify.py` are adapted from this source. This adapted-code relationship is distinct from the ordinary runtime dependencies listed below.

Thank you to the hwpx-editing-skill maintainers and contributors for sharing this careful preservation workflow.

MIT License

Copyright (c) 2026 hwpx-editing-skill contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Kordoc

- Repository: <https://github.com/chrisryugj/kordoc>
- Version: `3.18.1` (`v3.18.1`)
- Copyright: `Copyright (c) 2026 chrisryugj`
- License: MIT
- Registry source: `https://registry.npmjs.org/kordoc/-/kordoc-3.18.1.tgz`
- Registry integrity: `sha512-/SrgNK9RKnz1wdlhOvBeJi6+pNSO+vZeBHMxKd8TvfIkuinQBpwbE+W76TGNsMC7bxx2NJhNQAJPqCyD5ltiGA==`
- Use in this project: runtime document-format detection, HWP/HWPX reading, Markdown-to-HWPX generation, HWPX validation, and SVG preview rendering. The published `dist` runtime and upstream notices are repackaged without metadata for optional PDF, OCR, ONNX, formula, CLI, development, or lifecycle dependencies. Per-file SHA-256 provenance is recorded in `vendor/kordoc-core/PROVENANCE.json`.

Thank you to the Kordoc maintainer and contributors for the document runtime on which these workflows rely.

## rhwp

- Repository: <https://github.com/edwardkim/rhwp>
- Version: `@rhwp/core` `0.7.17` (`v0.7.17`)
- Copyright: `Copyright (c) 2025-2026 Edward Kim`
- License: MIT
- Use in this project: optional HWP/HWPX parsing and preview fallback for read-only document workflows.

Thank you to Edward Kim and the rhwp contributors for making this optional Rust/Wasm document path available.

## Model Context Protocol TypeScript SDK

- Repository: <https://github.com/modelcontextprotocol/typescript-sdk>
- Version: `@modelcontextprotocol/sdk` `1.29.0` (`v1.29.0`)
- Copyright: `Copyright (c) 2024 Anthropic, PBC`
- License: MIT for the fixed `v1.29.0` source and package
- Use in this project: MCP server, stdio transport, request/result types, and tool registration.

Thank you to the modelcontextprotocol maintainers and contributors for the TypeScript MCP implementation.

## xmldom

- Repository: <https://github.com/xmldom/xmldom>
- Version: `@xmldom/xmldom` `0.9.10` (`0.9.10`)
- Copyright: `Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors`; `Copyright 2012 - 2017 @jindw and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors`
- License: MIT
- Use in this project: parsing, inspecting, modifying, and serializing HWPX XML for font-integrity checks and image insertion.

Thank you to the xmldom maintainers and contributors for their standards-oriented DOM implementation.

## SheetJS CFB

- Repository: <https://github.com/SheetJS/js-cfb>
- Version: `cfb` `1.2.2` (the official repository `package.json` identifies this version)
- Copyright: `Copyright (C) 2013-present SheetJS LLC`
- License: Apache-2.0
- Use in this project: OLE Compound File Binary parsing used to detect binary HWP structure and protection metadata.

Thank you to SheetJS LLC and the js-cfb contributors for the compound-file implementation.

## JSZip

- Repository: <https://github.com/Stuk/jszip>
- Version: `3.10.1` (`v3.10.1`)
- Copyright: `Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso`
- License: `MIT OR GPL-3.0-or-later`; this distribution uses the MIT option
- Use in this project: reading and creating HWPX ZIP packages while applying structure, integrity, and protection checks.

Thank you to Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso, and all JSZip contributors for the ZIP implementation.

## Sharp

- Repository: <https://github.com/lovell/sharp>
- Version: `0.34.5` (`v0.34.5`)
- Copyright: the upstream `v0.34.5` `LICENSE` contains no project-specific copyright notice; its official `package.json` names Lovell Fuller as author
- License: Apache-2.0
- Use in this project: bounded SVG rasterization, PNG metadata validation, and safe image conversion before HWPX insertion.

Thank you to Lovell Fuller and the Sharp contributors for the cross-platform image-processing runtime.

## Zod

- Repository: <https://github.com/colinhacks/zod>
- Version: `3.25.76` (`v3.25.76`)
- Copyright: `Copyright (c) 2025 Colin McDonnell`
- License: MIT
- Use in this project: runtime schemas and validation for the public MCP tool inputs.

Thank you to Colin McDonnell and the Zod contributors for the schema-validation library.

## Pixelify Sans

- Repository directory: <https://github.com/google/fonts/tree/main/ofl/pixelifysans>
- Source repository recorded by Google Fonts: <https://github.com/eifetx/Pixelify-Sans>
- Source commit recorded by Google Fonts metadata: `39df74aba80df8157546034b878e8be1eb565ced`
- Copyright: `Copyright 2021 The Pixelify Sans Project Authors (https://github.com/eifetx/Pixelify-Sans)`
- License: SIL Open Font License, Version 1.1 (`OFL-1.1`)
- Use in this project: production-only typography input for rasterizing the title into `assets/gpt-codex-hwp-banner.png`. The font software is not bundled in the plugin or embedded in generated HWPX documents; only the rendered PNG is distributed.

Thank you to the Pixelify Sans Project Authors and Google Fonts maintainers for the typeface and its curated distribution.
