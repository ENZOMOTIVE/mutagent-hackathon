# Security-Readiness Checklist — `mutagent-io/mutagent-hackathon`

Run through this **before flipping the repo from `internal` → `public`**. Goal: **anyone can open a
PR, only maintainers can merge to `main`**, and a hostile PR can't exfiltrate secrets or push to `main`.

Legend: ☐ = to do · 🔒 = needs **admin** on the repo · 👤 = org-owner / maintainer action.

---

## A. Protect `main` — the "PR-yes, merge-no" core 🔒
The single most important section. With this on, public contributors can fork + PR but cannot merge.

- ☐ Require a **pull request before merging** to `main`
- ☐ Require **≥1 approving review**; **dismiss stale approvals** on new commits
- ☐ Require review from **CODEOWNERS** (maintainers auto-requested)
- ☐ Require **status checks to pass** before merge; require branches **up to date**
- ☐ Require **conversation resolution** before merge
- ☐ **Block force-pushes**; **block deletions** of `main`
- ☐ **Restrict who can push** to `main` → maintainers team only
- ☐ **Include administrators** in the rules (no silent bypass)

One-shot via API (run as a repo admin):
```bash
gh api -X PUT repos/mutagent-io/mutagent-hackathon/branches/main/protection \
  -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "required_conversation_resolution": true,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```
(Set `restrictions` to a teams/users object to hard-limit who can push; set `required_status_checks.contexts` once CI exists.)

---

## B. Repo settings 🔒👤
- ☐ **Forking enabled** (public contributors fork → PR)
- ☐ Default collaborator access = **Read** (write/merge only for the maintainers team)
- ☐ Merge button: **squash only** (clean history) — optional but recommended; enable **auto-delete head branches**
- ☐ Disable **Wiki / Projects** if unused (smaller surface)
- ☐ Issues: keep **on** (challenge questions) or template them

---

## C. GitHub Actions / CI — the biggest fork-PR risk 🔒
A misconfigured workflow is how a fork PR steals secrets or writes to `main`.

- ☐ Untrusted fork code runs under **`pull_request`**, never **`pull_request_target`** (the latter runs with repo secrets + a write token against *attacker-controlled* code)
- ☐ Settings → Actions → **"Require approval for all outside collaborators / first-time contributors"** before workflows run
- ☐ Fork-PR `GITHUB_TOKEN` is **read-only**; **no repo/org secrets** exposed to fork workflows (gate secret-using jobs on non-fork / labeled / post-merge)
- ☐ **Pin actions to commit SHAs**; restrict to allowed/verified actions
- ☐ No self-hosted runners on public fork PRs

---

## D. Secrets & data hygiene 👤
- ☐ **No secrets in `main` history** — scan before going public:
  `gitleaks detect --source . --redact`  ·  or  `trufflehog git file://. --only-verified`
- ☐ Confirm `main` tracks only the intended public files (currently: README · QUICKSTART · SECURITY-READINESS · logos · quickstart.html/pdf · .gitignore)
- ☐ `.gitignore` covers `.env*`, `.mutagentrc*`, `.claude/`, `node_modules`, `traces/` ✅ (already in place)
- ☐ **Rotate the hackathon `GEMINI_API_KEY`** (it was shared in plaintext during setup; not in the repo, but rotate it)
- ☐ No org/repo Actions secrets that a fork PR could reach (see C)

---

## E. Governance files 👤
- ☐ **CODEOWNERS** (`.github/CODEOWNERS`) → `* @mutagent-io/maintainers` so PRs auto-request maintainer review
- ☐ **SECURITY.md** — how to report a vulnerability (private channel)
- ☐ **CODE_OF_CONDUCT.md**
- ☐ **PR template** (`.github/pull_request_template.md`) — submission checklist (folder scope, eval results attached, no secrets)
- ☐ **CONTRIBUTING** — the fork→PR flow (summarized in the README; expand if needed)
- ☐ **LICENSE / submission terms** — README is "Proprietary"; decide the **public submission license / IP & CLA** terms before accepting outside PRs

---

## F. Access audit — right before flipping to public 🔒👤
- ☐ Collaborator/team list reviewed: **only maintainers have write/admin**; everyone else read
- ☐ Branch-protection (A) **verified live**: try a direct push to `main` as a non-maintainer → must be rejected
- ☐ `submissions/` is **not** CODEOWNERS-owned in a way that grants outsiders write
- ☐ Flip visibility **internal → public** only after A–E pass

---

## Quick verify (after A is applied)
```bash
gh api repos/mutagent-io/mutagent-hackathon/branches/main/protection \
  --jq '{pr_required: (.required_pull_request_reviews!=null), reviews: .required_pull_request_reviews.required_approving_review_count, force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled, admins: .enforce_admins.enabled}'
# want: pr_required:true · reviews:>=1 · force_push:false · deletions:false · admins:true
```
