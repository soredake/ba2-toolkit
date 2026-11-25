# Archive2 fixtures

These three archives were produced by Bethesda's own archiver,
`Archive2.exe` build 1.1.0.5, which ships with the Fallout 4 Creation Kit
(`Tools/Archive2/Archive2.exe`). They prove that this reader handles archives written
by the official tool, not only by `scripts/make-fixtures.mjs`.

The payloads are the synthetic files from `../gnrl.ba2` and `../dx10.ba2` (patterns,
text and generated textures), so no Bethesda content is redistributed. Archive2 wrote
version 8 headers, which also exercises the version gating in `src/ba2/reader.ts`.

| File | Created with | Contents |
| --- | --- | --- |
| `general-v8.ba2` | `-compression=Default` | the four GNRL fixture files minus the zero-byte one (Archive2 skips empty files) |
| `dds-v8.ba2` | `-f=DDS -compression=Default` | `textures/detail_n.dds` and `textures/wall_d.dds` as DX10 records |
| `nostrings-v8.ba2` | `-nostrings -compression=None` | all three DDS files in a GNRL archive with `name table offset = 0` |

To reproduce them, extract the two fixture archives, then run (absolute paths are
required, relative paths make Archive2 throw a `UriFormatException`):

```bash
Archive2 "C:/fixtures/gnrl-src" -create="C:/fixtures/general-v8.ba2" \
  -root="C:/fixtures/gnrl-src" -compression=Default
Archive2 "C:/fixtures/dds-src" -create="C:/fixtures/dds-v8.ba2" \
  -root="C:/fixtures/dds-src" -f=DDS -compression=Default
Archive2 "C:/fixtures/dds-src" -create="C:/fixtures/nostrings-v8.ba2" \
  -root="C:/fixtures/dds-src" -nostrings -compression=None
```

Archive2 refuses to import cubemap DDS files, so `textures/sky_e.dds` is absent from the
DDS and no-name archives.
