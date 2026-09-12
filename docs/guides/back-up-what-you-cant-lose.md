# Back up what you can't lose

**The fear it answers:** the #1 reason people stay on managed platforms is
the terror of losing data. gitlive's answer: verified, encrypted restic
snapshots of each app's data — with a receipt for every snapshot, and a
restore that never silently overwrites what's live. A backup you can't
verify is a wish, not a backup.

## The flow

```bash
gitlive backup init          # once — encrypted repo at ~/.gitlive/backup-repo
gitlive backup myapp         # snapshot the app's data + deploy history
```

Every snapshot:

- lands in the app's `backup-history.jsonl` (a receipt), AND
- appears in the audit events — so the dashboard's notifications inbox
  shows backups as real facts.

Verify — twice, because a backup you can't prove restores is a wish:

```bash
gitlive backup list myapp    # what exists, newest first
gitlive backup check         # restic check — the repository verifies
gitlive backup verify myapp  # the DRILL: restores the newest snapshot to a
                             # throwaway dir, compares every file byte-for-
                             # byte, receipts the outcome
gitlive backup restore myapp --to ~/restored
```

Restore deliberately writes into the directory YOU choose — never into
the live app's data. To apply a restore:

```bash
gitlive stop myapp
cp -R ~/restored/data/* ~/.gitlive/apps/myapp-run/data/
```

## Nightly

gitlive prints the command; scheduling stays yours (cron/launchd is your
tool, and a scheduler gitlive doesn't supervise would be worse):

```cron
0 3 * * *  gitlive backup myapp
```

## The two rules that make it a real backup

1. **The key is the backup.** `~/.gitlive/backup.key` decrypts everything
   in the repo. Losing it = unrecoverable. Copy it somewhere safe.
2. **Offsite is your copy job.** A backup on the same disk as the app is
   a convenience. Copy the repo (and the key) to another machine or
   bucket — restic's own `restic copy` or plain rclone do it; the point
   is that the copy exists somewhere the app's fire cannot reach.

## How you know it worked

- `gitlive backup verify myapp` prints `VERIFIED — N/N files restore
  byte-identical` — that is a backup PROVEN to restore, not assumed.
- `gitlive backup check` prints `integrity OK`.
- Delete a file from the app's data, restore, and it's back in the target
  directory — while the live app was never touched.
- The dashboard shows the backup event.

## Honest limits

- v1 backs up each app's data dir + deploy history. Whole-machine
  snapshots and the registry itself come later.
- restic is an external binary (like openssl): `brew install restic` /
  `apt install restic`.

## The philosophy in one line

Platforms sell you their backups as a reason to stay. A backup you can
verify, restore, and move is a reason you can leave.
