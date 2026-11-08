# Lucky reliable note sync (2.99.3)

Requires the matching Lucky Fast Note Sync service build `3.6.1-lucky.1`. Install the plugin on every participating device. Older clients retain their original write behavior; installing this plugin cannot change another device's old client.

The service performs three-way text merges. Each upload carries its exact ancestor text, an immutable request ID and the submitted snapshot. Successful acknowledgements include the actual stored text and an ordered revision. Typing during an upload retains the submitted snapshot as the next draft's ancestor. Overlapping changes preserve the incoming manuscript as a deterministic synced `.conflict.<id>.md` note.

The client persists each note separately under its plugin directory in `merge-journal/`. Two alternating checksummed slots retain the preceding complete commit if one write is interrupted. Only the changed note is serialized. The journal is excluded from config sync and must remain local to each device. `merge-journal.json` from the earlier experimental build is read for migration; preserve it and the journal directory when backing up or diagnosing an unresolved upload.

On first upgrade the plugin asks the service for real text before accepting an old hash as a baseline. Equal 32-bit hashes alone do not prove equal content. The client requires `MergeCapabilities` before uploading with this protocol. A missing capability leaves local drafts in place.

Deletes and renames use persistent request identities and the last observed source revision. Replaying an old operation cannot delete a later recreation. A remote rename requests the target's actual text instead of treating its old local text as the latest server revision. A local edit that races a remote deletion is preserved in a server conflict note; typing after that submission is additionally retained in local `lost-notes/`, without automatically resurrecting the deleted path.

The service stores immutable SHA256 body blobs before committing their database references. The legacy `content.txt` file remains a compatibility projection. Before reverting the service to upstream 3.6.1, stop the service and run the supplied projection verification/rebuild tool; do not restore a database or vault backup over newer user content as an ordinary rollback.
