# rhwp real-HWP regression fixture

`re-01-hangul-only-hancom.hwp` is copied byte-for-byte from rhwp release
`v0.7.17` at revision `03351190ec35436e58cbfee0aa9278a8fdc04a59`.
The upstream addition commit added this file as one of the rhwp-generated,
Hancom-saved LINE_SEG comparison and regression samples.

- [Immutable upstream file](https://github.com/edwardkim/rhwp/blob/03351190ec35436e58cbfee0aa9278a8fdc04a59/samples/re-01-hangul-only-hancom.hwp)
- [Fixture addition commit](https://github.com/edwardkim/rhwp/commit/a200cfd93d100a6f20f29bb0b836b4bc6faa37fd)

This is a development-only test fixture. It is included in the public source
repository and therefore in its source archives, but it is not included in the
`plugins/gpt-codex-hwp` runtime projection. Packaging gates for attached plugin
runtime assets must continue to exclude it. Its exact origin and integrity
values are recorded in `provenance.json`, and its upstream MIT license is
preserved in `LICENSE` beside the fixture.

The immutable upstream fixture contains upstream-public author and application
metadata, including a username and local temporary path recorded by its source
application. Those values belong to the upstream test artifact; they are not
data from this project's current user or contributors. Privacy and release
checks must allowlist this artifact only by its exact SHA-256 and must not
reproduce the embedded path verbatim in logs, reports, or documentation.
