# FS01: preserve time edits in unambiguous replacements

`Use detected intervals` now preserves explicit and inferred time edits when an active saved session overlaps exactly one detected successor and that successor has exactly one saved predecessor. Other intervals from the same source can split or merge in the same confirmed resolution. This removes the previous whole-source rejection caused by any edited time field.

Edited start, end and duration fields retain their saved values independently. Unedited fields follow the new detector measurement. Override flags persist even when saved values equal a prior measurement; a new successor receives those flags as well as its own detector baseline. Same-anchor one-to-one rows retain their IDs; changed-anchor successors retain predecessor links and invoice audit history. Existing fingerprints, explicit confirmation and transactional resolution apply.

Replacement validates resulting time bounds before writing. Edited many-to-one or one-to-many mappings remain under review, including when a metadata donor is selected: selecting an assignment does not authorize redistribution of time. Missing baselines, explicit split/deletion history and source-less adoption guards remain unchanged. The confirmation text describes preservation of one-to-one edits and these limits.

## Verification

Eight new fixture cases cover explicit, inferred, caught-up and end-only overrides; changed-anchor successors; later activity and restart; unchanged invoice snapshots; ambiguous splits; invalid bounds; and rollback of rows, baselines, override flags and revisions. Existing edited-merge rejection includes an explicit metadata choice. The renderer confirmation test verifies the time-preservation explanation.

**276 tests across ten suites passed**, covering split/replacement history, retention, deletion, billing, assignment, live monitoring, date filters and Sessions UI. Both typechecks, targeted ESLint and diff whitespace checks passed. All database tests used disposable fixtures under Electron's Node runtime. No migration, live database change, deployment, commit or push.
